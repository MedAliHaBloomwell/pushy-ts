import type { PushNotificationResponse } from "./notification";

/**
 * Receives metrics describing the behavior and performance of an `ApnsClient`. Every method is optional; implement
 * only the ones you need. Listeners are called synchronously and must not throw or block.
 */
export interface ApnsClientMetricsListener {
  /** A notification could not be written to the APNs gateway (the send promise rejected). */
  handleWriteFailure?(topic: string): void;
  /** A notification was written to the APNs gateway. */
  handleNotificationSent?(topic: string): void;
  /** The gateway accepted or rejected a notification; `durationMs` is measured from the call to `sendNotification`. */
  handleNotificationAcknowledged?(response: PushNotificationResponse, durationMs: number): void;
  /** A new connection to the gateway was opened and added to the pool. */
  handleConnectionAdded?(): void;
  /** A connection was closed and removed from the pool. */
  handleConnectionRemoved?(): void;
  /** An attempt to open a new connection failed. */
  handleConnectionCreationFailed?(): void;
}
