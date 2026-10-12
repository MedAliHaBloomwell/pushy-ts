import type { OutgoingHttpHeaders } from "node:http2";
import { ApnsHttp2Client, type ApnsHttp2ClientOptions } from "./base-client";
import { headerValue, parseErrorBody, type ApnsRawResponse } from "./connection";
import {
  DEVELOPMENT_CHANNEL_MANAGEMENT_HOST,
  DEVELOPMENT_CHANNEL_MANAGEMENT_PORT,
  PRODUCTION_CHANNEL_MANAGEMENT_HOST,
  PRODUCTION_CHANNEL_MANAGEMENT_PORT,
} from "./constants";
import { ApnsError } from "./errors";
import type { ApnsRejectionReason } from "./rejection-reason";

/** Whether APNs stores broadcasts for devices that are offline. Fixed when the channel is created. */
export const MessageStoragePolicy = {
  /** Nothing is stored; allows a higher publishing budget. Suited to frequent updates such as live scores. */
  NO_MESSAGE_STORED: 0,
  /** The most recent message is stored for up to 8 hours. Suited to infrequent updates such as flight status. */
  MOST_RECENT_MESSAGE_STORED: 1,
} as const;

export type MessageStoragePolicy = (typeof MessageStoragePolicy)[keyof typeof MessageStoragePolicy];

/** Raised when APNs rejects a channel management request. Rejections are permanent; don't retry them unchanged. */
export class ChannelManagementError extends ApnsError {
  constructor(
    readonly statusCode: number,
    readonly reason: ApnsRejectionReason | (string & {}) | null,
    readonly apnsRequestId: string | null,
  ) {
    super(`APNs rejected the channel management request with status ${statusCode}${reason ? ` (${reason})` : ""}.`);
  }
}

export interface ChannelManagementRequestOptions {
  /** A canonical UUID identifying the request; APNs generates one when omitted. */
  apnsRequestId?: string | undefined;
}

export interface CreatedChannel {
  /** The new channel's base64 ID. Share it with your app, and send broadcasts to it. */
  readonly channelId: string;
  readonly apnsRequestId: string | null;
}

export interface ChannelConfiguration {
  readonly channelId: string;
  readonly messageStoragePolicy: MessageStoragePolicy;
  /** The channel's push type; currently always `LiveActivity`. */
  readonly pushType: string;
  readonly apnsRequestId: string | null;
}

/**
 * Client options for {@link ApnsChannelManagementClient}. The port defaults to the one Apple uses for the given host
 * (2195 for development, 2196 for production).
 */
export type ApnsChannelManagementClientOptions = ApnsHttp2ClientOptions;

const CHANNEL_PUSH_TYPE = "LiveActivity";

function defaultPortFor(host: string): number {
  if (host === PRODUCTION_CHANNEL_MANAGEMENT_HOST) return PRODUCTION_CHANNEL_MANAGEMENT_PORT;
  if (host === DEVELOPMENT_CHANNEL_MANAGEMENT_HOST) return DEVELOPMENT_CHANNEL_MANAGEMENT_PORT;
  return 443;
}

function appPath(bundleId: string, resource: "channels" | "all-channels"): string {
  if (!bundleId || bundleId.includes("/")) {
    throw new TypeError(`Invalid bundle ID: ${bundleId}`);
  }
  return `/1/apps/${encodeURIComponent(bundleId)}/${resource}`;
}

/**
 * Manages the broadcast channels that Live Activities subscribe to (iOS 18+): create a channel per event, share its
 * ID with your app, send updates with `ApnsClient.sendBroadcastNotification`, and delete the channel when the event
 * is over. Apps can have up to 10,000 channels per environment, and channels can't be shared across environments.
 *
 * Channel management uses its own APNs hosts: `DEVELOPMENT_CHANNEL_MANAGEMENT_HOST` (port 2195) and
 * `PRODUCTION_CHANNEL_MANAGEMENT_HOST` (port 2196). Methods reject with {@link ChannelManagementError} when APNs
 * rejects a request, and with other errors when the request could not be sent.
 *
 * @see https://developer.apple.com/documentation/usernotifications/sending-channel-management-requests-to-apns
 */
export class ApnsChannelManagementClient extends ApnsHttp2Client {
  constructor(options: ApnsChannelManagementClientOptions) {
    super(options, defaultPortFor(options?.host));
  }

  /** Creates a channel and returns its ID. The storage policy cannot be changed later. */
  async createChannel(
    bundleId: string,
    options: ChannelManagementRequestOptions & { messageStoragePolicy: MessageStoragePolicy },
  ): Promise<CreatedChannel> {
    const response = await this.send(
      { ":method": "POST", ":path": appPath(bundleId, "channels") },
      options,
      JSON.stringify({ "message-storage-policy": options.messageStoragePolicy, "push-type": CHANNEL_PUSH_TYPE }),
      201,
    );

    const channelId = headerValue(response.headers, "apns-channel-id");
    if (!channelId) {
      throw new ApnsError("APNs created a channel but did not return its ID.");
    }
    return { channelId, apnsRequestId: headerValue(response.headers, "apns-request-id") };
  }

  /** Reads a channel's configuration. */
  async readChannel(
    bundleId: string,
    channelId: string,
    options: ChannelManagementRequestOptions = {},
  ): Promise<ChannelConfiguration> {
    const response = await this.send(
      { ":method": "GET", ":path": appPath(bundleId, "channels"), "apns-channel-id": channelId },
      options,
      undefined,
      200,
    );

    const body = JSON.parse(response.body.toString("utf8")) as Record<string, unknown>;
    return {
      channelId,
      messageStoragePolicy: body["message-storage-policy"] as MessageStoragePolicy,
      pushType: String(body["push-type"]),
      apnsRequestId: headerValue(response.headers, "apns-request-id"),
    };
  }

  /**
   * Deletes a channel. This can't be undone, and APNs may still deliver messages it already stored for the channel.
   */
  async deleteChannel(
    bundleId: string,
    channelId: string,
    options: ChannelManagementRequestOptions = {},
  ): Promise<{ apnsRequestId: string | null }> {
    const response = await this.send(
      { ":method": "DELETE", ":path": appPath(bundleId, "channels"), "apns-channel-id": channelId },
      options,
      undefined,
      204,
    );
    return { apnsRequestId: headerValue(response.headers, "apns-request-id") };
  }

  /** Lists the IDs of every active channel of an app. */
  async listChannels(
    bundleId: string,
    options: ChannelManagementRequestOptions = {},
  ): Promise<{ channels: string[]; apnsRequestId: string | null }> {
    const response = await this.send(
      { ":method": "GET", ":path": appPath(bundleId, "all-channels") },
      options,
      undefined,
      200,
    );

    const body = response.body.length > 0 ? (JSON.parse(response.body.toString("utf8")) as { channels?: unknown }) : {};
    const channels = Array.isArray(body.channels) ? body.channels.map(String) : [];
    return { channels, apnsRequestId: headerValue(response.headers, "apns-request-id") };
  }

  private async send(
    headers: OutgoingHttpHeaders,
    options: ChannelManagementRequestOptions,
    body: string | undefined,
    expectedStatus: number,
  ): Promise<ApnsRawResponse> {
    const requestHeaders = options.apnsRequestId ? { ...headers, "apns-request-id": options.apnsRequestId } : headers;
    const response = await this.request(requestHeaders, body);

    if (response.statusCode !== expectedStatus) {
      throw new ChannelManagementError(
        response.statusCode,
        parseErrorBody(response.body).reason,
        headerValue(response.headers, "apns-request-id"),
      );
    }
    return response;
  }
}
