/**
 * Updates (or ends) a Live Activity, or broadcasts an update to a channel, with token-based authentication.
 *
 *   APNS_KEY_PATH=./AuthKey_ABC123DEFG.p8 APNS_KEY_ID=ABC123DEFG APNS_TEAM_ID=TEAMID1234 \
 *   APNS_BUNDLE_ID=com.example.app ACTIVITY_TOKEN=<hex token> bun examples/live-activity.ts
 *
 * Set CHANNEL_ID=<base64 channel ID> instead of ACTIVITY_TOKEN to broadcast to a channel (iOS 18+), END=1 to end the
 * Live Activity, and APNS_PRODUCTION=1 to use the production gateway. The content state must match your app's
 * ActivityAttributes.ContentState; this one is an example.
 */
import {
  ApnsClient,
  ApnsSigningKey,
  DEVELOPMENT_APNS_HOST,
  LiveActivityEvent,
  LiveActivityPayloadBuilder,
  LiveActivityPushNotification,
  PRODUCTION_APNS_HOST,
  sanitizeTokenString,
} from "../src/index.ts";

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
};

const bundleId = env("APNS_BUNDLE_ID");
const ending = Boolean(process.env["END"]);

const payload = new LiveActivityPayloadBuilder()
  .setEvent(ending ? LiveActivityEvent.END : LiveActivityEvent.UPDATE)
  .setContentState({ status: ending ? "Delivered" : "On its way", progress: ending ? 1 : 0.5 })
  .setStaleDate(ending ? null : new Date(Date.now() + 15 * 60_000))
  .setDismissalDate(ending ? new Date(Date.now() + 60 * 60_000) : null)
  .setAlert({ title: "pushy-ts", body: ending ? "Delivered" : "On its way", sound: "default" })
  .build();

const client = new ApnsClient({
  host: process.env["APNS_PRODUCTION"] ? PRODUCTION_APNS_HOST : DEVELOPMENT_APNS_HOST,
  signingKey: await ApnsSigningKey.loadFromPkcs8File(env("APNS_KEY_PATH"), env("APNS_TEAM_ID"), env("APNS_KEY_ID")),
  connectionTimeoutMs: 10_000,
  logger: console,
});

try {
  const channelId = process.env["CHANNEL_ID"];
  const response = channelId
    ? await client.sendBroadcastNotification({ bundleId, channelId, payload })
    : await client.sendNotification(
        new LiveActivityPushNotification(sanitizeTokenString(env("ACTIVITY_TOKEN")), bundleId, payload),
      );

  console.log(response.accepted ? "Accepted" : `Rejected: ${response.rejectionReason}`);
} finally {
  await client.close();
}
