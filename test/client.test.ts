import { afterEach, describe, expect, test } from "bun:test";
import http2 from "node:http2";
import net from "node:net";
import { join } from "node:path";
import {
  ApnsClient,
  ApnsClientBuilder,
  ClientClosedError,
  ConnectionTimeoutError,
  DeliveryPriority,
  PushType,
  RejectedNotificationError,
  RejectionReason,
  SimpleApnsPushNotification,
  type ApnsClientMetricsListener,
  type MockApnsServer,
  type PushNotificationHandlerFactory,
} from "../src";
import {
  DEVICE_TOKEN,
  fixture,
  fixturePath,
  notification,
  randomDeviceToken,
  startServer,
  tlsClient,
  tokenClient,
  TOPIC,
  validatingHandlerFactory,
} from "./helpers";

const cleanups: Array<() => Promise<unknown> | unknown> = [];
const track = <T extends ApnsClient | MockApnsServer | net.Server>(resource: T): T => {
  if (resource instanceof ApnsClient) cleanups.push(() => resource.close());
  else if ("shutdown" in resource) cleanups.push(() => resource.shutdown());
  else cleanups.push(() => new Promise((resolve) => resource.close(resolve)));
  return resource;
};

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function countingMetrics() {
  const counts = { sent: 0, acknowledged: 0, writeFailures: 0, added: 0, removed: 0, creationFailed: 0 };
  const listener: ApnsClientMetricsListener = {
    handleNotificationSent: () => counts.sent++,
    handleNotificationAcknowledged: () => counts.acknowledged++,
    handleWriteFailure: () => counts.writeFailures++,
    handleConnectionAdded: () => counts.added++,
    handleConnectionRemoved: () => counts.removed++,
    handleConnectionCreationFailed: () => counts.creationFailed++,
  };
  return { counts, listener };
}

