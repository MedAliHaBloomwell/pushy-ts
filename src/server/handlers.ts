import type { IncomingHttpHeaders } from "node:http2";
import type { PeerCertificate } from "node:tls";
import { AuthenticationToken } from "../auth/authentication-token";
import type { ApnsVerificationKey } from "../auth/verification-key";
import { DeliveryPriority, PushType } from "../notification";
import { RejectionReason } from "../rejection-reason";

/** Thrown by a {@link PushNotificationHandler} to make the mock server reject a notification. */
export class RejectedNotificationError extends Error {
  constructor(readonly rejectionReason: RejectionReason) {
    super(`Notification rejected: ${rejectionReason.reason}`);
    this.name = new.target.name;
  }
}

/** Thrown by a {@link PushNotificationHandler} to reject a notification because its device token is unregistered. */
export class UnregisteredDeviceTokenError extends RejectedNotificationError {
  constructor(readonly deviceTokenExpirationTimestamp: Date) {
    super(RejectionReason.UNREGISTERED);
  }
}

/**
 * Decides whether the mock server accepts a notification. Return (or resolve) to accept it; throw a
 * {@link RejectedNotificationError} to reject it.
 */
export interface PushNotificationHandler {
  handlePushNotification(headers: IncomingHttpHeaders, payload: Buffer): void | Promise<void>;
}

/** Information about the client connection a handler is built for. */
export interface MockApnsSession {
  /** The verified client certificate for TLS-authenticated connections, or `null` for token-authenticated ones. */
  readonly clientCertificate: PeerCertificate | null;
}

/** Builds one {@link PushNotificationHandler} per client connection. */
export interface PushNotificationHandlerFactory {
  buildHandler(session: MockApnsSession): PushNotificationHandler;
}

/** A handler factory whose handlers accept every notification, as fast as possible. Useful for benchmarks. */
export class AcceptAllPushNotificationHandlerFactory implements PushNotificationHandlerFactory {
  buildHandler(): PushNotificationHandler {
    return { handlePushNotification: () => {} };
  }
}

type StringSetMap = Map<string, Set<string>> | Record<string, Iterable<string>>;
type DateMap = Map<string, Date> | Record<string, Date>;

export interface ValidatingPushNotificationHandlerFactoryOptions {
  /** The device tokens that may receive notifications for each topic. Notifications to other tokens are rejected. */
  deviceTokensByTopic?: StringSetMap | undefined;
  /** Device tokens that are no longer registered, with the time they stopped being valid. */
  expirationTimestampsByDeviceToken?: DateMap | undefined;
  /** For token-based authentication: the keys whose tokens the server accepts, and the topics each key may use. */
  verificationKeys?: Array<{ key: ApnsVerificationKey; topics: Iterable<string> }>;
}

const APNS_PATH_PREFIX = "/3/device/";
const DEVICE_TOKEN_PATTERN = /^[0-9a-fA-F]{64}$/;
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MAX_PAYLOAD_SIZE = 4096;
const MAX_COLLAPSE_ID_SIZE = 64;
const AUTHENTICATION_TOKEN_EXPIRATION_MS = 60 * 60_000;

const VALID_PRIORITIES = new Set<number>(Object.values(DeliveryPriority));
const VALID_PUSH_TYPES = new Set<string>(Object.values(PushType));

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function toStringSetMap(input: StringSetMap | undefined): Map<string, Set<string>> {
  const entries = input instanceof Map ? input.entries() : Object.entries(input ?? {});
  return new Map(Array.from(entries, ([key, values]) => [key, new Set(values)]));
}

function toDateMap(input: DateMap | undefined): Map<string, Date> {
  return input instanceof Map ? new Map(input) : new Map(Object.entries(input ?? {}));
}

abstract class ValidatingPushNotificationHandler implements PushNotificationHandler {
  constructor(
    private readonly deviceTokensByTopic: Map<string, Set<string>>,
    private readonly expirationTimestampsByDeviceToken: Map<string, Date>,
  ) {}

