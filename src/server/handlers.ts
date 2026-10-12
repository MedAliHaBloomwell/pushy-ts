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
  /**
   * For token-based authentication: the keys whose tokens the server accepts, and the topics each key may use. A
   * bundle ID also covers its push type topics, such as `<bundle ID>.push-type.liveactivity` and `<bundle ID>.voip`.
   */
  verificationKeys?: Array<{ key: ApnsVerificationKey; topics: Iterable<string> }> | undefined;
  /**
   * Broadcast channels (Live Activities, iOS 18+) that accept broadcasts. With a storage policy of
   * `MessageStoragePolicy.NO_MESSAGE_STORED` (0), broadcasts with a nonzero expiration are rejected, as on APNs.
   */
  broadcastChannels?: Array<{ bundleId: string; channelId: string; messageStoragePolicy?: 0 | 1 | undefined }> | undefined;
}

const APNS_PATH_PREFIX = "/3/device/";
const BROADCAST_PATH_PREFIX = "/4/broadcasts/apps/";
const DEVICE_TOKEN_PATTERN = /^[0-9a-fA-F]{64}$/;
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_PAYLOAD_SIZE = 4096;
const MAX_VOIP_PAYLOAD_SIZE = 5120;
const MAX_BROADCAST_PAYLOAD_SIZE = 5120;
const MAX_COLLAPSE_ID_SIZE = 64;

/** Topic suffixes Apple uses for push types; a bundle ID authorizes each of them. */
const TOPIC_SUFFIXES = [
  ".push-type.liveactivity",
  ".push-type.widgets",
  ".push-type.controls",
  ".push-type.accessory",
  ".pushkit.fileprovider",
  ".location-query",
  ".complication",
  ".voip-ptt",
  ".voip",
];

/** The bundle ID a topic belongs to, e.g. `com.example.app` for `com.example.app.push-type.liveactivity`. */
function baseTopic(topic: string): string {
  const suffix = TOPIC_SUFFIXES.find((candidate) => topic.endsWith(candidate));
  return suffix ? topic.slice(0, -suffix.length) : topic;
}

type BroadcastChannels = Map<string, Map<string, 0 | 1 | undefined>>;
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
    private readonly broadcastChannels: BroadcastChannels,
  ) {}

  handlePushNotification(headers: IncomingHttpHeaders, payload: Buffer): void {
    const path = header(headers, ":path");
    if (path?.startsWith(BROADCAST_PATH_PREFIX)) {
      this.handleBroadcast(headers, path.slice(BROADCAST_PATH_PREFIX.length), payload);
      return;
    }

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

      const registered =
        this.deviceTokensByTopic.get(topic)?.has(deviceToken) ||
        this.deviceTokensByTopic.get(baseTopic(topic))?.has(deviceToken);
      if (!registered) {
        throw new RejectedNotificationError(RejectionReason.DEVICE_TOKEN_NOT_FOR_TOPIC);
      }
    } else {
      throw new RejectedNotificationError(RejectionReason.BAD_PATH);
    }

    this.verifyAuthentication(headers, topic, null);

    if (payload.length === 0) {
      throw new RejectedNotificationError(RejectionReason.PAYLOAD_EMPTY);
    }
    if (payload.length > (pushType === PushType.VOIP ? MAX_VOIP_PAYLOAD_SIZE : MAX_PAYLOAD_SIZE)) {
      throw new RejectedNotificationError(RejectionReason.PAYLOAD_TOO_LARGE);
    }
  }

  /** Validates a broadcast the way APNs does: headers first, then authentication, then the channel. */
  private handleBroadcast(headers: IncomingHttpHeaders, bundleId: string, payload: Buffer): void {
    const requestId = header(headers, "apns-request-id");
    if (requestId !== undefined && !UUID_PATTERN.test(requestId)) {
      throw new RejectedNotificationError(RejectionReason.BAD_MESSAGE_ID);
    }

    if (header(headers, ":method") !== "POST") {
      throw new RejectedNotificationError(RejectionReason.METHOD_NOT_ALLOWED);
    }

    if (bundleId.length === 0 || bundleId.includes("/")) {
      throw new RejectedNotificationError(RejectionReason.BAD_PATH);
    }
    if (baseTopic(bundleId) !== bundleId) {
      throw new RejectedNotificationError(RejectionReason.TOPIC_DISALLOWED);
    }

    const pushType = header(headers, "apns-push-type");
    if (pushType === undefined) {
      throw new RejectedNotificationError(RejectionReason.MISSING_PUSH_TYPE);
    }
    if (pushType.toLowerCase() !== PushType.LIVE_ACTIVITY) {
      throw new RejectedNotificationError(RejectionReason.INVALID_PUSH_TYPE);
    }

    const channelId = header(headers, "apns-channel-id");
    if (channelId === undefined) {
      throw new RejectedNotificationError(RejectionReason.MISSING_CHANNEL_ID);
    }
    if (!BASE64_PATTERN.test(channelId)) {
      throw new RejectedNotificationError(RejectionReason.BAD_CHANNEL_ID);
    }

    const expiration = header(headers, "apns-expiration");
    if (expiration !== undefined && !/^\d+$/.test(expiration)) {
      throw new RejectedNotificationError(RejectionReason.BAD_EXPIRATION_DATE);
    }

    const priority = header(headers, "apns-priority");
    if (priority !== undefined && !VALID_PRIORITIES.has(Number(priority))) {
      throw new RejectedNotificationError(RejectionReason.BAD_PRIORITY);
    }

    this.verifyAuthentication(headers, bundleId, RejectionReason.TOPIC_MISMATCH);

    const channels = this.broadcastChannels.get(bundleId);
    if (!channels?.has(channelId)) {
      throw new RejectedNotificationError(RejectionReason.CHANNEL_NOT_REGISTERED);
    }
    if (channels.get(channelId) === 0 && expiration !== undefined && expiration !== "0") {
      throw new RejectedNotificationError(RejectionReason.BAD_EXPIRATION_DATE);
    }

    if (payload.length === 0) {
      throw new RejectedNotificationError(RejectionReason.PAYLOAD_EMPTY);
    }
    if (payload.length > MAX_BROADCAST_PAYLOAD_SIZE) {
      throw new RejectedNotificationError(RejectionReason.PAYLOAD_TOO_LARGE);
    }
  }

  /**
   * Checks the request's credentials and that they cover `topic`.
   *
   * @param topicMismatch the rejection for credentials that don't cover the topic, or `null` for the handler's default
   */
  protected abstract verifyAuthentication(
    headers: IncomingHttpHeaders,
    topic: string,
    topicMismatch: RejectionReason | null,
  ): void;
}

