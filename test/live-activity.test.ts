import { afterEach, describe, expect, test } from "bun:test";
import dns from "node:dns";
import type http2 from "node:http2";
import {
  ApnsChannelManagementClient,
  ApnsClient,
  ApnsPayloadBuilder,
  ChannelManagementError,
  DeliveryPriority,
  LiveActivityEvent,
  LiveActivityPayloadBuilder,
  LiveActivityPushNotification,
  MessageStoragePolicy,
  liveActivityTopic,
  type ApnsClientMetricsListener,
  type BroadcastNotificationResponse,
  type LiveActivityPriority,
  type MockApnsServer,
} from "../src";
import {
  DEVICE_TOKEN,
  fixture,
  randomDeviceToken,
  signingKey,
  startServer,
  tlsClient,
  tokenClient,
  TOPIC,
  validatingHandlerFactory,
} from "./helpers";
import { startChannelManagementServer } from "./support/channel-management-server.mjs";

const cleanups: Array<() => Promise<unknown> | unknown> = [];
const track = <T extends ApnsClient | ApnsChannelManagementClient | MockApnsServer>(resource: T): T => {
  cleanups.push(() => ("shutdown" in resource ? resource.shutdown() : resource.close()));
  return resource;
};
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const aps = (payload: string) => JSON.parse(payload).aps;
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

const CHANNEL_ID = Buffer.from("game-1234-channel").toString("base64");
const NO_STORAGE_CHANNEL_ID = Buffer.from("no-storage-channel").toString("base64");

const updatePayload = () =>
  new LiveActivityPayloadBuilder()
    .setEvent(LiveActivityEvent.UPDATE)
    .setContentState({ homeScore: 1, awayScore: 0 })
    .build();

