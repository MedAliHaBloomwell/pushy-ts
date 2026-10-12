export { ApnsHttp2Client, type ApnsHttp2ClientOptions } from "./base-client";
export { ApnsClient, type ApnsClientCredentials, type ApnsClientOptions } from "./client";
export { ApnsClientBuilder } from "./client-builder";
export type { ApnsTlsOverrides, ApnsTlsOverridesProvider, SocketFactory } from "./connection";
export {
  ApnsChannelManagementClient,
  ChannelManagementError,
  MessageStoragePolicy,
  type ApnsChannelManagementClientOptions,
  type ChannelConfiguration,
  type ChannelManagementRequestOptions,
  type CreatedChannel,
} from "./channel-management";
export {
  LIVE_ACTIVITY_TOPIC_SUFFIX,
  LiveActivityPayloadBuilder,
  LiveActivityPushNotification,
  liveActivityTopic,
  type ApnsBroadcastNotification,
  type BroadcastNotificationResponse,
  type LiveActivityAlertText,
  type LiveActivityPriority,
} from "./live-activity";
export {
  ALTERNATE_APNS_PORT,
  DEFAULT_APNS_PORT,
  DEFAULT_CLOSE_AFTER_IDLE_MS,
  DEFAULT_EXPIRATION_PERIOD_MS,
  DEFAULT_TOKEN_EXPIRATION_MS,
  DEVELOPMENT_APNS_HOST,
  DEVELOPMENT_CHANNEL_MANAGEMENT_HOST,
  DEVELOPMENT_CHANNEL_MANAGEMENT_PORT,
  PRODUCTION_APNS_HOST,
  PRODUCTION_CHANNEL_MANAGEMENT_HOST,
  PRODUCTION_CHANNEL_MANAGEMENT_PORT,
} from "./constants";
export {
  ApnsError,
  ClientClosedError,
  ConnectionTimeoutError,
  PoolClosedError,
  RefusedStreamError,
  StreamClosedBeforeReplyError,
} from "./errors";
export type { Logger } from "./logger";
export type { ApnsClientMetricsListener } from "./metrics";
export {
  DeliveryPriority,
  PushType,
  SimpleApnsPushNotification,
  type ApnsPushNotification,
  type PushNotificationResponse,
} from "./notification";
export { httpConnectProxy, type HttpProxyOptions } from "./proxy";
export { RejectionReason, type ApnsRejectionReason } from "./rejection-reason";

export { AuthenticationToken } from "./auth/authentication-token";
export { ApnsSigningKey } from "./auth/signing-key";
export { ApnsVerificationKey } from "./auth/verification-key";

export {
  ApnsPayloadBuilder,
  DEFAULT_SOUND_FILENAME,
  InterruptionLevel,
  LiveActivityEvent,
} from "./util/payload-builder";
export { sanitizeTokenString, TokenUtil } from "./util/token-util";

export {
  AcceptAllPushNotificationHandlerFactory,
  RejectedNotificationError,
  UnregisteredDeviceTokenError,
  ValidatingPushNotificationHandlerFactory,
  type MockApnsSession,
  type PushNotificationHandler,
  type PushNotificationHandlerFactory,
  type ValidatingPushNotificationHandlerFactoryOptions,
} from "./server/handlers";
export { MockApnsServer, type MockApnsServerListener, type MockApnsServerOptions } from "./server/mock-apns-server";
