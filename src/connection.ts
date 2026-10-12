import http2, { type ClientHttp2Session, type IncomingHttpHeaders, type OutgoingHttpHeaders } from "node:http2";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import type { AuthenticationTokenProvider } from "./auth/token-provider";
import { ApnsError, ConnectionTimeoutError, RefusedStreamError, StreamClosedBeforeReplyError } from "./errors";
import type { Logger } from "./logger";

/**
 * Opens the raw (pre-TLS) socket to the APNs server, e.g. through a proxy. The connection wraps the returned socket in
 * TLS itself.
 */
export type SocketFactory = (host: string, port: number) => Promise<Duplex>;

/** The TLS options a connection passes to `tls.connect`. */
export type ApnsTlsOptions = Pick<tls.ConnectionOptions, "ca" | "cert" | "key" | "pfx" | "passphrase">;

/**
 * Extra options for `tls.connect`, e.g. `ciphers`, `minVersion`, `secureContext`, `ca`, or `lookup` (custom DNS
 * resolution). Options that would weaken or break the connection (`rejectUnauthorized`, `checkServerIdentity`,
 * `servername`, `ALPNProtocols`) and the connection target are controlled by the client and cannot be overridden.
 */
export type ApnsTlsOverrides = Omit<
  tls.ConnectionOptions,
  "host" | "port" | "path" | "socket" | "servername" | "ALPNProtocols" | "rejectUnauthorized" | "checkServerIdentity"
>;

/**
 * Either fixed TLS overrides, or a function evaluated for every new connection. A function lets credentials or trusted
 * certificates rotate without recreating the client: new connections pick up whatever the function returns.
 */
export type ApnsTlsOverridesProvider = ApnsTlsOverrides | (() => ApnsTlsOverrides | Promise<ApnsTlsOverrides>);

/** A raw HTTP/2 response from an APNs server. */
export interface ApnsRawResponse {
  readonly statusCode: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

export interface ApnsConnectionOptions {
  host: string;
  port: number;
  tls: ApnsTlsOptions;
  tlsOverrides: ApnsTlsOverridesProvider | undefined;
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

const EXPIRED_PROVIDER_TOKEN_REASON = "ExpiredProviderToken";
const { NGHTTP2_REFUSED_STREAM } = http2.constants;

/** Reads a response header as a single string. */
export function headerValue(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/** Extracts `reason` and `timestamp` from an APNs error body; both are `null` if absent or unparseable. */
export function parseErrorBody(body: Buffer): { reason: string | null; timestamp: Date | null; parsed: boolean } {
  if (body.length === 0) return { reason: null, timestamp: null, parsed: false };
  try {
    const error = JSON.parse(body.toString("utf8")) as { reason?: unknown; timestamp?: unknown };
    return {
      reason: typeof error.reason === "string" ? error.reason : null,
      timestamp: typeof error.timestamp === "number" ? new Date(error.timestamp) : null,
      parsed: true,
    };
  } catch {
    return { reason: null, timestamp: null, parsed: false };
  }
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

    const enforcedTlsOptions: tls.ConnectionOptions = {
      ...(isIP(host) === 0 ? { servername: host } : {}),
      rejectUnauthorized: true,
      ...(options.hostnameVerification ? {} : { checkServerIdentity: () => undefined }),
    };

    let session: ClientHttp2Session | undefined;
    let rawSocket: Duplex | undefined;
    let tlsSocket: tls.TLSSocket | undefined;
    let abandoned = false;

    const attempt = (async () => {
      const overrides =
        typeof options.tlsOverrides === "function" ? await options.tlsOverrides() : (options.tlsOverrides ?? {});
      const tlsOptions: tls.ConnectionOptions = { ...options.tls, ...overrides, ...enforcedTlsOptions };

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
      // autoSelectFamily ("Happy Eyeballs") is the default from Node 20; enabling it keeps dual-stack hosts reachable
      // on Node 18 when the first address family returned by DNS does not work.
      const socket = tls.connect({
        ...tlsOptions,
        ...(rawSocket ? { socket: rawSocket } : { host, port, autoSelectFamily: true }),
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
   * Sends a request and resolves with the server's reply. Adds the provider token for token-based authentication.
   * Rejects if the stream closed before a reply arrived.
   *
   * @param body the request body, or `undefined` for requests without one
   * @param onWritten called once the request has been fully written to the connection
   */
  request(headers: OutgoingHttpHeaders, body: string | undefined, onWritten?: () => void): Promise<ApnsRawResponse> {
    if (!this.isUsable) {
      return Promise.reject(new ConnectionNotUsableError());
    }

    const { logger, tokenProvider } = this.options;
    const authenticationToken = tokenProvider?.getToken();
    const requestHeaders: OutgoingHttpHeaders = authenticationToken
      ? { ...headers, authorization: authenticationToken.authorizationHeader }
      : { ...headers };

    this.clearIdleTimer();
    this.inFlightCount++;

    return new Promise<ApnsRawResponse>((resolve, reject) => {
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
        stream = this.session.request(requestHeaders, { endStream: false });
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

        const response: ApnsRawResponse = {
          statusCode: Number(responseHeaders[":status"]),
          headers: responseHeaders,
          body: Buffer.concat(chunks),
        };
        settle(() => resolve(response));

        if (
          authenticationToken &&
          response.statusCode === 403 &&
          parseErrorBody(response.body).reason === EXPIRED_PROVIDER_TOKEN_REASON
        ) {
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

      if (body === undefined) {
        stream.end(() => onWritten?.());
      } else {
        stream.end(body, "utf8", () => onWritten?.());
      }
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
}