  handlePushNotification(headers: IncomingHttpHeaders, payload: Buffer): void {
    const apnsId = header(headers, "apns-id");
    if (apnsId !== undefined && !UUID_PATTERN.test(apnsId)) {
      throw new RejectedNotificationError(RejectionReason.BAD_MESSAGE_ID);
    }

    if (header(headers, ":method") !== "POST") {
      throw new RejectedNotificationError(RejectionReason.METHOD_NOT_ALLOWED);
    }

    const topic = header(headers, "apns-topic");
    if (topic === undefined) {
      throw new RejectedNotificationError(RejectionReason.MISSING_TOPIC);
    }

    const collapseId = header(headers, "apns-collapse-id");
    if (collapseId !== undefined && Buffer.byteLength(collapseId, "utf8") > MAX_COLLAPSE_ID_SIZE) {
      throw new RejectedNotificationError(RejectionReason.BAD_COLLAPSE_ID);
    }

    const priority = header(headers, "apns-priority");
    if (priority !== undefined && !VALID_PRIORITIES.has(Number(priority))) {
      throw new RejectedNotificationError(RejectionReason.BAD_PRIORITY);
    }

    const pushType = header(headers, "apns-push-type");
    if (pushType !== undefined && !VALID_PUSH_TYPES.has(pushType)) {
      throw new RejectedNotificationError(RejectionReason.INVALID_PUSH_TYPE);
    }

    const path = header(headers, ":path");
    if (path === APNS_PATH_PREFIX) {
      throw new RejectedNotificationError(RejectionReason.MISSING_DEVICE_TOKEN);
    } else if (path?.startsWith(APNS_PATH_PREFIX)) {
      const deviceToken = path.slice(APNS_PATH_PREFIX.length);
      if (!DEVICE_TOKEN_PATTERN.test(deviceToken)) {
        throw new RejectedNotificationError(RejectionReason.BAD_DEVICE_TOKEN);
      }

      const expirationTimestamp = this.expirationTimestampsByDeviceToken.get(deviceToken);
      if (expirationTimestamp !== undefined) {
        throw new UnregisteredDeviceTokenError(expirationTimestamp);
      }

      if (!this.deviceTokensByTopic.get(topic)?.has(deviceToken)) {
        throw new RejectedNotificationError(RejectionReason.DEVICE_TOKEN_NOT_FOR_TOPIC);
      }
    } else {
      throw new RejectedNotificationError(RejectionReason.BAD_PATH);
    }

    this.verifyAuthentication(headers);

    if (payload.length === 0) {
      throw new RejectedNotificationError(RejectionReason.PAYLOAD_EMPTY);
    }
    if (payload.length > MAX_PAYLOAD_SIZE) {
      throw new RejectedNotificationError(RejectionReason.PAYLOAD_TOO_LARGE);
    }
  }

  protected abstract verifyAuthentication(headers: IncomingHttpHeaders): void;
}

class TlsAuthenticationValidatingPushNotificationHandler extends ValidatingPushNotificationHandler {
  private readonly allowedTopics: Set<string>;

  constructor(
    deviceTokensByTopic: Map<string, Set<string>>,
    expirationTimestampsByDeviceToken: Map<string, Date>,
    baseTopic: string,
  ) {
    super(deviceTokensByTopic, expirationTimestampsByDeviceToken);
    this.allowedTopics = new Set([baseTopic, `${baseTopic}.voip`, `${baseTopic}.complication`]);
  }

  protected verifyAuthentication(headers: IncomingHttpHeaders): void {
    const topic = header(headers, "apns-topic");
    if (topic === undefined || !this.allowedTopics.has(topic)) {
      throw new RejectedNotificationError(RejectionReason.BAD_TOPIC);
    }
  }
}

class TokenAuthenticationValidatingPushNotificationHandler extends ValidatingPushNotificationHandler {
  private expectedTeamId: string | undefined;

