import { describe, expect, test } from "bun:test";
import { ApnsPayloadBuilder, InterruptionLevel, LiveActivityEvent, sanitizeTokenString } from "../src";

const aps = (builder: ApnsPayloadBuilder) => JSON.parse(builder.build()).aps;

describe("ApnsPayloadBuilder", () => {
  test("builds an empty aps dictionary by default", () => {
    expect(JSON.parse(new ApnsPayloadBuilder().build())).toEqual({ aps: {} });
  });

  test("writes the alert as a dictionary, or a string when preferred", () => {
    const builder = new ApnsPayloadBuilder().setAlertBody("Hello");
    expect(aps(builder).alert).toEqual({ body: "Hello" });

    builder.setPreferStringRepresentationForAlerts(true);
    expect(aps(builder).alert).toBe("Hello");

    builder.setAlertTitle("Title");
    expect(aps(builder).alert).toEqual({ body: "Hello", title: "Title" });
  });

  test("writes localized alerts with arguments", () => {
    const builder = new ApnsPayloadBuilder()
      .setLocalizedAlertMessage("alert.key", "a", "b")
      .setLocalizedAlertTitle("title.key")
      .setLocalizedAlertSubtitle("subtitle.key", "c");

    expect(aps(builder).alert).toEqual({
      "loc-key": "alert.key",
      "loc-args": ["a", "b"],
      "title-loc-key": "title.key",
      "subtitle-loc-key": "subtitle.key",
      "subtitle-loc-args": ["c"],
    });
  });

  test("handles the action button", () => {
    expect(aps(new ApnsPayloadBuilder().setActionButtonLabel("Open")).alert).toEqual({ action: "Open" });
    expect(aps(new ApnsPayloadBuilder().setActionButtonLabel("Open").setLocalizedActionButtonKey("open.key")).alert).toEqual({
      "action-loc-key": "open.key",
    });
    expect(aps(new ApnsPayloadBuilder().setShowActionButton(false)).alert).toEqual({ "action-loc-key": null });
  });

  test("writes badge, sound, category and flags", () => {
    const payload = aps(
      new ApnsPayloadBuilder()
        .setBadgeNumber(0)
        .setSound("default")
        .setCategoryName("MESSAGE")
        .setContentAvailable(true)
        .setMutableContent(true)
        .setThreadId("thread")
        .setTargetContentId("target")
        .setInterruptionLevel(InterruptionLevel.TIME_SENSITIVE)
        .setRelevanceScore(0.5)
        .setUrlArguments("a", "b"),
    );

    expect(payload).toEqual({
      badge: 0,
      sound: "default",
      category: "MESSAGE",
      "content-available": 1,
      "mutable-content": 1,
      "thread-id": "thread",
      "target-content-id": "target",
      "interruption-level": "time-sensitive",
      "relevance-score": 0.5,
      "url-args": ["a", "b"],
    });

    expect(aps(new ApnsPayloadBuilder().setUrlArguments(["x"]))["url-args"]).toEqual(["x"]);
    expect(aps(new ApnsPayloadBuilder().setUrlArguments(null))["url-args"]).toBeUndefined();
  });

  test("writes critical alert sounds and validates the volume", () => {
    expect(aps(new ApnsPayloadBuilder().setSound("alarm.aiff", true, 0.75)).sound).toEqual({
      critical: 1,
      name: "alarm.aiff",
      volume: 0.75,
    });
    expect(() => new ApnsPayloadBuilder().setSound("alarm.aiff", true, 1.5)).toThrow(RangeError);
    expect(() => new ApnsPayloadBuilder().setSound("alarm.aiff", true, Number.NaN)).toThrow(RangeError);
  });

  test("writes summary arguments and validates the count", () => {
    expect(aps(new ApnsPayloadBuilder().setSummaryArgument("Bob").setSummaryArgumentCount(2)).alert).toEqual({
      "summary-arg": "Bob",
      "summary-arg-count": 2,
    });
    expect(() => new ApnsPayloadBuilder().setSummaryArgumentCount(0)).toThrow(RangeError);
    expect(() => new ApnsPayloadBuilder().setRelevanceScore(Number.NaN)).toThrow(RangeError);
  });

  test("builds Live Activity payloads", () => {
    const timestamp = new Date("2026-03-04T05:06:07Z");
    const payload = aps(
      new ApnsPayloadBuilder()
        .setEvent(LiveActivityEvent.UPDATE)
        .setTimestamp(timestamp)
        .setDismissalDate(new Date(timestamp.getTime() + 60_000))
        .setStaleDate(new Date(timestamp.getTime() + 120_000))
        .setContentState({ score: "1-0" })
        .setAttributesType("MatchAttributes")
        .setAttributes({ team: "A" })
        .setAlertTitle("Goal!")
        .setSound("goal.caf"),
    );

    const seconds = timestamp.getTime() / 1000;
    expect(payload).toEqual({
      event: "update",
      timestamp: seconds,
      "dismissal-date": seconds + 60,
      "stale-date": seconds + 120,
      "content-state": { score: "1-0" },
      "attributes-type": "MatchAttributes",
      attributes: { team: "A" },
      // Live Activities put the sound inside the alert
      alert: { title: "Goal!", sound: "goal.caf" },
    });
  });

  test("adds custom properties but refuses to overwrite aps", () => {
    const payload = JSON.parse(
      new ApnsPayloadBuilder().addCustomProperty("orderId", 42).addCustomProperty("meta", { a: [1] }).build(),
    );
    expect(payload).toEqual({ aps: {}, orderId: 42, meta: { a: [1] } });
    expect(() => new ApnsPayloadBuilder().addCustomProperty("aps", {})).toThrow(/aps/);
  });

  test("supports custom serializers and MDM payloads", () => {
    expect(new ApnsPayloadBuilder().setBadgeNumber(1).build((payload) => JSON.stringify(payload, null, 2))).toContain(
      '\n  "aps"',
    );
    expect(new ApnsPayloadBuilder().setAlertBody("ignored").buildMdmPayload("magic")).toBe('{"mdm":"magic"}');
  });
});

test("sanitizeTokenString strips non-hex characters", () => {
  expect(sanitizeTokenString("<1a2b 3c4d-ZZ>")).toBe("1a2b3c4d");
});
