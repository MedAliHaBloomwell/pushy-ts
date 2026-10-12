import type { OutgoingHttpHeaders } from "node:http2";
import { headerValue, parseErrorBody, type ApnsRawResponse } from "./connection";
import { DeliveryPriority, PushType, formatExpiration, type ApnsPushNotification } from "./notification";
import type { ApnsRejectionReason } from "./rejection-reason";
import { LiveActivityEvent } from "./util/payload-builder";

/** The `apns-topic` suffix Apple requires for Live Activity notifications sent to a push token. */
export const LIVE_ACTIVITY_TOPIC_SUFFIX = ".push-type.liveactivity";

/** Returns the `apns-topic` for Live Activity notifications to an app: `<bundle ID>.push-type.liveactivity`. */
export function liveActivityTopic(bundleId: string): string {
  return bundleId.endsWith(LIVE_ACTIVITY_TOPIC_SUFFIX) ? bundleId : bundleId + LIVE_ACTIVITY_TOPIC_SUFFIX;
}

/** Live Activity notifications may only use these priorities; 5 does not count toward the system's update budget. */
export type LiveActivityPriority = typeof DeliveryPriority.IMMEDIATE | typeof DeliveryPriority.CONSERVE_POWER;

function assertLiveActivityPriority(priority: number): void {
  if (priority !== DeliveryPriority.IMMEDIATE && priority !== DeliveryPriority.CONSERVE_POWER) {
    throw new RangeError(`Live Activity notifications must use priority 5 or 10, not ${priority}.`);
  }
}

/**
 * A Live Activity notification sent to a single Live Activity push token (or push-to-start token). Sets the headers
 * Apple requires: `apns-push-type: liveactivity` and `apns-topic: <bundle ID>.push-type.liveactivity`.
 *
 * Use priority {@link DeliveryPriority.CONSERVE_POWER} (5) for updates that aren't urgent: they don't count toward the
 * hourly Live Activity budget, so mixing 5 and 10 avoids throttling.
 *
 * @see https://developer.apple.com/documentation/activitykit/starting-and-updating-live-activities-with-activitykit-push-notifications
 */
export class LiveActivityPushNotification implements ApnsPushNotification {
  readonly token: string;
  readonly topic: string;
  readonly payload: string;
  readonly pushType = PushType.LIVE_ACTIVITY;
  readonly priority: LiveActivityPriority;
  readonly expiration: Date | 0 | null;
  readonly collapseId: string | null;
  readonly apnsId: string | null;

  /**
   * @param token the Live Activity's push token, or a push-to-start token for `start` events
   * @param bundleId the app's bundle ID; the `.push-type.liveactivity` topic suffix is added for you
   * @param payload the payload, e.g. built with {@link LiveActivityPayloadBuilder}
   */
  constructor(
    token: string,
    bundleId: string,
    payload: string,
    options: {
      priority?: LiveActivityPriority | undefined;
      expiration?: Date | 0 | null | undefined;
      collapseId?: string | null | undefined;
      apnsId?: string | null | undefined;
    } = {},
  ) {
    if (token == null) throw new TypeError("Live Activity push token must not be null.");
    if (bundleId == null) throw new TypeError("Bundle ID must not be null.");
    if (payload == null) throw new TypeError("Payload must not be null.");

    const priority = options.priority ?? DeliveryPriority.IMMEDIATE;
    assertLiveActivityPriority(priority);

    this.token = token;
    this.topic = liveActivityTopic(bundleId);
    this.payload = payload;
    this.priority = priority;
    this.expiration = options.expiration ?? null;
    this.collapseId = options.collapseId ?? null;
    this.apnsId = options.apnsId ?? null;
  }
}

/** Live Activity alert text: a literal string, or a localized string key with format arguments. */
export type LiveActivityAlertText = string | { locKey: string; locArgs?: readonly string[] | undefined };

type JsonObject = Record<string, unknown>;

const epochSeconds = (date: Date) => Math.floor(date.getTime() / 1000);

function alertTextToJson(text: LiveActivityAlertText): unknown {
  if (typeof text === "string") return text;
  return text.locArgs && text.locArgs.length > 0
    ? { "loc-key": text.locKey, "loc-args": [...text.locArgs] }
    : { "loc-key": text.locKey };
}