  constructor(
    deviceTokensByTopic: Map<string, Set<string>>,
    expirationTimestampsByDeviceToken: Map<string, Date>,
    private readonly verificationKeysByKeyId: Map<string, ApnsVerificationKey>,
    private readonly topicsByVerificationKey: Map<ApnsVerificationKey, Set<string>>,
  ) {
    super(deviceTokensByTopic, expirationTimestampsByDeviceToken);
  }

  protected verifyAuthentication(headers: IncomingHttpHeaders): void {
    const authorization = header(headers, "authorization");
    if (authorization === undefined || !authorization.startsWith("bearer")) {
      throw new RejectedNotificationError(RejectionReason.MISSING_PROVIDER_TOKEN);
    }

    const encodedToken = authorization.slice("bearer".length).trim();
    if (encodedToken.length === 0) {
      throw new RejectedNotificationError(RejectionReason.MISSING_PROVIDER_TOKEN);
    }

    let token: AuthenticationToken;
    try {
      token = AuthenticationToken.parse(encodedToken);
    } catch {
      throw new RejectedNotificationError(RejectionReason.INVALID_PROVIDER_TOKEN);
    }

    const verificationKey = this.verificationKeysByKeyId.get(token.keyId);
    if (verificationKey === undefined || !token.verifySignature(verificationKey)) {
      throw new RejectedNotificationError(RejectionReason.INVALID_PROVIDER_TOKEN);
    }

    this.expectedTeamId ??= token.teamId;
    if (token.teamId !== this.expectedTeamId) {
      throw new RejectedNotificationError(RejectionReason.INVALID_PROVIDER_TOKEN);
    }

    if (Date.now() > token.issuedAt.getTime() + AUTHENTICATION_TOKEN_EXPIRATION_MS) {
      throw new RejectedNotificationError(RejectionReason.EXPIRED_PROVIDER_TOKEN);
    }

    const topic = header(headers, "apns-topic");
    if (topic === undefined) {
      throw new RejectedNotificationError(RejectionReason.MISSING_TOPIC);
    }
    if (!this.topicsByVerificationKey.get(verificationKey)?.has(topic)) {
      throw new RejectedNotificationError(RejectionReason.INVALID_PROVIDER_TOKEN);
    }
  }
}

/**
 * A handler factory whose handlers validate notifications the way the real APNs gateway does: headers, device
 * tokens, payload size and authentication. Connections that present a client certificate are validated with
 * TLS-based authentication (the allowed topics come from the certificate subject's `UID`); all others with
 * token-based authentication.
 */
export class ValidatingPushNotificationHandlerFactory implements PushNotificationHandlerFactory {
  private readonly deviceTokensByTopic: Map<string, Set<string>>;
  private readonly expirationTimestampsByDeviceToken: Map<string, Date>;
  private readonly verificationKeysByKeyId = new Map<string, ApnsVerificationKey>();
  private readonly topicsByVerificationKey = new Map<ApnsVerificationKey, Set<string>>();

  constructor(options: ValidatingPushNotificationHandlerFactoryOptions = {}) {
    this.deviceTokensByTopic = toStringSetMap(options.deviceTokensByTopic);
    this.expirationTimestampsByDeviceToken = toDateMap(options.expirationTimestampsByDeviceToken);

    for (const { key, topics } of options.verificationKeys ?? []) {
      this.verificationKeysByKeyId.set(key.keyId, key);
      this.topicsByVerificationKey.set(key, new Set(topics));
    }
  }

  buildHandler(session: MockApnsSession): PushNotificationHandler {
    if (session.clientCertificate) {
      const baseTopic = session.clientCertificate.subject?.["UID"];
      if (typeof baseTopic !== "string" || baseTopic.length === 0) {
        throw new TypeError("Client certificate does not specify a base topic.");
      }
      return new TlsAuthenticationValidatingPushNotificationHandler(
        this.deviceTokensByTopic,
        this.expirationTimestampsByDeviceToken,
        baseTopic,
      );
    }

    return new TokenAuthenticationValidatingPushNotificationHandler(
      this.deviceTokensByTopic,
      this.expirationTimestampsByDeviceToken,
      this.verificationKeysByKeyId,
      this.topicsByVerificationKey,
    );
  }
}
