import http2, { type ClientHttp2Session, type IncomingHttpHeaders, type OutgoingHttpHeaders } from "node:http2";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import type { AuthenticationTokenProvider } from "./auth/token-provider";
import { ApnsError, ConnectionTimeoutError, RefusedStreamError, StreamClosedBeforeReplyError } from "./errors";
import type { Logger } from "./logger";
import type { ApnsPushNotification, PushNotificationResponse } from "./notification";

/**
 * Opens the raw (pre-TLS) socket to the APNs server, e.g. through a proxy. The connection wraps the returned socket in
 * TLS itself.
 */
export type SocketFactory = (host: string, port: number) => Promise<Duplex>;

/** The TLS options a connection passes to `tls.connect`. */
export type ApnsTlsOptions = Pick<tls.ConnectionOptions, "ca" | "cert" | "key" | "pfx" | "passphrase">;

export interface ApnsConnectionOptions {
  host: string;
  port: number;
  tls: ApnsTlsOptions;
  hostnameVerification: boolean;
  connectionTimeoutMs: number | undefined;
  closeAfterIdleMs: number;
  gracefulShutdownTimeoutMs: number | undefined;
  tokenProvider: AuthenticationTokenProvider | undefined;
  socketFactory: SocketFactory | undefined;
  logger: Logger;
}

/** Raised when a connection can no longer accept new streams; nothing was sent, so the client retries elsewhere. */
export class ConnectionNotUsableError extends ApnsError {
  constructor() {
    super("Connection is closing and can no longer send notifications.");
  }
}

const APNS_PATH_PREFIX = "/3/device/";
const EXPIRED_PROVIDER_TOKEN_REASON = "ExpiredProviderToken";
const { NGHTTP2_REFUSED_STREAM } = http2.constants;

