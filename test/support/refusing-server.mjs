// An HTTP/2 server that refuses the first stream (RST_STREAM REFUSED_STREAM) and accepts the rest. Each reply's
// apns-id ends with the request number. It runs under Node because Bun's HTTP/2 server cannot yet send RST_STREAM
// error codes. Usage: node refusing-server.mjs <fixtures dir>; prints the bound port.
import { readFileSync } from "node:fs";
import http2 from "node:http2";
import { join } from "node:path";

const fixtures = process.argv[2];
const server = http2.createSecureServer({
  cert: readFileSync(join(fixtures, "server.pem")),
  key: readFileSync(join(fixtures, "server.key")),
});

let requests = 0;
server.on("stream", (stream) => {
  const requestNumber = ++requests;
  stream.on("error", () => {});
  if (requestNumber === 1) {
    stream.close(http2.constants.NGHTTP2_REFUSED_STREAM);
    return;
  }
  stream.resume();
  stream.on("end", () => {
    const apnsId = `00000000-0000-0000-0000-${String(requestNumber).padStart(12, "0")}`;
    stream.respond({ ":status": 200, "apns-id": apnsId }, { endStream: true });
  });
});

server.listen(0, "127.0.0.1", () => console.log(server.address().port));
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
