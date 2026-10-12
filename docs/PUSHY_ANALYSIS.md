# Pushy analysis and porting notes

This document summarizes how [Pushy](https://github.com/jchambers/pushy) (Java, Netty-based) talks to the Apple Push
Notification service, and how each part maps onto `pushy-ts`. It was written against Pushy's `main` branch as of
commit `d461f9b` (August 2026). Pushy's main module is about 10,500 lines of Java across 64 files.

## What Pushy does

Pushy is a provider-side APNs client. It holds long-lived HTTP/2 connections to Apple's gateway and multiplexes many
notifications over each one, which is what Apple asks providers to do. The pieces:

| Area | Pushy classes | Role |
| --- | --- | --- |
| Public API | `ApnsClient`, `ApnsClientBuilder` | Configure and build a client; `sendNotification` returns a future; `close` shuts down gracefully. |
| Notifications | `ApnsPushNotification`, `SimpleApnsPushNotification`, `PushType`, `DeliveryPriority` | The token, topic, JSON payload and optional APNs headers of a notification. |
| Responses | `PushNotificationResponse`, `ErrorResponse`, `PushNotificationFuture` | Accepted/rejected, status code, `apns-id`, `apns-unique-id`, rejection reason and token invalidation timestamp. |
| HTTP/2 | `ApnsClientHandler`, `TokenAuthenticationApnsClientHandler` | Netty `Http2ConnectionHandler`: one stream per notification, response parsing, GOAWAY and REFUSED_STREAM handling. |
| Connections | `ApnsChannelFactory`, `ApnsChannelPool` | TLS setup, connection creation with exponential backoff, a bounded pool. |
| Auth | `ApnsSigningKey`, `ApnsVerificationKey`, `AuthenticationToken`, `P12Util` | ES256 JWT provider tokens, or TLS client certificates from PKCS#12. |
| Payloads | `ApnsPayloadBuilder`, `InterruptionLevel`, `LiveActivityEvent` | Builds the `aps` dictionary, including Live Activity fields. |
| Proxies | `HttpProxyHandlerFactory`, `Socks4/5ProxyHandlerFactory` | Netty proxy handlers placed in front of TLS. |
| Testing | `MockApnsServer`, `ValidatingPushNotificationHandler*`, `BenchmarkApnsServer` | An HTTP/2 server that validates notifications like APNs does. |
| Metrics | `ApnsClientMetricsListener` (+ Dropwizard/Micrometer modules) | Hooks for sent, acknowledged, failed notifications and connection lifecycle. |

### The send path

1. `ApnsClient.sendNotification` creates a `PushNotificationFuture`, acquires a channel from the pool, writes the
   future to the channel and releases the channel straight away (channels are multiplexed, so "acquire" really means
   "pick a connection").
2. `ApnsClientHandler.write` allocates the next stream ID and writes a HEADERS frame then a DATA frame:
   - `:method POST`, `:path /3/device/<token>`, `:scheme https`, `:authority <host>`
   - `apns-expiration` (always sent; `0` when the notification has no expiration), and when set `apns-collapse-id`,
     `apns-priority`, `apns-push-type`, `apns-topic`, `apns-id`
   - `authorization: bearer <jwt>` for token-based authentication
3. On the response, status 200 completes the future as accepted. Anything else parses the JSON body
   `{"reason": "...", "timestamp": <epoch ms>}` and completes the future as rejected.
4. Futures fail exceptionally (as opposed to "rejected") when the write fails or the stream closes before a reply.
   Pushy's contract: rejections are permanent; exceptional failures are temporary and may be retried by the caller.

### Connection behavior

- **Readiness:** a channel counts as ready once the server's first SETTINGS frame arrives.
- **Backoff:** failed connection attempts delay the next one by 1 s, doubling up to 60 s; a success resets the delay.
- **Pool:** while below capacity every acquisition opens a new connection; at capacity, idle channels are reused and
  further acquisitions queue.
- **Idle timeout:** connections idle for 1 minute (configurable) are closed and reopened on demand.
- **GOAWAY:** the channel is closed; in-flight streams fail and callers may retry.
- **REFUSED_STREAM:** the notification is re-sent, since the server guarantees it was not processed.
- **Flow control:** the encoder enforces the server's `MAX_CONCURRENT_STREAMS`, buffering streams beyond it.

### Token-based authentication

- Tokens are ES256 JWTs: header `{alg: ES256, typ: JWT, kid}`, claims `{iss: teamId, iat: seconds}`.
- Pushy signs with Java's `SHA256withECDSA`, which produces **DER-encoded** signatures. That is not what JWS specifies
  (raw `r || s`), but APNs accepts it.
- Each channel creates its own token and drops it after 50 minutes (APNs expires tokens after 60, and rejects refreshes
  more often than every 20).
- An `ExpiredProviderToken` rejection "wedges" the connection, so Pushy closes it and a fresh one gets a new token.

## How pushy-ts maps it

| Pushy | pushy-ts | Notes |
| --- | --- | --- |
| Netty + `Http2ConnectionHandler` | `node:http2` (`ClientHttp2Session`) | Works unchanged on Node.js and Bun. nghttp2 enforces `MAX_CONCURRENT_STREAMS`. |
| `ApnsChannelFactory` | `ApnsConnection.connect` | Owns its `tls.connect` socket so a connection timeout really closes the socket. |
| `ApnsChannelPool` | `ApnsConnectionPool` | Same fill-to-capacity strategy and 1 s → 60 s backoff; picks the least busy connection. |
| `ApnsClientHandler` | `ApnsConnection.send` | Same headers and response handling; REFUSED_STREAM is retried (up to 3 times). |
| `TokenAuthenticationApnsClientHandler` | `AuthenticationTokenProvider` | One token shared by the client's connections rather than one per connection. |
| `CompletableFuture` | `Promise` | Resolves with the response (accepted or rejected); rejects on send failures. |
| `ApnsClientBuilder` | `ApnsClientBuilder` and `ApnsClientOptions` | The builder keeps Pushy's method names; durations are milliseconds. |
| `P12Util` | Node's `pfx` TLS option | PKCS#12 is supported natively. |
| `SslContext`, OpenSSL/JDK providers | `node:tls` | Uses the runtime's root store unless `trustedServerCertificates` is set. |
| HTTP/SOCKS proxy handlers | `proxy` option, `socketFactory` | HTTP CONNECT is built in; SOCKS plugs in through `socketFactory`. |
| SLF4J | `logger` option | Any object with `debug/info/warn/error`, e.g. `console` or pino. |
| Enums | `as const` objects plus union types | `PushType.ALERT` and `"alert"` are both accepted. |
| `MockApnsServer` | `MockApnsServer` | Same validation rules, TLS and token authentication, listener hooks. |

### Deliberate differences

- **Signatures:** pushy-ts signs tokens with standard JWS (P1363) signatures, and accepts both P1363 and DER when
  verifying, so the mock server also validates tokens produced by Pushy.
- **Shared token:** one token per client keeps several connections from tripping `TooManyProviderTokenUpdates`.
- **Expiration:** when a notification has no `expiration`, pushy-ts sends no `apns-expiration` header and lets APNs
  apply its default storage policy. Pushy sends `0` ("deliver once, never store"). Pass `expiration: 0` to get Pushy's
  behavior. `SimpleApnsPushNotification` still defaults to one day, as in Pushy.
- **Retries:** besides REFUSED_STREAM, a notification that hit a connection which had started closing (GOAWAY, idle
  timeout) before anything was written is retried on another connection.
- **Not ported:** the frame logger (use `NODE_DEBUG=http2` on Node), the Netty event-loop resources, the round-robin
  DNS resolver, the benchmark server, and the Dropwizard/Micrometer modules (the metrics listener interface is
  ported, so adapters are a few lines).

## Live Activities (beyond Pushy)

Pushy sends Live Activity notifications like any other (`liveactivity` push type, Live Activity keys in
`ApnsPayloadBuilder`). pushy-ts adds the rest of Apple's spec, since Live Activities are its main use:

- **`LiveActivityPushNotification`** sets `apns-push-type: liveactivity` and the `<bundle ID>.push-type.liveactivity`
  topic, and only accepts priorities 5 and 10.
- **`LiveActivityPayloadBuilder`** validates payloads against Apple's rules: `event` and `timestamp` always present;
  starts need `attributes-type`, `attributes`, `content-state` and an alert; updates need `content-state`;
  `dismissal-date` only on `end`; `input-push-token` / `input-push-channel` (iOS 18) only on `start`, and not both.
  Alert `title`/`body` can be strings or `{"loc-key", "loc-args"}` objects.
- **Broadcast push (iOS 18):** `ApnsClient.sendBroadcastNotification` posts to `/4/broadcasts/apps/<bundle ID>` with
  `apns-channel-id`, `apns-expiration` (default 0) and `apns-priority`, and returns `apns-request-id` and
  `apns-unique-id`. Payloads may be up to 5 KB.
- **Channel management:** `ApnsChannelManagementClient` creates, reads, deletes and lists channels on
  `api-manage-broadcast(.sandbox).push.apple.com` (ports 2196 / 2195). It shares the HTTP/2 pool, retry logic and
  token authentication with `ApnsClient` through `ApnsHttp2Client`.
- **Mock server:** validates broadcasts against registered channels (`broadcastChannels`), applies the 5 KB limit to
  broadcasts and VoIP notifications, and accepts tokens for a bundle ID's suffixed topics.

Sources: [ActivityKit push notifications](https://developer.apple.com/documentation/activitykit/starting-and-updating-live-activities-with-activitykit-push-notifications),
[broadcast push notifications](https://developer.apple.com/documentation/usernotifications/sending-broadcast-push-notification-requests-to-apns),
[channel management](https://developer.apple.com/documentation/usernotifications/sending-channel-management-requests-to-apns),
[sending notification requests](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns).

Apple's broadcast page lists `api.push.apple.com` / `api.sandbox.push.apple.com:443` as the broadcast hosts in its
connection section, which pushy-ts follows; the host stays configurable if Apple changes it.

## Upstream open issues

Open issues on Pushy (checked 2026-10-12) and what they mean for pushy-ts:

| Issue | Verdict | pushy-ts |
| --- | --- | --- |
| [#1112](https://github.com/jchambers/pushy/issues/1112) `title`/`body` objects in `aps.alert` | Valid | Fixed. Both payload builders write localized Live Activity alerts as `{"loc-key", "loc-args"}` objects. |
| [#1081](https://github.com/jchambers/pushy/issues/1081) Broadcast push notifications | Valid | Implemented: `sendBroadcastNotification`, `ApnsChannelManagementClient`, `input-push-channel`, mock server validation. |
| [#951](https://github.com/jchambers/pushy/issues/951) No way to customize the SSL context since 0.15.1 | Valid | `tlsOptions`: extra `tls.connect` options, static or computed per connection (e.g. rotated certificates). Certificate verification can't be turned off. |
| [#1121](https://github.com/jchambers/pushy/issues/1121) Can't customize Netty's DNS resolver | Netty-specific | Not affected (no Netty). Custom DNS works through `tlsOptions.lookup` or `socketFactory`. |
| [#1120](https://github.com/jchambers/pushy/issues/1120) Updating to Netty 4.2 | Java only | Not applicable. |
| [#498](https://github.com/jchambers/pushy/issues/498) Publish a shaded JAR | Java only | Not applicable; pushy-ts has no runtime dependencies. |

## Runtime notes

- **Bun's HTTP/2 client** behaves like Node's for everything pushy-ts needs, including mutual TLS, PKCS#12, ALPN,
  `MAX_CONCURRENT_STREAMS` and RST_STREAM codes.
- **Bun's HTTP/2 server** (as of Bun 1.4.2) does not send the error code passed to `stream.close(code)`; it ends the
  stream normally. This only matters for tests that simulate REFUSED_STREAM, so that test runs its server under Node.
- **Destroying an `http2` session mid-handshake** leaves the TCP socket open on both Node 22 and Bun 1.4. pushy-ts
  creates the TLS socket itself and destroys it on timeout.
