// End-to-end scenarios run under plain Node.js against the built package, once through the ESM entry point and once
// through the CommonJS one. They prove the published artifacts work in any Node project, not just under Bun.
const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const { readFileSync } = require("node:fs");
const http2 = require("node:http2");
const net = require("node:net");
const { join } = require("node:path");

const fixtures = join(__dirname, "..", "fixtures");
const fixture = (name) => readFileSync(join(fixtures, name));

const TOPIC = "com.example.pushy";
const TEAM_ID = "TEAMID1234";
const KEY_ID = "KEYID56789";

function defineScenarios(lib, { describe, test, after }) {
  const {
    ApnsClient,
    ApnsClientBuilder,
    ApnsPayloadBuilder,
    ApnsSigningKey,
    ApnsVerificationKey,
    ConnectionTimeoutError,
    ClientClosedError,
    ApnsChannelManagementClient,
    LiveActivityEvent,
    LiveActivityPayloadBuilder,
    LiveActivityPushNotification,
    MessageStoragePolicy,
    MockApnsServer,
    PushType,
    ValidatingPushNotificationHandlerFactory,
  } = lib;

  const deviceToken = randomBytes(32).toString("hex");
  const signingKey = ApnsSigningKey.loadFromPkcs8(fixture("token-auth-private-key.p8"), TEAM_ID, KEY_ID);
  const payload = new ApnsPayloadBuilder().setAlertTitle("Hello").setAlertBody("From Node").build();

  const cleanups = [];
  after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  });

  const channelId = Buffer.from("node-e2e-channel").toString("base64");

  async function startMockServer() {
    const server = new MockApnsServer({
      serverCredentials: { cert: fixture("server.pem"), key: fixture("server.key") },
      trustedClientCertificates: fixture("ca.pem"),
      handlerFactory: new ValidatingPushNotificationHandlerFactory({
        deviceTokensByTopic: { [TOPIC]: [deviceToken] },
        verificationKeys: [{ key: ApnsVerificationKey.fromSigningKey(signingKey), topics: [TOPIC] }],
        broadcastChannels: [{ bundleId: TOPIC, channelId }],
      }),
    });
    const port = await server.start(0, "127.0.0.1");
    cleanups.push(() => server.shutdown());
    return port;
  }

  const newClient = (options) => {
    const client = new ApnsClient({ host: "localhost", trustedServerCertificates: fixture("ca.pem"), ...options });
    cleanups.push(() => client.close());
    return client;
  };

  describe("pushy-ts under Node.js", () => {
    test("token-based authentication", async () => {
      const port = await startMockServer();
      const client = newClient({ port, signingKey, concurrentConnections: 2 });

      const responses = await Promise.all(
        Array.from({ length: 50 }, () =>
          client.sendNotification({ token: deviceToken, topic: TOPIC, payload, pushType: PushType.ALERT }),
        ),
      );
      assert.ok(responses.every((response) => response.accepted));

      const rejected = await client.sendNotification({ token: randomBytes(32).toString("hex"), topic: TOPIC, payload });
      assert.equal(rejected.accepted, false);
      assert.equal(rejected.rejectionReason, "DeviceTokenNotForTopic");
    });

    test("TLS-based authentication with PKCS#12", async () => {
      const port = await startMockServer();
      const client = new ApnsClientBuilder()
        .setApnsServer("localhost", port)
        .setClientCredentials(join(fixtures, "client.p12"), "pushy-test")
        .setTrustedServerCertificateChain(join(fixtures, "ca.pem"))
        .build();
      cleanups.push(() => client.close());

      const response = await client.sendNotification({ token: deviceToken, topic: TOPIC, payload });
      assert.equal(response.accepted, true);
    });

    test("retries refused streams", async () => {
      let requests = 0;
      const server = http2.createSecureServer({ cert: fixture("server.pem"), key: fixture("server.key") });
      server.on("stream", (stream) => {
        stream.on("error", () => {});
        if (++requests === 1) return stream.close(http2.constants.NGHTTP2_REFUSED_STREAM);
        stream.resume();
        stream.on("end", () => stream.respond({ ":status": 200, "apns-id": randomUUID() }, { endStream: true }));
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      cleanups.push(() => new Promise((resolve) => server.close(resolve)));

      const client = newClient({ port: server.address().port, signingKey });
      const response = await client.sendNotification({ token: deviceToken, topic: TOPIC, payload });
      assert.equal(response.accepted, true);
      assert.equal(requests, 2);
    });

    test("Live Activity notifications, broadcasts and channels", async () => {
      const port = await startMockServer();
      const lookups = [];
      const client = newClient({
        port,
        signingKey,
        tlsOptions: () => ({
          lookup: (hostname, options, callback) => {
            lookups.push(hostname);
            require("node:dns").lookup(hostname, options, callback);
          },
        }),
      });
      const update = new LiveActivityPayloadBuilder()
        .setEvent(LiveActivityEvent.UPDATE)
        .setContentState({ homeScore: 1, awayScore: 0 })
        .setLocalizedAlertTitle("GOAL_%@", "Home")
        .build();

      const pushed = await client.sendNotification(new LiveActivityPushNotification(deviceToken, TOPIC, update));
      assert.equal(pushed.accepted, true);

      const broadcast = await client.sendBroadcastNotification({ bundleId: TOPIC, channelId, payload: update });
      assert.equal(broadcast.accepted, true);
      assert.ok(broadcast.apnsUniqueId);
      assert.deepEqual(lookups, ["localhost"]);

      const { startChannelManagementServer } = await import("../support/channel-management-server.mjs");
      const fake = await startChannelManagementServer({ cert: fixture("server.pem"), key: fixture("server.key") });
      cleanups.push(() => fake.close());
      const channels = new ApnsChannelManagementClient({
        host: "localhost",
        port: fake.port,
        signingKey,
        trustedServerCertificates: fixture("ca.pem"),
      });
      cleanups.push(() => channels.close());

      const created = await channels.createChannel(TOPIC, {
        messageStoragePolicy: MessageStoragePolicy.NO_MESSAGE_STORED,
      });
      assert.deepEqual((await channels.listChannels(TOPIC)).channels, [created.channelId]);
      assert.equal((await channels.readChannel(TOPIC, created.channelId)).messageStoragePolicy, 0);
      await channels.deleteChannel(TOPIC, created.channelId);
      assert.deepEqual((await channels.listChannels(TOPIC)).channels, []);
    });

    test("HTTP CONNECT proxy", async () => {
      const port = await startMockServer();
      const tunnels = [];
      const proxy = net.createServer((socket) => {
        socket.once("data", (data) => {
          const target = data.toString("latin1").split(" ")[1];
          tunnels.push(target);
          const upstream = net.connect(Number(target.split(":")[1]), "127.0.0.1", () => {
            socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            socket.pipe(upstream).pipe(socket);
          });
          upstream.on("error", () => socket.destroy());
          socket.on("error", () => upstream.destroy());
        });
      });
      await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
      cleanups.push(() => new Promise((resolve) => proxy.close(resolve)));

      const client = newClient({ port, signingKey, proxy: { host: "127.0.0.1", port: proxy.address().port } });
      const response = await client.sendNotification({ token: deviceToken, topic: TOPIC, payload });
      assert.equal(response.accepted, true);
      assert.deepEqual(tunnels, [`localhost:${port}`]);
    });

    test("connection timeouts and closed clients", async () => {
      const sockets = [];
      const blackHole = net.createServer((socket) => sockets.push(socket));
      await new Promise((resolve) => blackHole.listen(0, "127.0.0.1", resolve));
      cleanups.push(() => new Promise((resolve) => blackHole.close(resolve)));
      cleanups.push(() => sockets.forEach((socket) => socket.destroy()));

      const client = newClient({ port: blackHole.address().port, signingKey, connectionTimeoutMs: 200 });
      await assert.rejects(client.sendNotification({ token: deviceToken, topic: TOPIC, payload }), ConnectionTimeoutError);

      await client.close();
      await assert.rejects(client.sendNotification({ token: deviceToken, topic: TOPIC, payload }), ClientClosedError);
    });
  });
}

module.exports = { defineScenarios };
