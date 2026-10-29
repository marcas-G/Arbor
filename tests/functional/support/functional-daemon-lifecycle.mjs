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

export const createAh19StartupDiagnosticProbe = (enabled) => {
  const startedAt = process.hrtime.bigint();
  const phases = new Set([
    "layer.construction.before",
    "layer.construction.after",
    "p39.layer-path-validation.before",
    "p39.layer-path-validation.after",
    "p39.schema-validation.before",
    "p39.schema-validation.after",
    "p39.runtime-path-validation.before",
    "p39.runtime-path-validation.after",
    "p39.writer-permit-acquire.before",
    "p39.writer-permit-acquire.after",
    "production-daemon-service.acquired",
    "daemon.start.before",
    "daemon.start.after",
    "daemon.migrate.before",
    "daemon.migrate.after",
    "daemon.startup-recovery.before",
    "daemon.startup-recovery.after",
    "web-transport.bind.before",
    "web-transport.bind.after",
    "daemon.process.exit",
  ]);
  const report = (phase, extra = {}) => {
    if (!enabled || !phases.has(phase)) return;
    process.stdout.write(
      `${JSON.stringify({
        tag: "AH19_STARTUP_PHASE",
        phase,
        elapsedMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
        pid: process.pid,
        ...extra,
      })}\n`,
    );
  };
  const safeReport = (phase, extra = {}) => {
    try {
      report(phase, extra);
    } catch {
      // Test-only observations cannot affect child startup.
    }
  };
  if (enabled) {
    process.on("exit", (exitCode) => {
      safeReport("daemon.process.exit", { exitCode });
    });
  }
  return safeReport;
};
