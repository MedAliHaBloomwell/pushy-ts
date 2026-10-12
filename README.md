# pushy-ts

An HTTP/2 client for the Apple Push Notification service (APNs), written in TypeScript for **Bun** and **Node.js**,
with first-class support for **Live Activities**. It is a port of [Pushy](https://github.com/jchambers/pushy), the
well-established Java APNs library, and keeps its design: long-lived, multiplexed HTTP/2 connections, a bounded
connection pool with backoff, token- and certificate-based authentication, a payload builder, and a mock APNs server
for tests.

- Live Activities end to end: start, update and end payloads validated against Apple's rules, push-to-start, broadcast
  push to channels (iOS 18+) and channel management
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

## Live Activities

Live Activities are updated with ActivityKit push notifications. pushy-ts follows Apple's spec in
[Starting and updating Live Activities with ActivityKit push notifications](https://developer.apple.com/documentation/activitykit/starting-and-updating-live-activities-with-activitykit-push-notifications).

### Update or end a Live Activity

Send to the Live Activity's push token (from `activity.pushTokenUpdates` in your app). `LiveActivityPushNotification`
sets the headers Apple requires (`apns-push-type: liveactivity`, `apns-topic: <bundle ID>.push-type.liveactivity`) and
only accepts priorities 5 and 10.

```ts
import { LiveActivityEvent, LiveActivityPayloadBuilder, LiveActivityPushNotification, DeliveryPriority } from "pushy-ts";

const payload = new LiveActivityPayloadBuilder()
  .setEvent(LiveActivityEvent.UPDATE)
  .setContentState({ homeScore: 2, awayScore: 1, minute: 67 }) // must match your ActivityAttributes.ContentState
  .setStaleDate(new Date(Date.now() + 15 * 60_000))
  .setRelevanceScore(100)
  .setAlert({ title: { locKey: "GOAL_%@", locArgs: ["Home"] }, body: "2 – 1", sound: "goal.caf" })
  .build();

await client.sendNotification(
  new LiveActivityPushNotification(activityPushToken, "com.example.app", payload, {
    priority: DeliveryPriority.CONSERVE_POWER, // 5 doesn't count toward the hourly budget; use 10 for urgent updates
  }),
);

// Ending: final content state, and when to remove it from the Lock Screen (a past date removes it immediately)
new LiveActivityPayloadBuilder()
  .setEvent(LiveActivityEvent.END)
  .setContentState({ homeScore: 3, awayScore: 1, minute: 90 })
  .setDismissalDate(new Date(Date.now() + 60 * 60_000))
  .build();
```

`timestamp` defaults to the time of `build()`; the system ignores updates older than the one it shows, so it must
increase with every push. `build()` throws when a payload breaks Apple's rules: a missing event, an update without
`content-state`, a start without attributes or alert, start-only keys on updates, `dismissal-date` outside `end`.

### Start a Live Activity remotely (push-to-start)

Send to the push-to-start token (from `Activity<…>.pushToStartTokenUpdates`). Starts need `attributes-type`,
`attributes`, a `content-state` and an alert. On iOS 18+, ask for an update token or subscribe the activity to a
broadcast channel in the same payload:

```ts
const start = new LiveActivityPayloadBuilder()
  .setEvent(LiveActivityEvent.START)
  .setAttributesType("MatchAttributes")
  .setAttributes({ homeTeam: "Home", awayTeam: "Away" })
  .setContentState({ homeScore: 0, awayScore: 0, minute: 0 })
  .setAlert({ title: "Kick-off", body: "Home vs Away has started", sound: "default" })
  .setInputPushToken(true) // or .setInputPushChannel(channelId)
  .build();

await client.sendNotification(new LiveActivityPushNotification(pushToStartToken, "com.example.app", start));
```

### Broadcast to many devices with channels (iOS 18+)

For events followed by many people, create a channel per event, give its ID to your app (which subscribes with
`pushType: .channel(channelId)`, or via `setInputPushChannel` on push-to-start), and broadcast one update to everyone.
Broadcasts can update and end Live Activities, not start them. Your app needs the broadcast capability, enabled on
developer.apple.com.

```ts
import {
  ApnsChannelManagementClient,
  DEVELOPMENT_CHANNEL_MANAGEMENT_HOST, // PRODUCTION_CHANNEL_MANAGEMENT_HOST in production
  MessageStoragePolicy,
} from "pushy-ts";

// Channel management uses its own APNs host (port 2195 in development, 2196 in production, picked automatically)
const channels = new ApnsChannelManagementClient({ host: DEVELOPMENT_CHANNEL_MANAGEMENT_HOST, signingKey });

const { channelId } = await channels.createChannel("com.example.app", {
  messageStoragePolicy: MessageStoragePolicy.NO_MESSAGE_STORED, // higher budget; use MOST_RECENT_MESSAGE_STORED for rare updates
});

// Broadcasts go through the regular ApnsClient
const response = await client.sendBroadcastNotification({
  bundleId: "com.example.app", // no push type suffix
  channelId,
  payload, // an update or end payload, at most 5 KB
});
console.log(response.accepted, response.apnsUniqueId);

await channels.listChannels("com.example.app"); // { channels: [...] }
await channels.readChannel("com.example.app", channelId); // { messageStoragePolicy, pushType }
await channels.deleteChannel("com.example.app", channelId); // when the event is over (limit: 10,000 channels)
```

Broadcasts default to `apns-expiration: 0` and priority 10. Channels created with `NO_MESSAGE_STORED` only accept an
expiration of 0. Channel management methods reject with `ChannelManagementError` (with `statusCode`, `reason` and
`apnsRequestId`) when APNs refuses a request.

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
| `tlsOptions` | none | Extra `tls.connect` options (`ciphers`, `minVersion`, `secureContext`, `lookup` for custom DNS…), or a function returning them for each new connection, e.g. to rotate certificates. Verification can't be disabled |
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
| `pushType` | `apns-push-type` | `PushType.ALERT`, `BACKGROUND`, `VOIP`, `LIVE_ACTIVITY`, `WIDGETS`, `CONTROLS`, … |
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
```

`ApnsPayloadBuilder` also writes Live Activity keys, as Pushy's does; `LiveActivityPayloadBuilder` (above) is the
stricter choice for Live Activities.

## Testing with the mock server

`MockApnsServer` speaks the APNs protocol and, with `ValidatingPushNotificationHandlerFactory`, rejects notifications
the way Apple would (bad tokens, wrong topics, invalid or expired provider tokens, oversized payloads, and so on). It
also validates broadcasts against the channels you register with `broadcastChannels` (unknown channels, topic
mismatches, nonzero expirations on no-storage channels, payloads over 5 KB).

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
