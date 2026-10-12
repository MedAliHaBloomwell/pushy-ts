/** The hostname for the production APNs gateway. */
export const PRODUCTION_APNS_HOST = "api.push.apple.com";

/** The hostname for the development (sandbox) APNs gateway. */
export const DEVELOPMENT_APNS_HOST = "api.sandbox.push.apple.com";

/** The default (HTTPS) port for communication with the APNs gateway. */
export const DEFAULT_APNS_PORT = 443;

/**
 * An alternative port for communication with the APNs gateway. Apple allows port 2197 so that APNs traffic can be
 * allowed through a firewall that otherwise blocks HTTPS traffic.
 */
export const ALTERNATE_APNS_PORT = 2197;

/** The default idle time, in milliseconds, after which a client closes a connection (which may be reopened later). */
export const DEFAULT_CLOSE_AFTER_IDLE_MS = 60_000;

/**
 * The default lifetime, in milliseconds, of authentication tokens for token-based authentication. APNs treats tokens
 * as expired after 60 minutes and rejects refreshes more frequent than every 20 minutes; 50 minutes sits safely
 * between the two.
 */
export const DEFAULT_TOKEN_EXPIRATION_MS = 50 * 60_000;

/** The default lifetime of notifications created with {@link SimpleApnsPushNotification}: one day. */
export const DEFAULT_EXPIRATION_PERIOD_MS = 24 * 60 * 60_000;
