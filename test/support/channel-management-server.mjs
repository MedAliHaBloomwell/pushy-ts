// A fake APNs channel management server implementing Apple's documented API (create, read, delete, list), for tests.
// https://developer.apple.com/documentation/usernotifications/sending-channel-management-requests-to-apns
import { randomBytes, randomUUID } from "node:crypto";
import http2 from "node:http2";

const PATH_PATTERN = /^\/1\/apps\/([^/]+)\/(channels|all-channels)$/;

/**
 * Starts the server and resolves with `{ port, requests, close }`. `requests` records every request's headers and
 * body. `channels` maps bundle IDs to Map<channelId, messageStoragePolicy>.
 */
export async function startChannelManagementServer({ cert, key }) {
  const channels = new Map();
  const requests = [];
  const server = http2.createSecureServer({ cert, key });

  server.on("stream", (stream, headers) => {
    stream.on("error", () => {});
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ headers, body });

      const requestId = headers["apns-request-id"] ?? randomUUID();
      const reply = (status, extraHeaders = {}, json) => {
        if (stream.destroyed) return;
        const responseHeaders = { ":status": status, "apns-request-id": requestId, ...extraHeaders };
        if (json === undefined) {
          stream.respond(responseHeaders, { endStream: true });
        } else {
          stream.respond({ ...responseHeaders, "content-type": "application/json" });
          stream.end(JSON.stringify(json));
        }
      };
      const reject = (status, reason) => reply(status, {}, { reason });

      if (!String(headers.authorization ?? "").startsWith("bearer ")) return reject(403, "MissingProviderToken");

      const match = PATH_PATTERN.exec(String(headers[":path"]));
      if (!match) return reject(404, "BadPath");
      const [, bundleId, resource] = match;
      const appChannels = channels.get(bundleId) ?? new Map();
      channels.set(bundleId, appChannels);
      const method = headers[":method"];

      if (resource === "all-channels") {
        if (method !== "GET") return reject(405, "MethodNotAllowed");
        return reply(200, {}, { channels: [...appChannels.keys()] });
      }

      if (method === "POST") {
        let config;
        try {
          config = JSON.parse(body);
        } catch {
          return reject(400, "BadRequestPayload");
        }
        if (![0, 1].includes(config["message-storage-policy"]) || config["push-type"] !== "LiveActivity") {
          return reject(400, "BadRequestParams");
        }
        const channelId = randomBytes(16).toString("base64");
        appChannels.set(channelId, config["message-storage-policy"]);
        return reply(201, { "apns-channel-id": channelId });
      }

      const channelId = headers["apns-channel-id"];
      if (channelId === undefined) return reject(400, "MissingChannelId");
      if (!appChannels.has(channelId)) return reject(400, "ChannelNotRegistered");

      if (method === "GET") {
        return reply(200, {}, { "message-storage-policy": appChannels.get(channelId), "push-type": "LiveActivity" });
      }
      if (method === "DELETE") {
        appChannels.delete(channelId);
        return reply(204);
      }
      return reject(405, "MethodNotAllowed");
    });
  });

  const sessions = new Set();
  server.on("session", (session) => {
    sessions.add(session);
    session.on("close", () => sessions.delete(session));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    requests,
    channels,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        for (const session of sessions) session.close();
      }),
  };
}
