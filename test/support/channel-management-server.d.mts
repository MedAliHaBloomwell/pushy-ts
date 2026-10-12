import type { IncomingHttpHeaders } from "node:http2";

export interface FakeChannelManagementServer {
  port: number;
  requests: Array<{ headers: IncomingHttpHeaders; body: string }>;
  channels: Map<string, Map<string, 0 | 1>>;
  close(): Promise<void>;
}

export function startChannelManagementServer(credentials: {
  cert: string | Buffer;
  key: string | Buffer;
}): Promise<FakeChannelManagementServer>;
