import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

const mode = process.env.ARBOR_TEST_HANDSHAKE_MODE;
const nonce = randomUUID();
const report = (tag, eventNonce, pid, port) =>
  process.stdout.write(
    `${JSON.stringify({ tag, nonce: eventNonce, pid, ...(port === undefined ? {} : { port }) })}\n`,
  );
const stayAliveForFixtureCleanup = () =>
  new Promise(() => setInterval(() => {}, 60_000));

if (
  mode === "exit-after-listening" ||
  mode === "hang-readiness" ||
  mode === "late-readiness"
) {
  const port = Number(process.env.ARBOR_HTTP_PORT ?? "0");
  const server = createServer((_request, response) => {
    if (mode === "hang-readiness") {
      report("FUNCTIONAL_DAEMON_READINESS_REQUEST", nonce, process.pid);
    }
    if (mode === "late-readiness") {
      setTimeout(() => {
        report("FUNCTIONAL_DAEMON_READINESS_RESPONSE", nonce, process.pid);
        response.writeHead(200);
        response.end("ready");
      }, 1_700);
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test child did not bind an HTTP port");
  }
  report("FUNCTIONAL_DAEMON_STARTED", nonce, process.pid);
  report("FUNCTIONAL_DAEMON_LISTENING", nonce, process.pid, address.port);
  if (mode === "exit-after-listening") {
    setTimeout(() => {
      process.stderr.write("readiness-exit-sentinel\n");
      process.exit(23);
    }, 100);
  }
  await stayAliveForFixtureCleanup();
}

if (mode === "early-exit") {
  report("FUNCTIONAL_DAEMON_STARTED", nonce, process.pid);
  process.exit(17);
}

if (mode === "duplicate-started") {
  const conflictingNonce = randomUUID();
  process.stdout.write(
    `${[
      ["FUNCTIONAL_DAEMON_STARTED", nonce, process.pid],
      ["FUNCTIONAL_DAEMON_STARTED", conflictingNonce, process.pid],
      ["FUNCTIONAL_DAEMON_LISTENING", conflictingNonce, process.pid, 43210],
    ]
      .map(([tag, eventNonce, pid, port]) =>
        JSON.stringify({
          tag,
          nonce: eventNonce,
          pid,
          ...(port === undefined ? {} : { port }),
        }),
      )
      .join("\n")}\n`,
  );
  await stayAliveForFixtureCleanup();
}

if (mode === "duplicate-listening") {
  process.stdout.write(
    `${[
      ["FUNCTIONAL_DAEMON_STARTED", nonce, process.pid],
      ["FUNCTIONAL_DAEMON_LISTENING", nonce, process.pid, 43210],
      ["FUNCTIONAL_DAEMON_LISTENING", nonce, process.pid, 43210],
    ]
      .map(([tag, eventNonce, pid, port]) =>
        JSON.stringify({
          tag,
          nonce: eventNonce,
          pid,
          ...(port === undefined ? {} : { port }),
        }),
      )
      .join("\n")}\n`,
  );
  await stayAliveForFixtureCleanup();
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
await stayAliveForFixtureCleanup();
