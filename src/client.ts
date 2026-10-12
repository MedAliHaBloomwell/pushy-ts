import type { ApnsSigningKey } from "./auth/signing-key";
import { AuthenticationTokenProvider } from "./auth/token-provider";
import { ApnsConnection, ConnectionNotUsableError, type ApnsTlsOptions, type SocketFactory } from "./connection";
import { DEFAULT_APNS_PORT, DEFAULT_CLOSE_AFTER_IDLE_MS, DEFAULT_TOKEN_EXPIRATION_MS } from "./constants";
import { ClientClosedError, PoolClosedError, RefusedStreamError } from "./errors";
import { noopLogger, type Logger } from "./logger";
import type { ApnsClientMetricsListener } from "./metrics";
import type { ApnsPushNotification, PushNotificationResponse } from "./notification";
import { ApnsConnectionPool } from "./pool";
import { httpConnectProxy, type HttpProxyOptions } from "./proxy";

/** TLS client credentials for certificate-based authentication: a PKCS#12 bundle, or a PEM certificate and key. */
export type ApnsClientCredentials =
  | { pfx: string | Uint8Array; passphrase?: string | undefined }
  | { cert: string | Uint8Array; key: string | Uint8Array; passphrase?: string | undefined };

export interface ApnsClientOptions {
  /** The APNs server to connect to, e.g. `PRODUCTION_APNS_HOST` or `DEVELOPMENT_APNS_HOST`. */
  host: string;
  /** Defaults to `DEFAULT_APNS_PORT` (443). APNs also listens on `ALTERNATE_APNS_PORT` (2197). */
  port?: number | undefined;

  /** Signing key for token-based authentication. Provide either this or `clientCredentials`, never both. */
  signingKey?: ApnsSigningKey | undefined;
  /** Lifetime of authentication tokens in milliseconds. Defaults to 50 minutes; change it only if Apple does. */
  tokenExpirationMs?: number | undefined;

  /** Client certificate and key for TLS-based authentication. Provide either this or `signingKey`, never both. */
  clientCredentials?: ApnsClientCredentials | undefined;

  /**
   * Certificates to trust for the server, in PEM format. Defaults to the runtime's root store. Useful for certificate
   * pinning or for connecting to a mock server.
   */
  trustedServerCertificates?: string | Uint8Array | Array<string | Uint8Array> | undefined;
  /** Whether to check that the server certificate matches the host name. Defaults to `true`; leave it on. */
  hostnameVerification?: boolean | undefined;

  /** The maximum number of connections the client keeps to the server. Defaults to 1. */
  concurrentConnections?: number | undefined;
  /** How long to wait for a connection to be established before giving up, in milliseconds. No limit by default. */
  connectionTimeoutMs?: number | undefined;
  /** Close connections that have been idle this long, in milliseconds (they reopen on demand). 0 disables. */
  closeAfterIdleMs?: number | undefined;
  /** How long `close()` waits for in-flight notifications before forcibly closing connections, in milliseconds. */
  gracefulShutdownTimeoutMs?: number | undefined;

  /** Tunnel connections through an HTTP proxy using `CONNECT`. */
  proxy?: HttpProxyOptions | undefined;
  /** Opens the raw socket to the server (e.g. through a SOCKS proxy). Takes precedence over `proxy`. */
  socketFactory?: SocketFactory | undefined;

  /** Receives metrics about the client's behavior and performance. */
  metricsListener?: ApnsClientMetricsListener | undefined;
  /** Receives log messages; `console` works. Silent by default. */
  logger?: Logger | undefined;
}

