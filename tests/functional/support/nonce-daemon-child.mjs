import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import {
  main,
  runDaemonForever,
} from "../../../apps/single-workspace/dist/main.js";
import {
  makeProjectResourceProfilePort,
  projectResourceProfilesFromEnvironment,
} from "../../../apps/single-workspace/dist/project-resource-profiles.js";
import { parse, WorkspaceId } from "../../../packages/domain/dist/index.js";
import {
  createAh19StartupDiagnosticProbe,
  createFunctionalDaemonListenReporter,
} from "./functional-daemon-lifecycle.mjs";

const onWebTransportListening = createFunctionalDaemonListenReporter();
const startupDiagnosticProbe = createAh19StartupDiagnosticProbe(
  process.env.ARBOR_AH19_STARTUP_TRACE === "1",
);
const f18TestBoundary = process.env.ARBOR_F18_TEST_CRASH_BOUNDARY;
const f18TestLeaseTtlMs = Number(
  process.env.ARBOR_F18_TEST_LEASE_TTL_MS ?? "0",
);
const f18TestBarrierDir = process.env.ARBOR_F18_TEST_BARRIER_DIR;
const f18TestConfig =
  ((f18TestBoundary !== undefined && f18TestBoundary.length > 0) ||
    (f18TestBarrierDir !== undefined && f18TestBarrierDir.length > 0)) &&
  Number.isSafeInteger(f18TestLeaseTtlMs) &&
  f18TestLeaseTtlMs > 0
    ? {
        verificationSignalReconciliationQualificationProbe: async (event) => {
          if (
            event.boundary === "AfterSourceValidationBeforeClaim" &&
            f18TestBarrierDir !== undefined
          ) {
            mkdirSync(f18TestBarrierDir, { recursive: true });
            writeFileSync(
              join(f18TestBarrierDir, `arrived-${process.pid}`),
              JSON.stringify(event),
            );
            const deadline = Date.now() + 30_000;
            while (Date.now() < deadline) {
              const arrived = readdirSync(f18TestBarrierDir).filter((name) =>
                name.startsWith("arrived-"),
              );
              if (arrived.length >= 2) break;
              await new Promise((resolveWait) => setTimeout(resolveWait, 25));
            }
            const arrived = readdirSync(f18TestBarrierDir).filter((name) =>
              name.startsWith("arrived-"),
            );
            if (arrived.length < 2) {
              throw new Error(
                "F18 two-daemon source-validation barrier timed out",
              );
            }
          }
          if (
            f18TestBoundary !== undefined &&
            f18TestBoundary.length > 0 &&
            event.boundary === f18TestBoundary
          ) {
            process.stderr.write(
              `F18_TEST_CRASH:${event.boundary}:${event.projectId}:${event.eventSequence}:${event.leaseGeneration}\n`,
            );
            process.exit(86);
          }
        },
        attentionPollPolicy: {
          leaseTtlMs: f18TestLeaseTtlMs,
          queueBatchSize: 64,
          baseBackoffMs: 1_000,
          maxBackoffMs: 60_000,
          backoffExponentCap: 6,
        },
      }
    : {};
const reportStartupPhase = (phase) => {
  try {
    startupDiagnosticProbe(phase);
  } catch {
    // Child-side startup observation cannot change control flow.
  }
};

const projectResourceProfiles = makeProjectResourceProfilePort(
  projectResourceProfilesFromEnvironment(),
);
const port = Number(process.env.ARBOR_HTTP_PORT ?? "0");
const host = process.env.ARBOR_HTTP_HOST ?? "127.0.0.1";
const webTransport = {
  ...(process.env.ARBOR_WEB_DIST !== undefined
    ? { staticRoot: process.env.ARBOR_WEB_DIST }
    : {}),
  port,
  host,
};
const config = {
  projectResourceProfiles,
  webTransport,
  onWebTransportListening,
  startupDiagnosticProbe,
  ...f18TestConfig,
  ...(process.env.ARBOR_WORKSPACE_ID !== undefined
    ? { workspaceId: parse(WorkspaceId)(process.env.ARBOR_WORKSPACE_ID) }
    : {}),
};

const daemonProgram = runDaemonForever(config);
reportStartupPhase("layer.construction.before");
const applicationLayer = main({
  projectResourceProfiles,
  startupDiagnosticProbe,
  ...f18TestConfig,
});
reportStartupPhase("layer.construction.after");
await Effect.runPromise(
  Effect.provide(Effect.scoped(daemonProgram), applicationLayer),
);
