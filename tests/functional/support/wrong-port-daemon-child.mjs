import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

const nonce = randomUUID();
const pid = process.pid;
const report = (tag, fields) =>
  process.stdout.write(`${JSON.stringify({ tag, nonce, pid, ...fields })}\n`);

report("FUNCTIONAL_DAEMON_STARTED", {});
const server = createServer((_request, response) => {
  response.writeHead(200);
  response.end("wrong-port-child");
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("wrong-port child did not bind a TCP port");
  }
  report("FUNCTIONAL_DAEMON_LISTENING", { port: address.port });
});
