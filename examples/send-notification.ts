/**
 * Sends one notification with token-based authentication.
 *
 *   APNS_KEY_PATH=./AuthKey_ABC123DEFG.p8 APNS_KEY_ID=ABC123DEFG APNS_TEAM_ID=TEAMID1234 \
 *   APNS_TOPIC=com.example.app DEVICE_TOKEN=<hex token> bun examples/send-notification.ts
 *
 * Set APNS_PRODUCTION=1 to use the production gateway instead of the sandbox. This runs from a clone with Bun; in
 * your own (Bun or Node) project, import from "pushy-ts" instead of "../src/index.ts".
 */
import {
  ApnsClient,
  ApnsPayloadBuilder,
  ApnsSigningKey,
  DEVELOPMENT_APNS_HOST,
  PRODUCTION_APNS_HOST,
  PushType,
  sanitizeTokenString,
} from "../src/index.ts";

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
};

const client = new ApnsClient({
  host: process.env["APNS_PRODUCTION"] ? PRODUCTION_APNS_HOST : DEVELOPMENT_APNS_HOST,
  signingKey: await ApnsSigningKey.loadFromPkcs8File(env("APNS_KEY_PATH"), env("APNS_TEAM_ID"), env("APNS_KEY_ID")),
  connectionTimeoutMs: 10_000,
  logger: console,
});

try {
  const response = await client.sendNotification({
    token: sanitizeTokenString(env("DEVICE_TOKEN")),
    topic: env("APNS_TOPIC"),
    pushType: PushType.ALERT,
    payload: new ApnsPayloadBuilder().setAlertTitle("pushy-ts").setAlertBody("Hello from Bun/Node!").setSound("default").build(),
  });

  if (response.accepted) {
    console.log(`Accepted (apns-id ${response.apnsId})`);
  } else {
    console.log(`Rejected: ${response.rejectionReason}`);
    if (response.tokenInvalidationTimestamp) {
      console.log(`Token invalid since ${response.tokenInvalidationTimestamp.toISOString()}`);
    }
  }
} finally {
  await client.close();
}