/**
 * Builds ActivityKit push notification payloads that start, update or end Live Activities, following Apple's spec:
 *
 * - every payload carries an `event` and a `timestamp` (defaulting to the time of `build()`);
 * - `start` payloads require `attributes-type`, `attributes`, `content-state` and an alert, and may ask for an update
 *   push token (`input-push-token`) or subscribe the new activity to a broadcast channel (`input-push-channel`);
 * - `update` payloads require `content-state`;
 * - alerts carry a `title`, `body` and `sound`, where title and body may be localized.
 *
 * `build()` throws if the payload breaks one of these rules.
 *
 * @example
 * ```ts
 * const payload = new LiveActivityPayloadBuilder()
 *   .setEvent(LiveActivityEvent.UPDATE)
 *   .setContentState({ homeScore: 2, awayScore: 1 })
 *   .setStaleDate(new Date(Date.now() + 15 * 60_000))
 *   .setAlert({ title: "Goal!", body: { locKey: "GOAL_BY_%@", locArgs: ["Mbappé"] }, sound: "goal.caf" })
 *   .build();
 * ```
 */
export class LiveActivityPayloadBuilder {
  private event: LiveActivityEvent | null = null;
  private timestamp: Date | null = null;
  private contentState: JsonObject | null = null;
  private staleDate: Date | null = null;
  private dismissalDate: Date | null = null;
  private relevanceScore: number | null = null;
  private alertTitle: LiveActivityAlertText | null = null;
  private alertBody: LiveActivityAlertText | null = null;
  private alertSound: string | null = null;
  private attributesType: string | null = null;
  private attributes: JsonObject | null = null;
  private inputPushToken = false;
  private inputPushChannel: string | null = null;
  private readonly customProperties = new Map<string, unknown>();

  /** Sets whether this payload starts, updates or ends a Live Activity. Required. */
  setEvent(event: LiveActivityEvent): this {
    this.event = event;
    return this;
  }

  /**
   * Sets when the update was generated. The system ignores updates older than the one it already shows, so this
   * must increase with every update. Defaults to the time `build()` is called.
   */
  setTimestamp(timestamp: Date | null): this {
    this.timestamp = timestamp;
    return this;
  }

  /**
   * Sets the content state. It must match your `ActivityAttributes.ContentState` type, encoded with the default
   * `JSONDecoder` strategies (so camelCase keys and numeric dates as seconds since 2001, not custom encodings).
   */
  setContentState(contentState: JsonObject | null): this {
    this.contentState = contentState;
    return this;
  }

  /** Sets when the Live Activity becomes stale (outdated) if no further update arrives. */
  setStaleDate(staleDate: Date | null): this {
    this.staleDate = staleDate;
    return this;
  }

  /**
   * For `end` events: when to remove the ended Live Activity from the Lock Screen. A date in the past removes it
   * immediately; without one, the system keeps it for up to four hours.
   */
  setDismissalDate(dismissalDate: Date | null): this {
    this.dismissalDate = dismissalDate;
    return this;
  }

  /**
   * Sets the relevance score that orders your app's Live Activities; the highest appears in the Dynamic Island. Any
   * number works (e.g. 50 and 100); only the relative order matters.
   */
  setRelevanceScore(relevanceScore: number | null): this {
    if (relevanceScore != null && !Number.isFinite(relevanceScore)) {
      throw new RangeError(`Relevance score must be a finite number, but was ${relevanceScore}`);
    }
    this.relevanceScore = relevanceScore;
    return this;
  }

  /**
   * Sets an alert that lights up the device and shows the expanded presentation (or a banner on devices without a
   * Dynamic Island). Required for `start` events. Title and body may be literal strings or localized keys.
   */
  setAlert(alert: { title?: LiveActivityAlertText; body?: LiveActivityAlertText; sound?: string } | null): this {
    this.alertTitle = alert?.title ?? null;
    this.alertBody = alert?.body ?? null;
    this.alertSound = alert?.sound ?? null;
    return this;
  }

  setAlertTitle(title: string | null): this {
    this.alertTitle = title;
    return this;
  }