class TlsAuthenticationValidatingPushNotificationHandler extends ValidatingPushNotificationHandler {
  private readonly allowedTopics: Set<string>;

  constructor(
    deviceTokensByTopic: Map<string, Set<string>>,
    expirationTimestampsByDeviceToken: Map<string, Date>,
    broadcastChannels: BroadcastChannels,
    certificateTopic: string,
  ) {
    super(deviceTokensByTopic, expirationTimestampsByDeviceToken, broadcastChannels);
    this.allowedTopics = new Set([certificateTopic, `${certificateTopic}.voip`, `${certificateTopic}.complication`]);
  }

  protected verifyAuthentication(
    _headers: IncomingHttpHeaders,
    topic: string,
    topicMismatch: RejectionReason | null,
  ): void {
    if (!this.allowedTopics.has(topic)) {
      throw new RejectedNotificationError(topicMismatch ?? RejectionReason.BAD_TOPIC);
    }
  }
}

class TokenAuthenticationValidatingPushNotificationHandler extends ValidatingPushNotificationHandler {
  private expectedTeamId: string | undefined;

  constructor(
    deviceTokensByTopic: Map<string, Set<string>>,
    expirationTimestampsByDeviceToken: Map<string, Date>,
    broadcastChannels: BroadcastChannels,
    private readonly verificationKeysByKeyId: Map<string, ApnsVerificationKey>,
    private readonly topicsByVerificationKey: Map<ApnsVerificationKey, Set<string>>,
  ) {
    super(deviceTokensByTopic, expirationTimestampsByDeviceToken, broadcastChannels);
  }

  protected verifyAuthentication(
    headers: IncomingHttpHeaders,
    topic: string,
    topicMismatch: RejectionReason | null,
  ): void {
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

    const allowedTopics = this.topicsByVerificationKey.get(verificationKey);
    if (!allowedTopics?.has(topic) && !allowedTopics?.has(baseTopic(topic))) {
      throw new RejectedNotificationError(topicMismatch ?? RejectionReason.INVALID_PROVIDER_TOKEN);
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
  private readonly broadcastChannels: BroadcastChannels = new Map();

  constructor(options: ValidatingPushNotificationHandlerFactoryOptions = {}) {
    this.deviceTokensByTopic = toStringSetMap(options.deviceTokensByTopic);
    this.expirationTimestampsByDeviceToken = toDateMap(options.expirationTimestampsByDeviceToken);

    for (const { bundleId, channelId, messageStoragePolicy } of options.broadcastChannels ?? []) {
      const channels = this.broadcastChannels.get(bundleId) ?? new Map<string, 0 | 1 | undefined>();
      channels.set(channelId, messageStoragePolicy);
      this.broadcastChannels.set(bundleId, channels);
    }

    for (const { key, topics } of options.verificationKeys ?? []) {
      this.verificationKeysByKeyId.set(key.keyId, key);
      this.topicsByVerificationKey.set(key, new Set(topics));
    }
  }

  buildHandler(session: MockApnsSession): PushNotificationHandler {
    if (session.clientCertificate) {
      const certificateTopic = session.clientCertificate.subject?.["UID"];
      if (typeof certificateTopic !== "string" || certificateTopic.length === 0) {
        throw new TypeError("Client certificate does not specify a base topic.");
      }
      return new TlsAuthenticationValidatingPushNotificationHandler(
        this.deviceTokensByTopic,
        this.expirationTimestampsByDeviceToken,
        this.broadcastChannels,
        certificateTopic,
      );
    }

    return new TokenAuthenticationValidatingPushNotificationHandler(
      this.deviceTokensByTopic,
      this.expirationTimestampsByDeviceToken,
      this.broadcastChannels,
      this.verificationKeysByKeyId,
      this.topicsByVerificationKey,
    );
  }
}
