import { ApnsHttp2Client, type ApnsHttp2ClientOptions } from "./base-client";
import { DEFAULT_APNS_PORT } from "./constants";
import { ClientClosedError } from "./errors";
import {
  buildBroadcastHeaders,
  parseBroadcastResponse,
  type ApnsBroadcastNotification,
  type BroadcastNotificationResponse,
} from "./live-activity";
import {
  buildNotificationHeaders,
  parseNotificationResponse,
  type ApnsPushNotification,
  type PushNotificationResponse,
} from "./notification";

export type { ApnsClientCredentials } from "./base-client";

/** Options for {@link ApnsClient}. The port defaults to `DEFAULT_APNS_PORT` (443); APNs also listens on 2197. */
export type ApnsClientOptions = ApnsHttp2ClientOptions;

/**
 * An HTTP/2 client for the Apple Push Notification service. Clients are long-lived and safe to share: create one per
 * credential set at startup and reuse it for every notification.
 *
 * @example
 * ```ts
 * const client = new ApnsClient({
 *   host: DEVELOPMENT_APNS_HOST,
 *   signingKey: await ApnsSigningKey.loadFromPkcs8File("AuthKey_ABC123DEFG.p8", "TEAMID1234", "ABC123DEFG"),
 * });
 *
 * const response = await client.sendNotification({
 *   token: deviceToken,
 *   topic: "com.example.app",
 *   payload: new ApnsPayloadBuilder().setAlertBody("Hello!").build(),
 * });
 * ```
 */
export class ApnsClient extends ApnsHttp2Client {
  constructor(options: ApnsClientOptions) {
    super(options, DEFAULT_APNS_PORT);
  }

  /**
   * Sends a push notification to a device (or to a Live Activity push token; see `LiveActivityPushNotification`).
   *
   * The returned promise resolves once the gateway has accepted or rejected the notification. Acceptance means the
   * notification may be delivered at some point; delivery is not guaranteed. Rejections are permanent, and the same
   * notification should not be sent again.
   *
   * The promise rejects if the notification could not be sent at all (e.g. the connection failed). Those failures are
   * generally temporary, and the notification may be sent again once the underlying problem is resolved.
   */
  async sendNotification<T extends ApnsPushNotification>(notification: T): Promise<PushNotificationResponse<T>> {
    if (this.isClosed) {
      throw new ClientClosedError();
    }

    const start = performance.now();
    try {
      const response = parseNotificationResponse(
        notification,
        await this.request(buildNotificationHeaders(notification), notification.payload, () =>
          this.metricsListener.handleNotificationSent?.(notification.topic),
        ),
        this.logger,
      );
      this.metricsListener.handleNotificationAcknowledged?.(response, performance.now() - start);
      return response;
    } catch (error) {
      this.metricsListener.handleWriteFailure?.(notification.topic);
      throw error;
    }
  }

  /**
   * Broadcasts a Live Activity update to every device subscribed to a channel (iOS 18+). Create channels with
   * `ApnsChannelManagementClient`. Resolves and rejects like {@link ApnsClient.sendNotification}.
   *
   * @see https://developer.apple.com/documentation/usernotifications/sending-broadcast-push-notification-requests-to-apns
   */
  async sendBroadcastNotification<T extends ApnsBroadcastNotification>(
    notification: T,
  ): Promise<BroadcastNotificationResponse<T>> {
    if (this.isClosed) {
      throw new ClientClosedError();
    }

    const headers = buildBroadcastHeaders(notification);
    const start = performance.now();
    try {
      const response = parseBroadcastResponse(
        notification,
        await this.request(headers, notification.payload, () =>
          this.metricsListener.handleNotificationSent?.(notification.bundleId),
        ),
      );
      this.metricsListener.handleBroadcastNotificationAcknowledged?.(response, performance.now() - start);
      return response;
    } catch (error) {
      this.metricsListener.handleWriteFailure?.(notification.bundleId);
      throw error;
    }
  }
}