  setLocalizedAlertTitle(locKey: string, ...locArgs: string[]): this {
    this.alertTitle = { locKey, locArgs };
    return this;
  }

  setAlertBody(body: string | null): this {
    this.alertBody = body;
    return this;
  }

  setLocalizedAlertBody(locKey: string, ...locArgs: string[]): this {
    this.alertBody = { locKey, locArgs };
    return this;
  }

  /** Sets the alert sound: a file in the app bundle, or `"default"`. */
  setAlertSound(sound: string | null): this {
    this.alertSound = sound;
    return this;
  }

  /** For `start` events: the name of your `ActivityAttributes` type. */
  setAttributesType(attributesType: string | null): this {
    this.attributesType = attributesType;
    return this;
  }

  /** For `start` events: the static attributes of the new Live Activity. */
  setAttributes(attributes: JsonObject | null): this {
    this.attributes = attributes;
    return this;
  }

  /**
   * For `start` events (iOS 18+): asks the system to create an update push token for the new Live Activity
   * (`"input-push-token": 1`). The app receives the token and should send it to your server.
   */
  setInputPushToken(inputPushToken: boolean): this {
    this.inputPushToken = inputPushToken;
    return this;
  }

  /**
   * For `start` events (iOS 18+): subscribes the new Live Activity to updates broadcast on a channel
   * (`"input-push-channel"`). Create the channel first with `ApnsChannelManagementClient`.
   */
  setInputPushChannel(channelId: string | null): this {
    this.inputPushChannel = channelId;
    return this;
  }

  /**
   * Adds a custom top-level property, outside the `aps` dictionary.
   *
   * @throws TypeError if `key` is `aps`, which is reserved
   */
  addCustomProperty(key: string, value: unknown): this {
    if (key === "aps") {
      throw new TypeError("Custom property key must not be aps");
    }
    this.customProperties.set(key, value);
    return this;
  }

  /**
   * Builds the payload as a JSON string, or with a custom serializer.
   *
   * @throws TypeError if the payload is missing a key Apple requires for its event, or combines keys that conflict
   */
  build(serialize: (payload: JsonObject) => string = JSON.stringify): string {
    return serialize(this.buildPayloadObject());
  }

  private buildPayloadObject(): JsonObject {
    const { event } = this;
    if (event === null) {
      throw new TypeError("Live Activity payloads require an event (start, update or end).");
    }

    const hasAlert = this.alertTitle !== null || this.alertBody !== null;

    if (event === LiveActivityEvent.START) {
      if (this.attributesType === null || this.attributes === null) {
        throw new TypeError("Starting a Live Activity requires attributes-type and attributes.");
      }
      if (this.contentState === null) {
        throw new TypeError("Starting a Live Activity requires a content-state.");
      }
      if (!hasAlert) {
        throw new TypeError("Starting a Live Activity requires an alert.");
      }
      if (this.inputPushToken && this.inputPushChannel !== null) {
        throw new TypeError("Use either input-push-token or input-push-channel, not both.");
      }
    } else {
      if (this.attributesType !== null || this.attributes !== null) {
        throw new TypeError("attributes-type and attributes are only allowed when starting a Live Activity.");
      }
      if (this.inputPushToken || this.inputPushChannel !== null) {
        throw new TypeError("input-push-token and input-push-channel are only allowed when starting a Live Activity.");
      }
      if (event === LiveActivityEvent.UPDATE && this.contentState === null) {
        throw new TypeError("Updating a Live Activity requires a content-state.");
      }
    }

    if (this.dismissalDate !== null && event !== LiveActivityEvent.END) {
      throw new TypeError("dismissal-date is only allowed when ending a Live Activity.");
    }

    const aps: JsonObject = {
      timestamp: epochSeconds(this.timestamp ?? new Date()),
      event,
    };

    if (this.contentState !== null) aps["content-state"] = this.contentState;
    if (this.staleDate !== null) aps["stale-date"] = epochSeconds(this.staleDate);
    if (this.dismissalDate !== null) aps["dismissal-date"] = epochSeconds(this.dismissalDate);
    if (this.relevanceScore !== null) aps["relevance-score"] = this.relevanceScore;
    if (this.inputPushToken) aps["input-push-token"] = 1;
    if (this.inputPushChannel !== null) aps["input-push-channel"] = this.inputPushChannel;
    if (this.attributesType !== null) aps["attributes-type"] = this.attributesType;
    if (this.attributes !== null) aps["attributes"] = this.attributes;

    if (hasAlert || this.alertSound !== null) {
      const alert: JsonObject = {};
      if (this.alertTitle !== null) alert["title"] = alertTextToJson(this.alertTitle);
      if (this.alertBody !== null) alert["body"] = alertTextToJson(this.alertBody);
      if (this.alertSound !== null) alert["sound"] = this.alertSound;
      aps["alert"] = alert;
    }

    const payload: JsonObject = { aps };
    for (const [key, value] of this.customProperties) {
      payload[key] = value;
    }
    return payload;
  }
}

