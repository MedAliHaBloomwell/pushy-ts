/**
 * Reasons the APNs gateway gives for rejecting a notification, with the HTTP status Apple sends for each.
 *
 * @see https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns
 */
export const RejectionReason = {
  BAD_COLLAPSE_ID: { reason: "BadCollapseId", status: 400 },
  BAD_DEVICE_TOKEN: { reason: "BadDeviceToken", status: 400 },
  BAD_EXPIRATION_DATE: { reason: "BadExpirationDate", status: 400 },
  BAD_MESSAGE_ID: { reason: "BadMessageId", status: 400 },
  BAD_PRIORITY: { reason: "BadPriority", status: 400 },
  BAD_TOPIC: { reason: "BadTopic", status: 400 },
  DEVICE_TOKEN_NOT_FOR_TOPIC: { reason: "DeviceTokenNotForTopic", status: 400 },
  DUPLICATE_HEADERS: { reason: "DuplicateHeaders", status: 400 },
  IDLE_TIMEOUT: { reason: "IdleTimeout", status: 400 },
  INVALID_PUSH_TYPE: { reason: "InvalidPushType", status: 400 },
  MISSING_DEVICE_TOKEN: { reason: "MissingDeviceToken", status: 400 },
  MISSING_TOPIC: { reason: "MissingTopic", status: 400 },
  PAYLOAD_EMPTY: { reason: "PayloadEmpty", status: 400 },
  TOPIC_DISALLOWED: { reason: "TopicDisallowed", status: 400 },
  BAD_CERTIFICATE: { reason: "BadCertificate", status: 403 },
  BAD_CERTIFICATE_ENVIRONMENT: { reason: "BadCertificateEnvironment", status: 403 },
  EXPIRED_PROVIDER_TOKEN: { reason: "ExpiredProviderToken", status: 403 },
  FORBIDDEN: { reason: "Forbidden", status: 403 },
  INVALID_PROVIDER_TOKEN: { reason: "InvalidProviderToken", status: 403 },
  MISSING_PROVIDER_TOKEN: { reason: "MissingProviderToken", status: 403 },
  BAD_PATH: { reason: "BadPath", status: 404 },
  METHOD_NOT_ALLOWED: { reason: "MethodNotAllowed", status: 405 },
  EXPIRED_TOKEN: { reason: "ExpiredToken", status: 410 },
  UNREGISTERED: { reason: "Unregistered", status: 410 },
  PAYLOAD_TOO_LARGE: { reason: "PayloadTooLarge", status: 413 },
  TOO_MANY_PROVIDER_TOKEN_UPDATES: { reason: "TooManyProviderTokenUpdates", status: 429 },
  TOO_MANY_REQUESTS: { reason: "TooManyRequests", status: 429 },
  INTERNAL_SERVER_ERROR: { reason: "InternalServerError", status: 500 },
  SERVICE_UNAVAILABLE: { reason: "ServiceUnavailable", status: 503 },
  SHUTDOWN: { reason: "Shutdown", status: 503 },
} as const;

export type RejectionReason = (typeof RejectionReason)[keyof typeof RejectionReason];

/** The `reason` string of any rejection APNs is known to send. */
export type ApnsRejectionReason = RejectionReason["reason"];
