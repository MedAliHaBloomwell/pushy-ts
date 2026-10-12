import { randomUUID } from "node:crypto";
import http2, {
  type Http2SecureServer,
  type Http2Session,
  type IncomingHttpHeaders,
  type ServerHttp2Stream,
} from "node:http2";
import type { AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";
import { RejectionReason } from "../rejection-reason";
import {
  AcceptAllPushNotificationHandlerFactory,
  RejectedNotificationError,
  UnregisteredDeviceTokenError,
  type PushNotificationHandler,
  type PushNotificationHandlerFactory,
} from "./handlers";

/** Observes the notifications a {@link MockApnsServer} accepts and rejects, e.g. to make assertions in tests. */
export interface MockApnsServerListener {
  handlePushNotificationAccepted?(headers: IncomingHttpHeaders, payload: Buffer): void;
  handlePushNotificationRejected?(
    headers: IncomingHttpHeaders,
    payload: Buffer,
    rejectionReason: RejectionReason,
    deviceTokenExpirationTimestamp: Date | null,
  ): void;
}

type PemOrBytes = string | Uint8Array;

export interface MockApnsServerOptions {
  /** The server's certificate and private key (PEM), or a PKCS#12 bundle. */
  serverCredentials: { cert: PemOrBytes; key: PemOrBytes; passphrase?: string | undefined } | { pfx: PemOrBytes; passphrase?: string | undefined };
  /**
   * CA certificates (PEM) that issued the client certificates this server accepts. Set this to support TLS-based
   * client authentication; connections without a client certificate are still allowed and use token-based
   * authentication.
   */
  trustedClientCertificates?: PemOrBytes | PemOrBytes[] | undefined;
  /** Decides which notifications are accepted. Defaults to accepting everything. */
  handlerFactory?: PushNotificationHandlerFactory | undefined;
  listener?: MockApnsServerListener | undefined;
  /** Whether to include an `apns-unique-id` header in replies, as Apple's development gateway does. */
  generateApnsUniqueId?: boolean | undefined;
  /** The `SETTINGS_MAX_CONCURRENT_STREAMS` value advertised to clients. */
  maxConcurrentStreams?: number | undefined;
}

const MAX_CONTENT_LENGTH = 4096;

const toBuffer = (value: PemOrBytes) => (typeof value === "string" ? value : Buffer.from(value));

/**
 * A mock APNs server for integration tests and benchmarks. It speaks the same HTTP/2 protocol as the real gateway
 * and, with a {@link ValidatingPushNotificationHandlerFactory}, validates notifications the way the gateway does.
 *
 * @example
 * ```ts
 * const server = new MockApnsServer({ serverCredentials: { cert, key } });
 * const port = await server.start(0);
 * // ...point an ApnsClient at localhost:port, trusting the server's CA...
 * await server.shutdown();
 * ```
 */
export class MockApnsServer {
  private readonly server: Http2SecureServer;
  private readonly sessions = new Set<Http2Session>();
  private readonly handlers = new WeakMap<Http2Session, PushNotificationHandler>();
  private readonly handlerFactory: PushNotificationHandlerFactory;
  private readonly listener: MockApnsServerListener;
  private readonly generateApnsUniqueId: boolean;

  constructor(options: MockApnsServerOptions) {
    this.handlerFactory = options.handlerFactory ?? new AcceptAllPushNotificationHandlerFactory();
    this.listener = options.listener ?? {};
    this.generateApnsUniqueId = options.generateApnsUniqueId ?? false;

    const credentials = options.serverCredentials;
    const trusted = options.trustedClientCertificates;

    this.server = http2.createSecureServer({
      ...("pfx" in credentials
        ? { pfx: toBuffer(credentials.pfx) }
        : { cert: toBuffer(credentials.cert), key: toBuffer(credentials.key) }),
      ...(credentials.passphrase !== undefined ? { passphrase: credentials.passphrase } : {}),
      ...(trusted !== undefined
        ? {
            ca: Array.isArray(trusted) ? trusted.map(toBuffer) : toBuffer(trusted),
            requestCert: true,
            rejectUnauthorized: false,
          }
        : {}),
      settings: options.maxConcurrentStreams !== undefined ? { maxConcurrentStreams: options.maxConcurrentStreams } : {},
    });

    this.server.on("session", (session) => {
      this.sessions.add(session);
      session.once("close", () => this.sessions.delete(session));
      session.on("error", () => {});
    });
    this.server.on("stream", (stream, headers) => this.handleStream(stream as ServerHttp2Stream, headers));
  }

  /**
   * Starts listening and resolves with the bound port. Pass `0` (the default) to pick a free port.
   */
  start(port = 0, host?: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.server.off("error", reject);
        resolve((this.server.address() as AddressInfo).port);
      });
    });
  }

  /** The port the server is listening on. */
  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  /** Stops accepting connections, closes open connections gracefully, and resolves once everything has closed. */
  shutdown(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server.listening) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
      for (const session of this.sessions) {
        session.close();
      }
    });
  }

  private handlerFor(session: Http2Session): PushNotificationHandler {
    let handler = this.handlers.get(session);
    if (!handler) {
      const socket = session.socket as TLSSocket;
      const certificate = typeof socket.getPeerCertificate === "function" ? socket.getPeerCertificate() : null;
      const hasCertificate = certificate != null && Object.keys(certificate).length > 0;

      if (hasCertificate && !socket.authorized) {
        session.destroy(new Error(`Untrusted client certificate: ${String(socket.authorizationError)}`));
        throw new RejectedNotificationError(RejectionReason.BAD_CERTIFICATE);
      }

      handler = this.handlerFactory.buildHandler({ clientCertificate: hasCertificate ? certificate : null });
      this.handlers.set(session, handler);
    }
    return handler;
  }

  private handleStream(stream: ServerHttp2Stream, headers: IncomingHttpHeaders): void {
    const chunks: Buffer[] = [];
    let buffered = 0;

    stream.on("error", () => {});
    stream.on("data", (chunk: Buffer) => {
      // Keep reading past the size limit (so the stream completes), but stop buffering once over it.
      if (buffered <= MAX_CONTENT_LENGTH) {
        chunks.push(chunk);
        buffered += chunk.length;
      }
    });
    stream.on("end", () => {
      const payload = Buffer.concat(chunks);
      const requestApnsId = headers["apns-id"];
      const apnsId = typeof requestApnsId === "string" ? requestApnsId : randomUUID();

      void (async () => {
        try {
          await this.handlerFor(stream.session as Http2Session).handlePushNotification(headers, payload);
          this.respond(stream, { ":status": 200, "apns-id": apnsId });
          this.listener.handlePushNotificationAccepted?.(headers, payload);
        } catch (error) {
          const rejection =
            error instanceof RejectedNotificationError ? error.rejectionReason : RejectionReason.INTERNAL_SERVER_ERROR;
          const expiration = error instanceof UnregisteredDeviceTokenError ? error.deviceTokenExpirationTimestamp : null;

          this.respond(
            stream,
            { ":status": rejection.status, "apns-id": apnsId, "content-type": "application/json" },
            JSON.stringify({
              reason: rejection.reason,
              ...(expiration ? { timestamp: expiration.getTime() } : {}),
            }),
          );
          this.listener.handlePushNotificationRejected?.(headers, payload, rejection, expiration);
        }
      })();
    });
  }

  private respond(stream: ServerHttp2Stream, headers: Record<string, string | number>, body?: string): void {
    if (stream.destroyed || stream.closed) return;

    if (this.generateApnsUniqueId) {
      headers["apns-unique-id"] = randomUUID();
    }

    if (body === undefined) {
      stream.respond(headers, { endStream: true });
    } else {
      stream.respond(headers);
      stream.end(body);
    }
  }
}
