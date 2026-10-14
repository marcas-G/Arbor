import { randomUUID } from "node:crypto";

const mode = process.env.ARBOR_TEST_HANDSHAKE_MODE;
const nonce = randomUUID();
const report = (tag, eventNonce, pid, port) =>
  process.stdout.write(
    `${JSON.stringify({ tag, nonce: eventNonce, pid, ...(port === undefined ? {} : { port }) })}\n`,
  );

if (mode === "early-exit") {
  report("FUNCTIONAL_DAEMON_STARTED", nonce, process.pid);
  process.exit(17);
}

report(
  "FUNCTIONAL_DAEMON_STARTED",
  nonce,
  mode === "wrong-pid" ? process.pid + 1 : process.pid,
);
report(
  "FUNCTIONAL_DAEMON_LISTENING",
  mode === "wrong-nonce" ? randomUUID() : nonce,
  process.pid,
  43210,
);
await new Promise(() => {});