/**
 * A Live Activity update broadcast on a channel to every subscribed device (iOS 18+). Broadcasts can update and end
 * Live Activities, but not start them.
 *
 * @see https://developer.apple.com/documentation/usernotifications/sending-broadcast-push-notification-requests-to-apns
 */
export interface ApnsBroadcastNotification {
  /** The app's bundle ID, without any push type suffix. */
  readonly bundleId: string;
  /** The base64 channel ID returned when the channel was created. */
  readonly channelId: string;
  /** The payload (at most 5 KB), e.g. built with {@link LiveActivityPayloadBuilder}. */
  readonly payload: string;
  /**
   * When the notification stops being valid. Defaults to `0` (deliver once, don't store), the only value allowed on
   * channels created with `MessageStoragePolicy.NO_MESSAGE_STORED`.
   */
  readonly expiration?: Date | 0 | null | undefined;
  /** Defaults to {@link DeliveryPriority.IMMEDIATE}. */
  readonly priority?: DeliveryPriority | null | undefined;
  /** A canonical UUID identifying the request; APNs generates one when omitted. */
  readonly apnsRequestId?: string | null | undefined;
}

/** The APNs gateway's answer to a broadcast notification. */
export interface BroadcastNotificationResponse<T extends ApnsBroadcastNotification = ApnsBroadcastNotification> {
  readonly broadcastNotification: T;
  readonly accepted: boolean;
  readonly statusCode: number;
  /** The request ID that was sent, or the one APNs generated. */
  readonly apnsRequestId: string | null;
  /** A unique ID APNs assigns to accepted broadcasts; quote it when raising issues with Apple. */
  readonly apnsUniqueId: string | null;
  readonly rejectionReason: ApnsRejectionReason | (string & {}) | null;
}

const BROADCAST_PATH_PREFIX = "/4/broadcasts/apps/";

/** Builds the HTTP/2 request headers for a broadcast notification. */
export function buildBroadcastHeaders(notification: ApnsBroadcastNotification): OutgoingHttpHeaders {
  if (!notification.bundleId || notification.bundleId.includes("/")) {
    throw new TypeError(`Invalid bundle ID: ${notification.bundleId}`);
  }
  if (!notification.channelId) {
    throw new TypeError("Broadcast notifications require a channel ID.");
  }

  const headers: OutgoingHttpHeaders = {
    ":method": "POST",
    ":path": BROADCAST_PATH_PREFIX + notification.bundleId,
    "apns-channel-id": notification.channelId,
    "apns-push-type": PushType.LIVE_ACTIVITY,
    "apns-expiration": formatExpiration(notification.expiration ?? 0) ?? "0",
    "apns-priority": String(notification.priority ?? DeliveryPriority.IMMEDIATE),
  };
  if (notification.apnsRequestId != null) headers["apns-request-id"] = notification.apnsRequestId;
  return headers;
}

/** Interprets the gateway's reply to a broadcast notification. */
export function parseBroadcastResponse<T extends ApnsBroadcastNotification>(
  notification: T,
  response: ApnsRawResponse,
): BroadcastNotificationResponse<T> {
  const accepted = response.statusCode === 200;
  return {
    broadcastNotification: notification,
    accepted,
    statusCode: response.statusCode,
    apnsRequestId: headerValue(response.headers, "apns-request-id"),
    apnsUniqueId: headerValue(response.headers, "apns-unique-id"),
    rejectionReason: accepted ? null : parseErrorBody(response.body).reason,
  };
}
