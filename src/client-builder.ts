import { readFileSync } from "node:fs";
import type { ApnsSigningKey } from "./auth/signing-key";
import { ApnsClient, type ApnsClientCredentials, type ApnsClientOptions } from "./client";
import type { ApnsTlsOverridesProvider, SocketFactory } from "./connection";
import { DEFAULT_APNS_PORT } from "./constants";
import type { Logger } from "./logger";
import type { ApnsClientMetricsListener } from "./metrics";
import type { HttpProxyOptions } from "./proxy";

/**
 * A fluent builder for {@link ApnsClient}, mirroring Pushy's `ApnsClientBuilder`. Passing an options object to the
 * `ApnsClient` constructor is equivalent.
 *
 * Durations are in milliseconds.
 */
export class ApnsClientBuilder {
  private host: string | undefined;
  private port = DEFAULT_APNS_PORT;
  private readonly options: Partial<ApnsClientOptions> = {};

  /** Sets the host (and optionally port) of the APNs server, e.g. `DEVELOPMENT_APNS_HOST` or `PRODUCTION_APNS_HOST`. */
  setApnsServer(host: string, port: number = DEFAULT_APNS_PORT): this {
    this.host = host;
    this.port = port;
    return this;
  }

  /**
   * Sets TLS credentials from a PKCS#12 bundle, given as a file path or as the file's bytes. The bundle must contain a
   * certificate and private key. Clients may not have both TLS credentials and a signing key.
   */
  setClientCredentials(p12FileOrBytes: string | Uint8Array, p12Password: string): this;
  /** Sets TLS credentials from a certificate and private key in PEM format. */
  setClientCredentials(credentials: ApnsClientCredentials): this;
  setClientCredentials(credentials: string | Uint8Array | ApnsClientCredentials, p12Password?: string): this {
    if (typeof credentials === "string") {
      this.options.clientCredentials = { pfx: readFileSync(credentials), passphrase: p12Password ?? "" };
    } else if (credentials instanceof Uint8Array) {
      this.options.clientCredentials = { pfx: credentials, passphrase: p12Password ?? "" };
    } else {
      this.options.clientCredentials = credentials;
    }
    return this;
  }

  /** Sets the signing key for token-based authentication. Clients may not have both a signing key and TLS credentials. */
  setSigningKey(signingKey: ApnsSigningKey): this {
    this.options.signingKey = signingKey;
    return this;
  }

  /** Sets the lifetime of authentication tokens. Defaults to 50 minutes; change it only if Apple does. */
  setTokenExpiration(tokenExpirationMs: number): this {
    this.options.tokenExpirationMs = tokenExpirationMs;
    return this;
  }

  /**
   * Sets the certificates to trust for the server, as a path to a PEM file or as PEM data. If not set, the runtime's
   * root store is used.
   */
  setTrustedServerCertificateChain(pemFileOrData: string | Uint8Array | Array<string | Uint8Array>): this {
    this.options.trustedServerCertificates =
      typeof pemFileOrData === "string" && !pemFileOrData.includes("-----BEGIN")
        ? readFileSync(pemFileOrData)
        : pemFileOrData;
    return this;
  }

  /**
   * Sets extra `tls.connect` options (e.g. `ciphers`, `minVersion`, `secureContext`, or `lookup` for custom DNS), or a
   * function that computes them for each new connection, e.g. to pick up rotated certificates.
   */
  setTlsOptions(tlsOptions: ApnsTlsOverridesProvider): this {
    this.options.tlsOptions = tlsOptions;
    return this;
  }

  /** Enables or disables hostname verification. Enabled by default; disable it only for testing. */
  setHostnameVerificationEnabled(enabled: boolean): this {
    this.options.hostnameVerification = enabled;
    return this;
  }

  /** Sets the maximum number of concurrent connections to the server. Defaults to 1. */
  setConcurrentConnections(concurrentConnections: number): this {
    this.options.concurrentConnections = concurrentConnections;
    return this;
  }

  setMetricsListener(metricsListener: ApnsClientMetricsListener): this {
    this.options.metricsListener = metricsListener;
    return this;
  }

  /** Tunnels connections through an HTTP proxy using `CONNECT`. */
  setProxy(proxy: HttpProxyOptions): this {
    this.options.proxy = proxy;
    return this;
  }

  /** Opens raw sockets with a custom factory, e.g. for SOCKS proxies. */
  setSocketFactory(socketFactory: SocketFactory): this {
    this.options.socketFactory = socketFactory;
    return this;
  }

  setConnectionTimeout(timeoutMs: number): this {
    this.options.connectionTimeoutMs = timeoutMs;
    return this;
  }

  setCloseAfterIdleDuration(closeAfterIdleMs: number): this {
    this.options.closeAfterIdleMs = closeAfterIdleMs;
    return this;
  }

  setGracefulShutdownTimeout(gracefulShutdownTimeoutMs: number): this {
    this.options.gracefulShutdownTimeoutMs = gracefulShutdownTimeoutMs;
    return this;
  }

  setLogger(logger: Logger): this {
    this.options.logger = logger;
    return this;
  }

  /**
   * Builds a new client.
   *
   * @throws TypeError if no server was set, if neither TLS credentials nor a signing key were set, or if both were
   */
  build(): ApnsClient {
    if (this.host === undefined) {
      throw new TypeError("No APNs server address specified.");
    }
    return new ApnsClient({ ...this.options, host: this.host, port: this.port });
  }
}
