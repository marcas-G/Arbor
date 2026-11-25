import { writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";

const [socketPath, portText, readyPath] = process.argv.slice(2);
if (
  socketPath !== "/arbor/network/egress.sock" ||
  !/^\d{4,5}$/.test(portText ?? "") ||
  readyPath !== "/tmp/arbor-network-ready"
)
  process.exit(127);
const sockets = new Set();
const server = createServer((client) => {
  const channel = createConnection({ path: socketPath });
  sockets.add(client);
  sockets.add(channel);
  client.on("error", () => channel.destroy());
  channel.on("error", () => client.destroy());
  client.on("close", () => {
    sockets.delete(client);
    channel.destroy();
  });
  channel.on("close", () => {
    sockets.delete(channel);
    client.destroy();
  });
  client.pipe(channel);
  channel.pipe(client);
});
server.maxConnections = 32;
server.on("error", () => process.exit(127));
server.listen(Number(portText), "127.0.0.1", () =>
  writeFileSync(readyPath, "ready", { flag: "wx", mode: 0o600 }),
);
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.once(signal, () => {
    for (const socket of sockets) socket.destroy();
    server.close(() => process.exit(0));
  });
}
