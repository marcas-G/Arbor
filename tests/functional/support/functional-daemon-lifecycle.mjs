import { randomUUID } from "node:crypto";

/** Test-child lifecycle reporting. Production receives only the generic
 * onWebTransportListening(port) observer; the run nonce stays in this helper. */
export const createFunctionalDaemonListenReporter = () => {
  const nonce = randomUUID();
  const pid = process.pid;
  const report = (tag, fields) =>
    process.stdout.write(`${JSON.stringify({ tag, nonce, pid, ...fields })}\n`);

  report("FUNCTIONAL_DAEMON_STARTED", {});
  return (port) => report("FUNCTIONAL_DAEMON_LISTENING", { port });
};
