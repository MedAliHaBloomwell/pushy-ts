/**
 * Base class for errors raised by this library. A promise returned by `ApnsClient.sendNotification` rejects only when
 * a notification could not be delivered to the APNs gateway; those failures are generally temporary and the
 * notification may be sent again. Notifications the gateway rejects resolve normally with `accepted: false`.
 */
export class ApnsError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Raised when sending a notification through a client that has been closed. */
export class ClientClosedError extends ApnsError {
  constructor() {
    super("Client has been closed and can no longer send push notifications.");
  }
}

/** Raised when the connection pool has been closed and no more connections may be acquired. */
export class PoolClosedError extends ApnsError {
  constructor() {
    super("Connection pool has closed and no more connections may be acquired.");
  }
}

/** Raised when a connection could not be established within the configured connection timeout. */
export class ConnectionTimeoutError extends ApnsError {
  constructor(timeoutMs: number) {
    super(`Timed out after ${timeoutMs} ms while connecting to the APNs server.`);
  }
}

/** Raised when an HTTP/2 stream (or its connection) closed before the APNs server replied. */
export class StreamClosedBeforeReplyError extends ApnsError {
  constructor(options?: { cause?: unknown }) {
    super("Stream closed before a reply was received.", options);
  }
}

/** Raised internally when the server refuses a stream (RST_STREAM REFUSED_STREAM); the client retries these. */
export class RefusedStreamError extends ApnsError {
  constructor() {
    super("The APNs server refused the stream before processing it.");
  }
}
