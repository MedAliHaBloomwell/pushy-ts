import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ApnsClient,
  ApnsSigningKey,
  ApnsVerificationKey,
  MockApnsServer,
  ValidatingPushNotificationHandlerFactory,
  type ApnsClientOptions,
  type MockApnsServerOptions,
} from "../src";

const fixtures = join(import.meta.dir, "fixtures");
export const fixture = (name: string) => readFileSync(join(fixtures, name));
export const fixturePath = (name: string) => join(fixtures, name);

export const TOPIC = "com.example.pushy";
export const TEAM_ID = "TEAMID1234";
export const KEY_ID = "KEYID56789";

export const randomDeviceToken = () => randomBytes(32).toString("hex");

export const DEVICE_TOKEN = randomDeviceToken();

export const signingKey = ApnsSigningKey.loadFromPkcs8(fixture("token-auth-private-key.p8"), TEAM_ID, KEY_ID);
export const verificationKey = ApnsVerificationKey.load(fixture("token-auth-public-key.pem"), TEAM_ID, KEY_ID);

export const PAYLOAD = JSON.stringify({ aps: { alert: "Hello" } });

export function validatingHandlerFactory(
  options: { deviceTokens?: string[]; expiredTokens?: Record<string, Date> } = {},
) {
  return new ValidatingPushNotificationHandlerFactory({
    deviceTokensByTopic: { [TOPIC]: [DEVICE_TOKEN, ...(options.deviceTokens ?? [])] },
    expirationTimestampsByDeviceToken: options.expiredTokens ?? {},
    verificationKeys: [{ key: verificationKey, topics: [TOPIC] }],
  });
}

export async function startServer(options: Partial<MockApnsServerOptions> = {}) {
  const server = new MockApnsServer({
    serverCredentials: { cert: fixture("server.pem"), key: fixture("server.key") },
    trustedClientCertificates: fixture("ca.pem"),
    handlerFactory: validatingHandlerFactory(),
    ...options,
  });
  const port = await server.start(0, "127.0.0.1");
  return { server, port };
}

export function tokenClient(port: number, options: Partial<ApnsClientOptions> = {}) {
  return new ApnsClient({
    host: "localhost",
    port,
    signingKey,
    trustedServerCertificates: fixture("ca.pem"),
    ...options,
  });
}

export function tlsClient(port: number, options: Partial<ApnsClientOptions> = {}) {
  return new ApnsClient({
    host: "localhost",
    port,
    clientCredentials: { cert: fixture("client.pem"), key: fixture("client.key") },
    trustedServerCertificates: fixture("ca.pem"),
    ...options,
  });
}

export const notification = (overrides: Record<string, unknown> = {}) => ({
  token: DEVICE_TOKEN,
  topic: TOPIC,
  payload: PAYLOAD,
  ...overrides,
});
