import { connect, type Socket } from "node:net";
import type { SocketFactory } from "./connection";
import { ApnsError } from "./errors";

export interface HttpProxyOptions {
  host: string;
  port: number;
  username?: string | undefined;
  password?: string | undefined;
  /** Extra headers to send with the `CONNECT` request. */
  headers?: Record<string, string> | undefined;
}

const MAX_RESPONSE_HEADER_BYTES = 16 * 1024;

/**
 * Creates a socket factory that tunnels connections through an HTTP proxy with the `CONNECT` method. Pass the result
 * as the client's `socketFactory`, or use the `proxy` client option, which does this for you.
 *
 * For SOCKS proxies, supply your own `socketFactory`, e.g. built on the `socks` package.
 */
export function httpConnectProxy(proxy: HttpProxyOptions): SocketFactory {
  return (host, port) =>
    new Promise<Socket>((resolve, reject) => {
      const target = `${host.includes(":") ? `[${host}]` : host}:${port}`;
      const socket = connect(proxy.port, proxy.host);
      let received = Buffer.alloc(0);

      const fail = (error: Error) => {
        socket.off("data", onData);
        socket.destroy();
        reject(error);
      };
      const onError = (error: Error) => fail(new ApnsError(`Could not connect to proxy: ${error.message}`, { cause: error }));
      const onClose = () => fail(new ApnsError("Proxy closed the connection before establishing a tunnel."));

      const onData = (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]);
        const headerEnd = received.indexOf("\r\n\r\n");

        if (headerEnd === -1) {
          if (received.length > MAX_RESPONSE_HEADER_BYTES) fail(new ApnsError("Proxy response headers too large."));
          return;
        }

        socket.off("data", onData);
        socket.off("error", onError);
        socket.off("close", onClose);
        socket.pause();

        const statusLine = received.subarray(0, received.indexOf("\r\n")).toString("latin1");
        const status = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine)?.[1];
        if (status === undefined || !status.startsWith("2")) {
          socket.destroy();
          reject(new ApnsError(`Proxy refused to open a tunnel to ${target}: ${statusLine}`));
          return;
        }

        const remainder = received.subarray(headerEnd + 4);
        if (remainder.length > 0) socket.unshift(remainder);
        resolve(socket);
      };

      socket.once("connect", () => {
        let request = `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n`;
        if (proxy.username !== undefined) {
          const credentials = Buffer.from(`${proxy.username}:${proxy.password ?? ""}`).toString("base64");
          request += `Proxy-Authorization: Basic ${credentials}\r\n`;
        }
        for (const [name, value] of Object.entries(proxy.headers ?? {})) {
          request += `${name}: ${value}\r\n`;
        }
        socket.write(`${request}\r\n`);
      });
      socket.on("data", onData);
      socket.once("error", onError);
      socket.once("close", onClose);
    });
}