describe("token-based authentication", () => {
  test("sends a notification that the server accepts", async () => {
    const { server, port } = await startServer({ generateApnsUniqueId: true });
    track(server);
    const client = track(tokenClient(port));

    const sent = new SimpleApnsPushNotification(DEVICE_TOKEN, TOPIC, '{"aps":{"alert":"hi"}}');
    const response = await client.sendNotification(sent);

    expect(response.accepted).toBe(true);
    expect(response.statusCode).toBe(200);
    expect(response.pushNotification).toBe(sent);
    expect(response.apnsId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.apnsUniqueId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.rejectionReason).toBeNull();
    expect(response.tokenInvalidationTimestamp).toBeNull();
  });

  test("sends every APNs header", async () => {
    const received: http2.IncomingHttpHeaders[] = [];
    const { server, port } = await startServer({
      listener: { handlePushNotificationAccepted: (headers) => received.push(headers) },
    });
    track(server);
    const client = track(tokenClient(port));

    const apnsId = crypto.randomUUID();
    const expiration = new Date(Date.now() + 3_600_000);
    const response = await client.sendNotification(
      notification({
        expiration,
        priority: DeliveryPriority.CONSERVE_POWER,
        pushType: PushType.BACKGROUND,
        collapseId: "collapse",
        apnsId,
      }),
    );

    expect(response.accepted).toBe(true);
    expect(response.apnsId).toBe(apnsId);

    const headers = received[0]!;
    expect(headers[":method"]).toBe("POST");
    expect(headers[":path"]).toBe(`/3/device/${DEVICE_TOKEN}`);
    expect(headers["apns-topic"]).toBe(TOPIC);
    expect(headers["apns-expiration"]).toBe(String(Math.floor(expiration.getTime() / 1000)));
    expect(headers["apns-priority"]).toBe("5");
    expect(headers["apns-push-type"]).toBe("background");
    expect(headers["apns-collapse-id"]).toBe("collapse");
    expect(headers["apns-id"]).toBe(apnsId);
    expect(headers.authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  test("omits optional headers that are not set", async () => {
    const received: http2.IncomingHttpHeaders[] = [];
    const { server, port } = await startServer({
      listener: { handlePushNotificationAccepted: (headers) => received.push(headers) },
    });
    track(server);
    const client = track(tokenClient(port));

    await client.sendNotification(notification());
    await client.sendNotification(notification({ expiration: 0 }));

    expect(received[0]!["apns-expiration"]).toBeUndefined();
    expect(received[0]!["apns-priority"]).toBeUndefined();
    expect(received[0]!["apns-push-type"]).toBeUndefined();
    expect(received[1]!["apns-expiration"]).toBe("0");
  });

  test("reports rejections with their reason", async () => {
    const { server, port } = await startServer();
    track(server);
    const client = track(tokenClient(port));

    const unknownToken = await client.sendNotification(notification({ token: randomDeviceToken() }));
    expect(unknownToken.accepted).toBe(false);
    expect(unknownToken.statusCode).toBe(400);
    expect(unknownToken.rejectionReason).toBe("DeviceTokenNotForTopic");

    const malformedToken = await client.sendNotification(notification({ token: "not-hex" }));
    expect(malformedToken.rejectionReason).toBe("BadDeviceToken");

    const badPriority = await client.sendNotification(notification({ priority: 7 as DeliveryPriority }));
    expect(badPriority.rejectionReason).toBe("BadPriority");

    const empty = await client.sendNotification(notification({ payload: "" }));
    expect(empty.rejectionReason).toBe("PayloadEmpty");

    const tooLarge = await client.sendNotification(notification({ payload: "x".repeat(5000) }));
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.rejectionReason).toBe("PayloadTooLarge");
  });

  test("reports when a device token stopped being valid", async () => {
    const expiredToken = randomDeviceToken();
    const invalidatedAt = new Date("2026-05-06T07:08:09.123Z");
    const { server, port } = await startServer({
      handlerFactory: validatingHandlerFactory({ expiredTokens: { [expiredToken]: invalidatedAt } }),
    });
    track(server);
    const client = track(tokenClient(port));

    const response = await client.sendNotification(notification({ token: expiredToken }));
    expect(response.accepted).toBe(false);
    expect(response.statusCode).toBe(410);
    expect(response.rejectionReason).toBe("Unregistered");
    expect(response.tokenInvalidationTimestamp).toEqual(invalidatedAt);
  });

  test("mints a new token and reconnects when the server reports the token expired", async () => {
    const authorizations: string[] = [];
    let rejectNext = true;
    const handlerFactory: PushNotificationHandlerFactory = {
      buildHandler: () => ({
        handlePushNotification(headers) {
          authorizations.push(String(headers.authorization));
          if (rejectNext) {
            rejectNext = false;
            throw new RejectedNotificationError(RejectionReason.EXPIRED_PROVIDER_TOKEN);
          }
        },
      }),
    };
    const { server, port } = await startServer({ handlerFactory });
    track(server);
    const { counts, listener } = countingMetrics();
    const client = track(tokenClient(port, { metricsListener: listener }));

    const first = await client.sendNotification(notification());
    expect(first.rejectionReason).toBe("ExpiredProviderToken");

    const second = await client.sendNotification(notification());
    expect(second.accepted).toBe(true);
    expect(authorizations[1]).not.toBe(authorizations[0]);
    expect(counts.added).toBe(2);
  });
});

describe("TLS-based authentication", () => {
  test("authenticates with a PEM certificate and key", async () => {
    const voipToken = randomDeviceToken();
    const { server, port } = await startServer({
      handlerFactory: new (await import("../src")).ValidatingPushNotificationHandlerFactory({
        deviceTokensByTopic: { [TOPIC]: [DEVICE_TOKEN], [`${TOPIC}.voip`]: [voipToken], "com.other.app": [DEVICE_TOKEN] },
      }),
    });
    track(server);
    const client = track(tlsClient(port));

    expect((await client.sendNotification(notification())).accepted).toBe(true);
    expect((await client.sendNotification(notification({ token: voipToken, topic: `${TOPIC}.voip` }))).accepted).toBe(
      true,
    );

    const otherTopic = await client.sendNotification(notification({ topic: "com.other.app" }));
    expect(otherTopic.accepted).toBe(false);
    expect(otherTopic.rejectionReason).toBe("BadTopic");
  });

  test("authenticates with a PKCS#12 bundle via the builder", async () => {
    const { server, port } = await startServer();
    track(server);

    const client = track(
      new ApnsClientBuilder()
        .setApnsServer("localhost", port)
        .setClientCredentials(fixturePath("client.p12"), "pushy-test")
        .setTrustedServerCertificateChain(fixturePath("ca.pem"))
        .build(),
    );

    expect((await client.sendNotification(notification())).accepted).toBe(true);
  });
});

describe("connection management", () => {
  test("multiplexes many notifications over a bounded number of connections", async () => {
    const { server, port } = await startServer({ maxConcurrentStreams: 5 });
    track(server);
    const { counts, listener } = countingMetrics();
    const client = track(tokenClient(port, { concurrentConnections: 2, metricsListener: listener }));

    const responses = await Promise.all(Array.from({ length: 200 }, () => client.sendNotification(notification())));

    expect(responses.every((response) => response.accepted)).toBe(true);
    expect(counts.added).toBe(2);
    expect(counts.sent).toBe(200);
    expect(counts.acknowledged).toBe(200);
    expect(counts.writeFailures).toBe(0);
  });

  // Bun's HTTP/2 server cannot send RST_STREAM error codes yet, so the refusing server always runs under Node.
  test.skipIf(Bun.which("node") === null)("retries notifications the server refused before processing", async () => {
    const child = Bun.spawn(["node", join(import.meta.dir, "support/refusing-server.mjs"), join(import.meta.dir, "fixtures")], {
      stdin: "pipe",
      stdout: "pipe",
    });
    cleanups.push(() => {
      child.stdin.end();
      child.kill();
      return child.exited;
    });
    const reader = child.stdout.getReader();
    const port = Number(new TextDecoder().decode((await reader.read()).value).trim());
    reader.releaseLock();

    const client = track(tokenClient(port));
    const response = await client.sendNotification(notification());

    expect(response.accepted).toBe(true);
    // The first request was refused; the client retried it as the second
    expect(response.apnsId).toBe("00000000-0000-0000-0000-000000000002");
  });

  test("closes idle connections and reconnects on demand", async () => {
    const { server, port } = await startServer();
    track(server);
    const { counts, listener } = countingMetrics();
    const client = track(tokenClient(port, { closeAfterIdleMs: 100, metricsListener: listener }));

    await client.sendNotification(notification());
    await sleep(300);
    expect(counts.removed).toBe(1);

    expect((await client.sendNotification(notification())).accepted).toBe(true);
    expect(counts.added).toBe(2);
  });

  test("drops connections the server closes", async () => {
    const { server, port } = await startServer();
    const { counts, listener } = countingMetrics();
    const client = track(tokenClient(port, { metricsListener: listener }));

    await client.sendNotification(notification());
    await server.shutdown();
    await sleep(100);
    expect(counts.removed).toBe(1);
  });

  test("tunnels through an HTTP CONNECT proxy", async () => {
    const { server, port } = await startServer();
    track(server);

    const connectRequests: string[] = [];
    const proxy = track(
      net.createServer((socket) => {
        socket.once("data", (data) => {
          const requestLine = data.toString("latin1").split("\r\n")[0]!;
          connectRequests.push(requestLine);
          const [host, targetPort] = requestLine.split(" ")[1]!.split(":");
          const upstream = net.connect(Number(targetPort), host === "localhost" ? "127.0.0.1" : host, () => {
            socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            socket.pipe(upstream).pipe(socket);
          });
          upstream.on("error", () => socket.destroy());
          socket.on("error", () => upstream.destroy());
        });
      }),
    );
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const proxyPort = (proxy.address() as net.AddressInfo).port;

    const client = track(tokenClient(port, { proxy: { host: "127.0.0.1", port: proxyPort } }));

    expect((await client.sendNotification(notification())).accepted).toBe(true);
    expect(connectRequests).toEqual([`CONNECT localhost:${port} HTTP/1.1`]);
  });
});

describe("failures", () => {
  test("rejects when the server cannot be reached", async () => {
    const closedPort = await new Promise<number>((resolve) => {
      const probe = net.createServer().listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as net.AddressInfo;
        probe.close(() => resolve(port));
      });
    });
    const { counts, listener } = countingMetrics();
    const client = track(tokenClient(closedPort, { metricsListener: listener }));

    await expect(client.sendNotification(notification())).rejects.toThrow();
    expect(counts.creationFailed).toBe(1);
    expect(counts.writeFailures).toBe(1);
  });

  test("times out connections that never complete the handshake", async () => {
    const sockets: net.Socket[] = [];
    const blackHole = track(net.createServer((socket) => void sockets.push(socket)));
    cleanups.push(() => sockets.forEach((socket) => socket.destroy()));
    await new Promise<void>((resolve) => blackHole.listen(0, "127.0.0.1", resolve));
    const port = (blackHole.address() as net.AddressInfo).port;
    const client = track(tokenClient(port, { connectionTimeoutMs: 200 }));

    await expect(client.sendNotification(notification())).rejects.toBeInstanceOf(ConnectionTimeoutError);
  });

  test("refuses servers whose certificate is not trusted", async () => {
    const { server, port } = await startServer();
    track(server);
    const client = track(tokenClient(port, { trustedServerCertificates: undefined }));

    await expect(client.sendNotification(notification())).rejects.toThrow();
  });

  test("validates client options", () => {
    const { signingKey } = require("./helpers") as typeof import("./helpers");
    expect(() => new ApnsClient({ host: "", signingKey })).toThrow(/server address/);
    expect(() => new ApnsClient({ host: "localhost" })).toThrow(/No client credentials/);
    expect(
      () =>
        new ApnsClient({
          host: "localhost",
          signingKey,
          clientCredentials: { cert: fixture("client.pem"), key: fixture("client.key") },
        }),
    ).toThrow(/both/);
    expect(() => new ApnsClient({ host: "localhost", signingKey, concurrentConnections: 0 })).toThrow(RangeError);
    expect(() => new ApnsClientBuilder().setSigningKey(signingKey).build()).toThrow(/server address/);
  });
});

describe("shutdown", () => {
  test("lets in-flight notifications finish, then refuses new ones", async () => {
    const handlerFactory: PushNotificationHandlerFactory = {
      buildHandler: () => ({ handlePushNotification: () => sleep(150) }),
    };
    const { server, port } = await startServer({ handlerFactory });
    track(server);
    const client = tokenClient(port);

    await client.sendNotification(notification()); // warm up the connection
    const inFlight = client.sendNotification(notification());
    await sleep(20);
    const closed = client.close();

    expect((await inFlight).accepted).toBe(true);
    await closed;
    expect(client.isClosed).toBe(true);
    await expect(client.sendNotification(notification())).rejects.toBeInstanceOf(ClientClosedError);
    expect(client.close()).toBe(closed);
  });
});
