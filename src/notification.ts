import { DEFAULT_EXPIRATION_PERIOD_MS } from "./constants";
import type { ApnsRejectionReason } from "./rejection-reason";

/**
 * The type of a push notification, sent as the `apns-push-type` header. Apple requires this header for watchOS 6+
 * and recommends it for all platforms.
 */
export const PushType = {
  ALERT: "alert",
  BACKGROUND: "background",
  VOIP: "voip",
  COMPLICATION: "complication",
  FILEPROVIDER: "fileprovider",
  MDM: "mdm",
  LOCATION: "location",
  LIVE_ACTIVITY: "liveactivity",
  PUSH_TO_TALK: "pushtotalk",
} as const;

export type PushType = (typeof PushType)[keyof typeof PushType];

/** The priority with which APNs should deliver a notification, sent as the `apns-priority` header. */
export const DeliveryPriority = {
  /** Deliver immediately. */
  IMMEDIATE: 10,
  /** Deliver at a time that takes the device's power considerations into account. */
  CONSERVE_POWER: 5,
  /** Prioritize the device's power considerations over all other factors; never wake the device. */
  DO_NOT_AWAKEN: 1,
} as const;

export type DeliveryPriority = (typeof DeliveryPriority)[keyof typeof DeliveryPriority];

/** A push notification to be sent to the APNs gateway. Any object of this shape can be sent. */
export interface ApnsPushNotification {
  /** The hex-encoded token of the destination device. */
  readonly token: string;
  /** The JSON payload of the notification, e.g. built with `ApnsPayloadBuilder`. */
  readonly payload: string;
  /** The topic to which the notification is sent; usually the app's bundle ID (plus `.voip` etc. for some types). */
  readonly topic: string;
  /**
   * When the notification stops being valid. If omitted, no `apns-expiration` header is sent and APNs applies its own
   * storage policy. Pass `0` to ask APNs to attempt delivery once and not store the notification.
   */
  readonly expiration?: Date | 0 | null | undefined;
  /** The delivery priority; APNs defaults to {@link DeliveryPriority.IMMEDIATE} when omitted. */
  readonly priority?: DeliveryPriority | null | undefined;
  /** The push type, sent as the `apns-push-type` header. */
  readonly pushType?: PushType | null | undefined;
  /** An identifier APNs uses to coalesce several notifications into one; at most 64 bytes. */
  readonly collapseId?: string | null | undefined;
  /** A canonical UUID identifying the notification; APNs generates one when omitted. */
  readonly apnsId?: string | null | undefined;
}

/**
 * The APNs gateway's answer to a notification. A rejection is permanent: the same notification should not be sent
 * again without changes.
 */
export interface PushNotificationResponse<T extends ApnsPushNotification = ApnsPushNotification> {
  /** The notification that was sent. */
  readonly pushNotification: T;
  /** `true` if the gateway accepted the notification, `false` if it rejected it. */
  readonly accepted: boolean;
  /** The HTTP status code of the gateway's response. */
  readonly statusCode: number;
  /** The `apns-id` the gateway assigned to (or echoed for) the notification. */
  readonly apnsId: string | null;
  /** The `apns-unique-id` the development gateway assigns so notifications can be looked up in Apple's console. */
  readonly apnsUniqueId: string | null;
  /** Why the gateway rejected the notification, or `null` if it was accepted. */
  readonly rejectionReason: ApnsRejectionReason | (string & {}) | null;
  /**
   * For notifications rejected because the device token is no longer valid, the time at which APNs confirmed the
   * token stopped being valid for the topic. Stop sending to the token if it has not been re-registered since.
   */
  readonly tokenInvalidationTimestamp: Date | null;
}

/**
 * A simple, immutable push notification with the same defaults as Pushy's `SimpleApnsPushNotification`: it expires
 * one day after creation and is delivered with {@link DeliveryPriority.IMMEDIATE} priority.
 */
export class SimpleApnsPushNotification implements ApnsPushNotification {
  readonly token: string;
  readonly topic: string;
  readonly payload: string;
  readonly expiration: Date | 0 | null;
  readonly priority: DeliveryPriority | null;
  readonly pushType: PushType | null;
  readonly collapseId: string | null;
  readonly apnsId: string | null;

  constructor(
    token: string,
    topic: string,
    payload: string,
    options: {
      expiration?: Date | 0 | null | undefined;
      priority?: DeliveryPriority | null | undefined;
      pushType?: PushType | null | undefined;
      collapseId?: string | null | undefined;
      apnsId?: string | null | undefined;
    } = {},
  ) {
    if (token == null) throw new TypeError("Destination device token must not be null.");
    if (topic == null) throw new TypeError("Destination topic must not be null.");
    if (payload == null) throw new TypeError("Payload must not be null.");

    this.token = token;
    this.topic = topic;
    this.payload = payload;
    this.expiration =
      options.expiration !== undefined ? options.expiration : new Date(Date.now() + DEFAULT_EXPIRATION_PERIOD_MS);
    this.priority = options.priority !== undefined ? options.priority : DeliveryPriority.IMMEDIATE;
    this.pushType = options.pushType ?? null;
    this.collapseId = options.collapseId ?? null;
    this.apnsId = options.apnsId ?? null;
  }

  toString(): string {
    return `SimpleApnsPushNotification{token='${this.token}', payload='${this.payload}', expiration=${
      this.expiration instanceof Date ? this.expiration.toISOString() : this.expiration
    }, priority=${this.priority}, pushType=${this.pushType}, topic='${this.topic}', collapseId='${
      this.collapseId
    }', apnsId=${this.apnsId}}`;
  }
}
