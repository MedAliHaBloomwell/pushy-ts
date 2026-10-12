# pushy-ts

An HTTP/2 client for the Apple Push Notification service (APNs), written in TypeScript for **Bun** and **Node.js**.
It is a port of [Pushy](https://github.com/jchambers/pushy), the well-established Java APNs library, and keeps its
design: long-lived, multiplexed HTTP/2 connections, a bounded connection pool with backoff, token- and
certificate-based authentication, a payload builder, and a mock APNs server for tests.

- Zero runtime dependencies: only `node:http2`, `node:tls` and `node:crypto`
- Works in any Node.js ≥ 18 project (ESM or CommonJS, with types for both) and in Bun ≥ 1.2
- Token (`.p8`) and TLS certificate (`.p12` / PEM) authentication
- HTTP CONNECT proxy support, plus a socket factory hook for SOCKS
- A mock APNs server that validates notifications the way Apple does

See [docs/PUSHY_ANALYSIS.md](docs/PUSHY_ANALYSIS.md) for how Pushy works and how this port maps onto it.

## Install

```sh
bun add github:MedAliHaBloomwell/pushy-ts
# or
npm install github:MedAliHaBloomwell/pushy-ts
```

Bun loads the TypeScript sources directly, so there is no build step. npm builds `dist/` during install through the
`prepare` script.

## Quick start

```ts
import { ApnsClient, ApnsPayloadBuilder, ApnsSigningKey, DEVELOPMENT_APNS_HOST, PushType } from "pushy-ts";

const client = new ApnsClient({
  host: DEVELOPMENT_APNS_HOST, // PRODUCTION_APNS_HOST in production
  signingKey: await ApnsSigningKey.loadFromPkcs8File("AuthKey_ABC123DEFG.p8", "TEAMID1234", "ABC123DEFG"),
});

const response = await client.sendNotification({
  token: deviceToken,
  topic: "com.example.app",
  pushType: PushType.ALERT,
  payload: new ApnsPayloadBuilder().setAlertTitle("Hello").setAlertBody("From pushy-ts").setSound("default").build(),
});

if (response.accepted) {
  console.log("Accepted", response.apnsId);
} else {
  console.log("Rejected", response.rejectionReason);
  if (response.tokenInvalidationTimestamp) {
    // The device token is no longer valid; stop sending to it.
  }
}

// On shutdown:
await client.close();
```

CommonJS works the same way: `const { ApnsClient } = require("pushy-ts");`.

Create one client per set of credentials when your app starts and share it. Each client keeps its connections open
and sends many notifications over each connection at once.

### Accepted, rejected, or failed

`sendNotification` distinguishes three outcomes, as Pushy does:

| Outcome | What you get | What to do |
| --- | --- | --- |
| Accepted | Resolves with `accepted: true` | Nothing; APNs will try to deliver it. |
| Rejected | Resolves with `accepted: false` and a `rejectionReason` | Don't resend unchanged. On `Unregistered`/`BadDeviceToken`, drop the token. |
| Failed | Rejects with an error (e.g. connection failure) | Temporary; it is safe to try again later. |

## Authentication

**Token-based (recommended).** Load the `.p8` key from Apple's developer portal. Tokens are created, cached and
refreshed automatically (every 50 minutes by default).

```ts
const signingKey = await ApnsSigningKey.loadFromPkcs8File("AuthKey_ABC123DEFG.p8", teamId, keyId);
// Keys kept in environment variables work too: PEM, PEM with escaped "\n", or the bare base64 body.
const fromEnv = ApnsSigningKey.loadFromPkcs8(process.env.APNS_KEY!, teamId, keyId);
```

**Certificate-based.** Pass a PKCS#12 bundle or a PEM certificate and key:

```ts
new ApnsClient({ host, clientCredentials: { pfx: readFileSync("push-cert.p12"), passphrase: "secret" } });
new ApnsClient({ host, clientCredentials: { cert: certPem, key: keyPem } });
```

## Client options

| Option | Default | Description |
| --- | --- | --- |
| `host` | required | `PRODUCTION_APNS_HOST` or `DEVELOPMENT_APNS_HOST` |
| `port` | `443` | `ALTERNATE_APNS_PORT` (2197) is also supported by Apple |
| `signingKey` / `clientCredentials` | one required | Token or TLS authentication, never both |
| `tokenExpirationMs` | 50 min | Lifetime of authentication tokens |
| `concurrentConnections` | `1` | Maximum number of connections to keep open |
| `connectionTimeoutMs` | none | Give up on connection attempts after this long |
| `closeAfterIdleMs` | 60 000 | Close idle connections (they reopen on demand); `0` disables |
| `gracefulShutdownTimeoutMs` | none | How long `close()` waits for in-flight notifications |
| `trustedServerCertificates` | system roots | PEM certificates to trust, for pinning or mock servers |
| `hostnameVerification` | `true` | Leave on outside of tests |
| `proxy` | none | `{ host, port, username?, password? }` HTTP CONNECT proxy |
| `socketFactory` | none | `(host, port) => Promise<Duplex>` for custom transports such as SOCKS |
| `metricsListener` | none | Hooks for sent/acknowledged/failed notifications and connection lifecycle |
| `logger` | silent | Any `{ debug, info, warn, error }` logger, e.g. `console` or pino |

Prefer Pushy's builder style? `ApnsClientBuilder` keeps Pushy's method names:

```ts
const client = new ApnsClientBuilder()
  .setApnsServer(PRODUCTION_APNS_HOST)
  .setSigningKey(signingKey)
  .setConcurrentConnections(4)
  .build();
```

## Notifications

Any object with `token`, `topic` and `payload` can be sent. Optional fields map to APNs headers:

| Field | Header | Notes |
| --- | --- | --- |
| `expiration` | `apns-expiration` | A `Date`, or `0` to deliver once without storing; omitted means APNs's default |
| `priority` | `apns-priority` | `DeliveryPriority.IMMEDIATE` (10), `CONSERVE_POWER` (5), `DO_NOT_AWAKEN` (1) |
| `pushType` | `apns-push-type` | `PushType.ALERT`, `BACKGROUND`, `VOIP`, `LIVE_ACTIVITY`, … |
| `collapseId` | `apns-collapse-id` | At most 64 bytes |
| `apnsId` | `apns-id` | A canonical UUID |

`SimpleApnsPushNotification` gives Pushy's defaults: it expires after one day and uses immediate priority.

## Payloads

```ts
const payload = new ApnsPayloadBuilder()
  .setAlertTitle("Order shipped")
  .setAlertBody("Your order #1234 is on its way")
  .setBadgeNumber(1)
  .setSound("default")
  .setThreadId("orders")
  .setInterruptionLevel(InterruptionLevel.TIME_SENSITIVE)
  .addCustomProperty("orderId", 1234)
  .build();

// Live Activities
new ApnsPayloadBuilder()
  .setEvent(LiveActivityEvent.UPDATE)
  .setTimestamp(new Date())
  .setContentState({ score: "2-1" })
  .build();
```

## Testing with the mock server

`MockApnsServer` speaks the APNs protocol and, with `ValidatingPushNotificationHandlerFactory`, rejects notifications
the way Apple would (bad tokens, wrong topics, invalid or expired provider tokens, oversized payloads, and so on).

```ts
import { ApnsVerificationKey, MockApnsServer, ValidatingPushNotificationHandlerFactory } from "pushy-ts";

const server = new MockApnsServer({
  serverCredentials: { cert: serverCertPem, key: serverKeyPem },
  handlerFactory: new ValidatingPushNotificationHandlerFactory({
    deviceTokensByTopic: { "com.example.app": [deviceToken] },
    verificationKeys: [{ key: ApnsVerificationKey.fromSigningKey(signingKey), topics: ["com.example.app"] }],
  }),
});
const port = await server.start();

const client = new ApnsClient({ host: "localhost", port, signingKey, trustedServerCertificates: caPem });
```

Test certificates for local use can be generated with `bun run gen:test-certs`.

## Development

```sh
bun install
bun test             # unit and integration tests against the mock server (Bun)
bun run test:node    # builds dist/ and runs end-to-end tests under Node.js (ESM and CommonJS)
bun run typecheck
bun run check        # all of the above
```

## License

MIT. Pushy is © Jon Chambers, also under the MIT license; see [LICENSE](LICENSE).