describe("LiveActivityPayloadBuilder", () => {
  test("builds update payloads with Apple's alert format", () => {
    const timestamp = new Date("2026-06-01T12:00:00Z");
    const staleDate = new Date("2026-06-01T12:15:00Z");
    const payload = new LiveActivityPayloadBuilder()
      .setEvent(LiveActivityEvent.UPDATE)
      .setTimestamp(timestamp)
      .setContentState({ currentHealthLevel: 0.0, eventDescription: "Power Panda has been knocked down!" })
      .setStaleDate(staleDate)
      .setRelevanceScore(100)
      .setLocalizedAlertTitle("%@ is knocked down!", "Power Panda")
      .setLocalizedAlertBody("Use a potion to heal %@!", "Power Panda")
      .setAlertSound("HeroDown.mp4")
      .addCustomProperty("matchId", "m-1")
      .build();

    // Mirrors the example in Apple's "Starting and updating Live Activities with ActivityKit push notifications"
    expect(JSON.parse(payload)).toEqual({
      aps: {
        timestamp: seconds(timestamp),
        event: "update",
        "content-state": { currentHealthLevel: 0.0, eventDescription: "Power Panda has been knocked down!" },
        "stale-date": seconds(staleDate),
        "relevance-score": 100,
        alert: {
          title: { "loc-key": "%@ is knocked down!", "loc-args": ["Power Panda"] },
          body: { "loc-key": "Use a potion to heal %@!", "loc-args": ["Power Panda"] },
          sound: "HeroDown.mp4",
        },
      },
      matchId: "m-1",
    });
  });

  test("defaults the timestamp to now and accepts plain alert strings", () => {
    const before = Math.floor(Date.now() / 1000);
    const payload = aps(
      new LiveActivityPayloadBuilder()
        .setEvent(LiveActivityEvent.UPDATE)
        .setContentState({ eta: 5 })
        .setAlert({ title: "Delivery update", body: "Your driver is nearby." })
        .build(),
    );

    expect(payload.timestamp).toBeGreaterThanOrEqual(before);
    expect(payload.timestamp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(payload.alert).toEqual({ title: "Delivery update", body: "Your driver is nearby." });
  });

  test("builds push-to-start payloads, optionally asking for a token or joining a channel", () => {
    const start = () =>
      new LiveActivityPayloadBuilder()
        .setEvent(LiveActivityEvent.START)
        .setAttributesType("AdventureAttributes")
        .setAttributes({ hero: { name: "Power Panda" } })
        .setContentState({ currentHealthLevel: 100, eventDescription: "Adventure has begun!" })
        .setAlert({ title: { locKey: "%@ is on an adventure!", locArgs: ["Power Panda"] }, sound: "chime.aiff" });

    expect(aps(start().build())).toMatchObject({
      event: "start",
      "attributes-type": "AdventureAttributes",
      attributes: { hero: { name: "Power Panda" } },
      alert: { title: { "loc-key": "%@ is on an adventure!", "loc-args": ["Power Panda"] }, sound: "chime.aiff" },
    });
    expect(aps(start().setInputPushToken(true).build())["input-push-token"]).toBe(1);
    expect(aps(start().setInputPushChannel(CHANNEL_ID).build())["input-push-channel"]).toBe(CHANNEL_ID);
  });

  test("builds end payloads with a dismissal date", () => {
    const dismissal = new Date("2026-06-01T13:00:00Z");
    const payload = aps(
      new LiveActivityPayloadBuilder()
        .setEvent(LiveActivityEvent.END)
        .setContentState({ homeScore: 2, awayScore: 1 })
        .setDismissalDate(dismissal)
        .build(),
    );
    expect(payload).toMatchObject({ event: "end", "dismissal-date": seconds(dismissal) });
  });

  test("rejects payloads that break Apple's rules", () => {
    const build = (configure: (builder: LiveActivityPayloadBuilder) => LiveActivityPayloadBuilder) => () =>
      configure(new LiveActivityPayloadBuilder()).build();
    const validStart = (builder: LiveActivityPayloadBuilder) =>
      builder
        .setEvent(LiveActivityEvent.START)
        .setAttributesType("A")
        .setAttributes({})
        .setContentState({})
        .setAlertTitle("Started");

    expect(build((b) => b.setContentState({}))).toThrow(/event/);
    expect(build((b) => b.setEvent(LiveActivityEvent.UPDATE))).toThrow(/content-state/);
    expect(build((b) => validStart(b).setAttributes(null))).toThrow(/attributes/);
    expect(build((b) => validStart(b).setAlertTitle(null))).toThrow(/alert/);
    expect(build((b) => validStart(b).setInputPushToken(true).setInputPushChannel(CHANNEL_ID))).toThrow(/either/);
    expect(build((b) => b.setEvent(LiveActivityEvent.UPDATE).setContentState({}).setInputPushToken(true))).toThrow(
      /starting/,
    );
    expect(build((b) => b.setEvent(LiveActivityEvent.UPDATE).setContentState({}).setAttributesType("A"))).toThrow(
      /starting/,
    );
    expect(build((b) => b.setEvent(LiveActivityEvent.UPDATE).setContentState({}).setDismissalDate(new Date()))).toThrow(
      /ending/,
    );
    expect(() => new LiveActivityPayloadBuilder().setRelevanceScore(Number.NaN)).toThrow(RangeError);
  });
});

describe("ApnsPayloadBuilder Live Activity support (Pushy issue #1112)", () => {
  test("writes localized titles and bodies as loc-key objects for Live Activities", () => {
    const payload = aps(
      new ApnsPayloadBuilder()
        .setEvent(LiveActivityEvent.UPDATE)
        .setTimestamp(new Date(0))
        .setContentState({})
        .setLocalizedAlertTitle("TITLE_KEY", "a")
        .setLocalizedAlertMessage("BODY_KEY")
        .setSound("chime.aiff")
        .build(),
    );
    expect(payload.alert).toEqual({
      title: { "loc-key": "TITLE_KEY", "loc-args": ["a"] },
      body: { "loc-key": "BODY_KEY" },
      sound: "chime.aiff",
    });
  });

  test("keeps the classic loc-key keys for regular notifications", () => {
    expect(aps(new ApnsPayloadBuilder().setLocalizedAlertTitle("TITLE_KEY").build()).alert).toEqual({
      "title-loc-key": "TITLE_KEY",
    });
  });

  test("supports input-push-token and input-push-channel", () => {
    const payload = aps(
      new ApnsPayloadBuilder().setEvent(LiveActivityEvent.START).setInputPushToken(true).setInputPushChannel("abc").build(),
    );
    expect(payload["input-push-token"]).toBe(1);
    expect(payload["input-push-channel"]).toBe("abc");
  });
});

describe("LiveActivityPushNotification", () => {
  test("uses the liveactivity push type and topic", () => {
    const notification = new LiveActivityPushNotification(DEVICE_TOKEN, TOPIC, "{}");
    expect(notification.topic).toBe(`${TOPIC}.push-type.liveactivity`);
    expect(notification.pushType).toBe("liveactivity");
    expect(notification.priority).toBe(10);
    expect(liveActivityTopic(`${TOPIC}.push-type.liveactivity`)).toBe(`${TOPIC}.push-type.liveactivity`);
  });

  test("only allows priorities 5 and 10", () => {
    expect(new LiveActivityPushNotification(DEVICE_TOKEN, TOPIC, "{}", { priority: 5 }).priority).toBe(5);
    expect(
      () =>
        new LiveActivityPushNotification(DEVICE_TOKEN, TOPIC, "{}", {
          priority: DeliveryPriority.DO_NOT_AWAKEN as unknown as LiveActivityPriority,
        }),
    ).toThrow(RangeError);
  });

  test("is accepted by the mock server with Apple's headers", async () => {
    const received: http2.IncomingHttpHeaders[] = [];
    const { server, port } = await startServer({
      listener: { handlePushNotificationAccepted: (headers) => received.push(headers) },
    });
    track(server);
    const client = track(tokenClient(port));

    const response = await client.sendNotification(
      new LiveActivityPushNotification(DEVICE_TOKEN, TOPIC, updatePayload(), { priority: 5 }),
    );

    expect(response.accepted).toBe(true);
    expect(received[0]).toMatchObject({
      "apns-topic": `${TOPIC}.push-type.liveactivity`,
      "apns-push-type": "liveactivity",
      "apns-priority": "5",
    });
  });
});

describe("broadcast push notifications (Pushy issue #1081)", () => {
  const broadcastServer = (listener?: { handlePushNotificationAccepted?: (h: http2.IncomingHttpHeaders) => void }) =>
    startServer({
      ...(listener ? { listener } : {}),
      handlerFactory: validatingHandlerFactory({
        broadcastChannels: [
          { bundleId: TOPIC, channelId: CHANNEL_ID, messageStoragePolicy: MessageStoragePolicy.MOST_RECENT_MESSAGE_STORED },
          { bundleId: TOPIC, channelId: NO_STORAGE_CHANNEL_ID, messageStoragePolicy: MessageStoragePolicy.NO_MESSAGE_STORED },
        ],
      }),
    });

  test("broadcasts an update to a channel", async () => {
    const received: http2.IncomingHttpHeaders[] = [];
    const { server, port } = await broadcastServer({ handlePushNotificationAccepted: (headers) => received.push(headers) });
    track(server);
    const acknowledged: BroadcastNotificationResponse[] = [];
    const metricsListener: ApnsClientMetricsListener = {
      handleBroadcastNotificationAcknowledged: (response) => acknowledged.push(response),
    };
    const client = track(tokenClient(port, { metricsListener }));

    const apnsRequestId = crypto.randomUUID();
    const response = await client.sendBroadcastNotification({
      bundleId: TOPIC,
      channelId: CHANNEL_ID,
      payload: updatePayload(),
      apnsRequestId,
    });

    expect(response.accepted).toBe(true);
    expect(response.statusCode).toBe(200);
    expect(response.apnsRequestId).toBe(apnsRequestId);
    expect(response.apnsUniqueId).toMatch(/^[0-9a-f-]{36}$/);
    expect(acknowledged).toHaveLength(1);

    const headers = received[0]!;
    expect(headers).toMatchObject({
      ":method": "POST",
      ":path": `/4/broadcasts/apps/${TOPIC}`,
      "apns-channel-id": CHANNEL_ID,
      "apns-push-type": "liveactivity",
      "apns-expiration": "0",
      "apns-priority": "10",
      "apns-request-id": apnsRequestId,
    });
    expect(headers["apns-topic"]).toBeUndefined();
    expect(headers.authorization).toMatch(/^bearer /);
  });

  test("accepts payloads up to 5 KB", async () => {
    const { server, port } = await broadcastServer();
    track(server);
    const client = track(tokenClient(port));
    const send = (payload: string) => client.sendBroadcastNotification({ bundleId: TOPIC, channelId: CHANNEL_ID, payload });

    const padded = (size: number) => JSON.stringify({ aps: { event: "update", "content-state": { x: "y".repeat(size) } } });
    expect((await send(padded(4500))).accepted).toBe(true);
    expect((await send(padded(5200))).rejectionReason).toBe("PayloadTooLarge");
  });

  test("reports broadcast rejections", async () => {
    const { server, port } = await broadcastServer();
    track(server);
    const client = track(tokenClient(port));
    const send = (overrides: Record<string, unknown>) =>
      client.sendBroadcastNotification({ bundleId: TOPIC, channelId: CHANNEL_ID, payload: updatePayload(), ...overrides });

    expect((await send({ channelId: Buffer.from("unknown").toString("base64") })).rejectionReason).toBe(
      "ChannelNotRegistered",
    );
    expect((await send({ channelId: "not base64!" })).rejectionReason).toBe("BadChannelId");
    expect((await send({ channelId: NO_STORAGE_CHANNEL_ID, expiration: new Date(Date.now() + 60_000) })).rejectionReason).toBe(
      "BadExpirationDate",
    );
    expect((await send({ channelId: NO_STORAGE_CHANNEL_ID, expiration: 0 })).accepted).toBe(true);
    expect((await send({ bundleId: `${TOPIC}.push-type.liveactivity` })).rejectionReason).toBe("TopicDisallowed");

    const otherApp = await send({ bundleId: "com.other.app" });
    expect(otherApp.statusCode).toBe(403);
    expect(otherApp.rejectionReason).toBe("TopicMismatch");
  });

  test("checks the certificate's topic for TLS-authenticated broadcasts", async () => {
    const { server, port } = await broadcastServer();
    track(server);
    const client = track(tlsClient(port));

    expect((await client.sendBroadcastNotification({ bundleId: TOPIC, channelId: CHANNEL_ID, payload: updatePayload() })).accepted).toBe(true);
    const otherApp = await client.sendBroadcastNotification({ bundleId: "com.other.app", channelId: CHANNEL_ID, payload: "{}" });
    expect(otherApp.rejectionReason).toBe("TopicMismatch");
  });

  test("validates broadcast notifications before sending", async () => {
    const client = track(tokenClient(1));
    await expect(client.sendBroadcastNotification({ bundleId: "a/b", channelId: CHANNEL_ID, payload: "{}" })).rejects.toThrow(
      /bundle ID/,
    );
    await expect(client.sendBroadcastNotification({ bundleId: TOPIC, channelId: "", payload: "{}" })).rejects.toThrow(
      /channel ID/,
    );
  });
});

describe("ApnsChannelManagementClient", () => {
  test("creates, lists, reads and deletes channels", async () => {
    const fake = await startChannelManagementServer({ cert: fixture("server.pem"), key: fixture("server.key") });
    cleanups.push(() => fake.close());
    const client = track(
      new ApnsChannelManagementClient({
        host: "localhost",
        port: fake.port,
        signingKey,
        trustedServerCertificates: fixture("ca.pem"),
      }),
    );

    const requestId = crypto.randomUUID();
    const created = await client.createChannel(TOPIC, {
      messageStoragePolicy: MessageStoragePolicy.MOST_RECENT_MESSAGE_STORED,
      apnsRequestId: requestId,
    });
    expect(created.apnsRequestId).toBe(requestId);
    expect(created.channelId).toMatch(/^[A-Za-z0-9+/]+=*$/);

    const createRequest = fake.requests[0]!;
    expect(createRequest.headers).toMatchObject({ ":method": "POST", ":path": `/1/apps/${TOPIC}/channels` });
    expect(createRequest.headers.authorization).toMatch(/^bearer /);
    expect(JSON.parse(createRequest.body)).toEqual({ "message-storage-policy": 1, "push-type": "LiveActivity" });

    expect((await client.listChannels(TOPIC)).channels).toEqual([created.channelId]);

    const configuration = await client.readChannel(TOPIC, created.channelId);
    expect(configuration).toMatchObject({
      channelId: created.channelId,
      messageStoragePolicy: MessageStoragePolicy.MOST_RECENT_MESSAGE_STORED,
      pushType: "LiveActivity",
    });
    expect(fake.requests.at(-1)!.headers["apns-channel-id"]).toBe(created.channelId);

    await client.deleteChannel(TOPIC, created.channelId);
    expect((await client.listChannels(TOPIC)).channels).toEqual([]);

    const error = await client.readChannel(TOPIC, created.channelId).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChannelManagementError);
    expect(error).toMatchObject({ statusCode: 400, reason: "ChannelNotRegistered" });
    expect((error as ChannelManagementError).apnsRequestId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("tlsOptions (Pushy issues #951 and #1121)", () => {
  test("applies extra TLS options, evaluated for every new connection", async () => {
    const { server, port } = await startServer();
    track(server);

    let evaluations = 0;
    const lookups: string[] = [];
    const client = track(
      tokenClient(port, {
        closeAfterIdleMs: 50,
        tlsOptions: () => {
          evaluations++;
          return {
            minVersion: "TLSv1.3",
            lookup: (hostname, options, callback) => {
              lookups.push(hostname);
              dns.lookup(hostname, options, callback);
            },
          };
        },
      }),
    );

    expect((await client.sendNotification({ token: DEVICE_TOKEN, topic: TOPIC, payload: "{}" })).accepted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await client.sendNotification({ token: DEVICE_TOKEN, topic: TOPIC, payload: "{}" })).accepted).toBe(true);

    expect(evaluations).toBe(2);
    expect(lookups).toEqual(["localhost", "localhost"]);
  });

  test("cannot switch off certificate verification", async () => {
    const { server, port } = await startServer();
    track(server);
    const client = track(
      tokenClient(port, {
        trustedServerCertificates: undefined,
        tlsOptions: { rejectUnauthorized: false } as never,
      }),
    );
    await expect(client.sendNotification({ token: randomDeviceToken(), topic: TOPIC, payload: "{}" })).rejects.toThrow();
  });
});