/** How often to retry a notification the server refused before processing (RST_STREAM with REFUSED_STREAM). */
const MAX_RETRIES_FOR_UNPROCESSED_NOTIFICATIONS = 3;

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
export class ApnsClient {
  private readonly pool: ApnsConnectionPool;
  private readonly metricsListener: ApnsClientMetricsListener;
  private readonly logger: Logger;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(options: ApnsClientOptions) {
    if (!options || typeof options.host !== "string" || options.host.length === 0) {
      throw new TypeError("No APNs server address specified.");
    }
    if (!options.signingKey && !options.clientCredentials) {
      throw new TypeError(
        "No client credentials specified; either TLS credentials (a certificate/private key) or an APNs signing key " +
          "must be provided before building a client.",
      );
    }
    if (options.signingKey && options.clientCredentials) {
      throw new TypeError("Clients may not have both a signing key and TLS credentials.");
    }

    const concurrentConnections = options.concurrentConnections ?? 1;
    if (!Number.isInteger(concurrentConnections) || concurrentConnections < 1) {
      throw new RangeError("concurrentConnections must be a positive integer.");
    }

    this.logger = options.logger ?? noopLogger;
    this.metricsListener = options.metricsListener ?? {};

    const tlsOptions: ApnsTlsOptions = {};
    if (options.trustedServerCertificates !== undefined) {
      tlsOptions.ca = toTlsValue(options.trustedServerCertificates);
    }
    if (options.clientCredentials) {
      const credentials = options.clientCredentials;
      if ("pfx" in credentials) {
        tlsOptions.pfx = toTlsValue(credentials.pfx);
      } else {
        tlsOptions.cert = toTlsValue(credentials.cert);
        tlsOptions.key = toTlsValue(credentials.key);
      }
      if (credentials.passphrase !== undefined) tlsOptions.passphrase = credentials.passphrase;
    }

    const tokenProvider = options.signingKey
      ? new AuthenticationTokenProvider(options.signingKey, options.tokenExpirationMs ?? DEFAULT_TOKEN_EXPIRATION_MS)
      : undefined;

    const socketFactory = options.socketFactory ?? (options.proxy ? httpConnectProxy(options.proxy) : undefined);

    const connectionOptions = {
      host: options.host,
      port: options.port ?? DEFAULT_APNS_PORT,
      tls: tlsOptions,
      hostnameVerification: options.hostnameVerification ?? true,
      connectionTimeoutMs: options.connectionTimeoutMs,
      closeAfterIdleMs: options.closeAfterIdleMs ?? DEFAULT_CLOSE_AFTER_IDLE_MS,
      gracefulShutdownTimeoutMs: options.gracefulShutdownTimeoutMs,
      tokenProvider,
      socketFactory,
      logger: this.logger,
    };

    this.pool = new ApnsConnectionPool(
      () => ApnsConnection.connect(connectionOptions),
      concurrentConnections,
      this.metricsListener,
      this.logger,
    );
  }

  /**
   * Sends a push notification to the APNs gateway.
   *
   * The returned promise resolves once the gateway has accepted or rejected the notification. Acceptance means the
   * notification may be delivered at some point; delivery is not guaranteed. Rejections are permanent, and the same
   * notification should not be sent again.
   *
   * The promise rejects if the notification could not be sent at all (e.g. the connection failed). Those failures are
   * generally temporary, and the notification may be sent again once the underlying problem is resolved.
   */
  async sendNotification<T extends ApnsPushNotification>(notification: T): Promise<PushNotificationResponse<T>> {
    if (this.closed) {
      throw new ClientClosedError();
    }

    const start = performance.now();

    try {
      const response = await this.sendWithRetries(notification);
      this.metricsListener.handleNotificationAcknowledged?.(response, performance.now() - start);
      return response;
    } catch (error) {
      this.metricsListener.handleWriteFailure?.(notification.topic);
      const closedUnderneath = error instanceof ConnectionNotUsableError || error instanceof PoolClosedError;
      throw this.closed && closedUnderneath ? new ClientClosedError() : error;
    }
  }

  /**
   * Gracefully shuts down the client, closing all connections. Notifications already sent to the server are allowed
   * to finish; notifications still waiting for a connection fail. Clients cannot be reused once closed.
   */
  close(): Promise<void> {
    if (!this.closePromise) {
      this.logger.info("Shutting down APNs client.");
      this.closed = true;
      this.closePromise = this.pool.close();
    }
    return this.closePromise;
  }

  /** `true` once {@link ApnsClient.close} has been called. */
  get isClosed(): boolean {
    return this.closed;
  }

  private async sendWithRetries<T extends ApnsPushNotification>(notification: T): Promise<PushNotificationResponse<T>> {
    for (let attempt = 0; ; attempt++) {
      const connection = await this.pool.acquire();

      try {
        return await connection.send(notification, () => this.metricsListener.handleNotificationSent?.(notification.topic));
      } catch (error) {
        const unprocessed = error instanceof RefusedStreamError || error instanceof ConnectionNotUsableError;
        if (unprocessed && !this.closed && attempt < MAX_RETRIES_FOR_UNPROCESSED_NOTIFICATIONS) {
          this.logger.debug("Notification was not processed by the server; retrying.", error);
          continue;
        }
        throw error;
      }
    }
  }
}

function toTlsValue(value: string | Uint8Array | Array<string | Uint8Array>): string | Buffer | Array<string | Buffer> {
  if (Array.isArray(value)) return value.map((item) => (typeof item === "string" ? item : Buffer.from(item)));
  return typeof value === "string" ? value : Buffer.from(value);
}