function headerValue(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * A single HTTP/2 connection to the APNs gateway. Notifications are multiplexed over the connection as concurrent
 * streams; the server's `SETTINGS_MAX_CONCURRENT_STREAMS` limit is enforced by the HTTP/2 implementation, which queues
 * streams beyond the limit.
 */
export class ApnsConnection {
  private closing = false;
  private closed = false;
  private inFlightCount = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private closePromise: Promise<void> | undefined;
  private readonly closedPromise: Promise<void>;
  private readonly closeListeners: Array<() => void> = [];

  private constructor(
    private readonly session: ClientHttp2Session,
    private readonly options: ApnsConnectionOptions,
  ) {
    const { logger } = options;

    this.closedPromise = new Promise((resolve) => {
      const onClose = () => {
        this.closed = true;
        this.clearIdleTimer();
        logger.debug("APNs connection closed.");
        for (const listener of this.closeListeners.splice(0)) listener();
        resolve();
      };
      if (session.closed && session.destroyed) onClose();
      else session.once("close", onClose);
    });

    session.on("error", (error: Error) => logger.debug("APNs connection error.", error));
    session.on("remoteSettings", (settings) => logger.debug("Received settings from APNs gateway.", settings));
    session.on("goaway", (errorCode: number, lastStreamId: number, opaqueData?: Buffer) => {
      logger.info(
        `Received GOAWAY from APNs server (error code ${errorCode}, last stream ${lastStreamId}): ${
          opaqueData?.toString("utf8") ?? ""
        }`,
      );
      void this.close();
    });

    this.armIdleTimer();
  }

  /** Opens a connection and resolves once the server's first SETTINGS frame has arrived. */
  static async connect(options: ApnsConnectionOptions): Promise<ApnsConnection> {
    const { host, port, connectionTimeoutMs } = options;
    const authority = `https://${isIP(host) === 6 ? `[${host}]` : host}:${port}`;

    const tlsOptions: tls.ConnectionOptions = {
      ...options.tls,
      ...(isIP(host) === 0 ? { servername: host } : {}),
      rejectUnauthorized: true,
      ...(options.hostnameVerification ? {} : { checkServerIdentity: () => undefined }),
    };

    let session: ClientHttp2Session | undefined;
    let rawSocket: Duplex | undefined;
    let tlsSocket: tls.TLSSocket | undefined;
    let abandoned = false;

    const attempt = (async () => {
      if (options.socketFactory) {
        rawSocket = await options.socketFactory(host, port);
        if (abandoned) {
          rawSocket.destroy();
          throw new ConnectionTimeoutError(connectionTimeoutMs ?? 0);
        }
      }

      // The connection owns its TLS socket rather than letting http2.connect create one: destroying a session that is
      // still handshaking does not reliably close the underlying socket (in Node or Bun), but destroying the socket
      // does.
      const socket = tls.connect({
        ...tlsOptions,
        ...(rawSocket ? { socket: rawSocket } : { host, port }),
        ALPNProtocols: ["h2"],
      });
      tlsSocket = socket;
      // Errors surface through the session; this keeps a late socket error (after the session has detached its own
      // listeners) from becoming an uncaught exception.
      socket.on("error", () => {});
      rawSocket?.on("error", () => {});

      const connectedSession = http2.connect(authority, {
        settings: { enablePush: false },
        createConnection: () => socket,
      });
      session = connectedSession;

      let lastError: unknown;
      connectedSession.on("error", (error) => {
        lastError = error;
      });

      await new Promise<void>((resolve, reject) => {
        const settle = (error?: unknown) => {
          connectedSession.off("remoteSettings", onSettings);
          connectedSession.off("error", onError);
          connectedSession.off("close", onClose);
          if (error === undefined) resolve();
          else reject(error);
        };
        const onSettings = () => settle();
        const onError = (error: unknown) => settle(error);
        const onClose = () => settle(lastError ?? new StreamClosedBeforeReplyError());
        connectedSession.once("remoteSettings", onSettings);
        connectedSession.once("error", onError);
        connectedSession.once("close", onClose);
      });

      if (abandoned) {
        connectedSession.destroy();
        throw new ConnectionTimeoutError(connectionTimeoutMs ?? 0);
      }

      return new ApnsConnection(connectedSession, options);
    })();

    if (!connectionTimeoutMs || connectionTimeoutMs <= 0) {
      return attempt;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abandoned = true;
        session?.destroy();
        tlsSocket?.destroy();
        rawSocket?.destroy();
        reject(new ConnectionTimeoutError(connectionTimeoutMs));
      }, connectionTimeoutMs);
    });
    attempt.catch(() => {});

    try {
      return await Promise.race([attempt, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** `true` while the connection can accept new notifications. */
  get isUsable(): boolean {
    return !this.closing && !this.closed && !this.session.closed && !this.session.destroyed;
  }

  /** The number of notifications sent on this connection that are still waiting for a reply. */
  get inFlight(): number {
    return this.inFlightCount;
  }

  /** Registers a listener that is called once when the connection has closed. */
  onClose(listener: () => void): void {
    if (this.closed) listener();
    else this.closeListeners.push(listener);
  }

  /**
   * Sends a notification and resolves with the server's reply. Rejects if the stream closed before a reply arrived.
   *
   * @param onWritten called once the notification has been fully written to the connection
   */
  send<T extends ApnsPushNotification>(notification: T, onWritten?: () => void): Promise<PushNotificationResponse<T>> {
    if (!this.isUsable) {
      return Promise.reject(new ConnectionNotUsableError());
    }

    const { logger, tokenProvider } = this.options;
    const authenticationToken = tokenProvider?.getToken();
    const headers = ApnsConnection.buildHeaders(notification);
    if (authenticationToken) {
      headers.authorization = authenticationToken.authorizationHeader;
    }

    this.clearIdleTimer();
    this.inFlightCount++;

    return new Promise<PushNotificationResponse<T>>((resolve, reject) => {
      let settled = false;
      const settle = (complete: () => void) => {
        if (settled) return;
        settled = true;
        this.inFlightCount--;
        this.armIdleTimer();
        complete();
      };

      let stream: http2.ClientHttp2Stream;
      try {
        stream = this.session.request(headers, { endStream: false });
      } catch (error) {
        settle(() => reject(this.isUsable ? error : new ConnectionNotUsableError()));
        return;
      }

      let responseHeaders: IncomingHttpHeaders | undefined;
      let streamError: unknown;
      const chunks: Buffer[] = [];

      stream.on("response", (receivedHeaders) => {
        responseHeaders = receivedHeaders;
      });
      stream.on("data", (chunk: Buffer | string) => {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      });
      stream.on("end", () => {
        if (!responseHeaders) return;

        const response = this.buildResponse(notification, responseHeaders, Buffer.concat(chunks));
        settle(() => resolve(response));

        if (authenticationToken && response.rejectionReason === EXPIRED_PROVIDER_TOKEN_REASON) {
          // Once APNs considers a connection's token expired, it "wedges" the connection; the only way forward is a
          // new token on a new connection.
          logger.warn("APNs server reports the authentication token has expired; closing connection.");
          tokenProvider?.invalidate(authenticationToken);
          void this.close();
        }
      });
      stream.on("error", (error) => {
        streamError = error;
      });
      stream.on("close", () => {
        if (settled) return;

        if (stream.rstCode === NGHTTP2_REFUSED_STREAM && !responseHeaders) {
          // The server reduced MAX_CONCURRENT_STREAMS while this stream was in flight; it was never processed.
          settle(() => reject(new RefusedStreamError()));
        } else {
          settle(() => reject(new StreamClosedBeforeReplyError({ cause: streamError })));
        }
      });

      stream.end(notification.payload, "utf8", () => onWritten?.());
    });
  }

  /**
   * Closes the connection gracefully: no new notifications are accepted, and notifications already in flight are
   * allowed to finish (up to the graceful shutdown timeout, if one was configured).
   */
  close(): Promise<void> {
    if (!this.closePromise) {
      this.closing = true;
      this.clearIdleTimer();

      if (!this.session.closed && !this.session.destroyed) {
        this.session.close();

        const { gracefulShutdownTimeoutMs } = this.options;
        if (gracefulShutdownTimeoutMs !== undefined && gracefulShutdownTimeoutMs >= 0) {
          const timer = setTimeout(() => this.session.destroy(), gracefulShutdownTimeoutMs);
          timer.unref?.();
          void this.closedPromise.then(() => clearTimeout(timer));
        }
      } else if (!this.session.destroyed) {
        this.session.destroy();
      }

      this.closePromise = this.closedPromise;
    }

    return this.closePromise;
  }

  private armIdleTimer(): void {
    const { closeAfterIdleMs, logger } = this.options;
    if (closeAfterIdleMs <= 0 || this.inFlightCount > 0 || this.closing || this.closed) return;

    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      logger.debug("Closing idle APNs connection.");
      void this.close();
    }, closeAfterIdleMs);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  static buildHeaders(notification: ApnsPushNotification): OutgoingHttpHeaders {
    const headers: OutgoingHttpHeaders = {
      ":method": "POST",
      ":path": APNS_PATH_PREFIX + notification.token,
    };

    const { expiration, collapseId, priority, pushType, topic, apnsId } = notification;

    if (expiration === 0) {
      headers["apns-expiration"] = "0";
    } else if (expiration instanceof Date) {
      headers["apns-expiration"] = String(Math.max(0, Math.floor(expiration.getTime() / 1000)));
    }
    if (collapseId != null) headers["apns-collapse-id"] = collapseId;
    if (priority != null) headers["apns-priority"] = String(priority);
    if (pushType != null) headers["apns-push-type"] = pushType;
    if (topic != null) headers["apns-topic"] = topic;
    if (apnsId != null) headers["apns-id"] = apnsId;

    return headers;
  }

  private buildResponse<T extends ApnsPushNotification>(
    notification: T,
    headers: IncomingHttpHeaders,
    body: Buffer,
  ): PushNotificationResponse<T> {
    const statusCode = Number(headers[":status"]);
    const apnsId = headerValue(headers, "apns-id");
    const apnsUniqueId = headerValue(headers, "apns-unique-id");

    if (statusCode === 200) {
      return {
        pushNotification: notification,
        accepted: true,
        statusCode,
        apnsId,
        apnsUniqueId,
        rejectionReason: null,
        tokenInvalidationTimestamp: null,
      };
    }

    let rejectionReason: string | null = null;
    let tokenInvalidationTimestamp: Date | null = null;

    if (body.length > 0) {
      try {
        const error = JSON.parse(body.toString("utf8")) as { reason?: unknown; timestamp?: unknown };
        if (typeof error.reason === "string") rejectionReason = error.reason;
        if (typeof error.timestamp === "number") tokenInvalidationTimestamp = new Date(error.timestamp);
      } catch {
        this.options.logger.error(`Failed to parse error response: ${body.toString("utf8")}`);
      }
    } else {
      this.options.logger.warn("Gateway sent an end-of-stream HEADERS frame for an unsuccessful notification.");
    }

    return {
      pushNotification: notification,
      accepted: false,
      statusCode,
      apnsId,
      apnsUniqueId,
      rejectionReason,
      tokenInvalidationTimestamp,
    };
  }
}
