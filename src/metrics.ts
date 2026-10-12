import type { BroadcastNotificationResponse } from "./live-activity";
import type { PushNotificationResponse } from "./notification";

/**
 * Receives metrics describing the behavior and performance of an `ApnsClient`. Every method is optional; implement
 * only the ones you need. Listeners are called synchronously and must not throw or block.
 */
export interface ApnsClientMetricsListener {
  /** A notification could not be written to the APNs gateway (the send promise rejected). Broadcasts pass their bundle ID. */
  handleWriteFailure?(topic: string): void;
  /** A notification was written to the APNs gateway. Broadcasts pass their bundle ID as the topic. */
  handleNotificationSent?(topic: string): void;
  /** The gateway accepted or rejected a notification; `durationMs` is measured from the call to `sendNotification`. */
  handleNotificationAcknowledged?(response: PushNotificationResponse, durationMs: number): void;
  /** The gateway accepted or rejected a broadcast notification. */
  handleBroadcastNotificationAcknowledged?(response: BroadcastNotificationResponse, durationMs: number): void;
  /** A new connection to the gateway was opened and added to the pool. */
  handleConnectionAdded?(): void;
  /** A connection was closed and removed from the pool. */
  handleConnectionRemoved?(): void;
  /** An attempt to open a new connection failed. */
  handleConnectionCreationFailed?(): void;
}
