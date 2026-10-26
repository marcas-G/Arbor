import { appendFileSync, readFileSync } from "node:fs";
import { Effect } from "effect";
import { runDaemonForever } from "../../../apps/single-workspace/dist/main.js";
import {
  makeProjectResourceProfilePort,
  projectResourceProfilesFromEnvironment,
} from "../../../apps/single-workspace/dist/project-resource-profiles.js";
import {
  Principal,
  parse,
  WorkspaceId,
} from "../../../packages/domain/dist/index.js";
import {
  createAh19StartupDiagnosticProbe,
  createFunctionalDaemonListenReporter,
} from "./functional-daemon-lifecycle.mjs";
import { functionalTestMain } from "./functional-test-composition.mjs";

const sourceFilename = process.env.ARBOR_SANDBOX_AUTHORITY_SOURCE_FILE;
if (sourceFilename === undefined || sourceFilename.length === 0) {
  throw new Error("test V2 source file is not configured");
}
const readPair = () => JSON.parse(readFileSync(sourceFilename, "utf8"));
const trustedHostConfigurationSource = {
  readVerifiedSandboxAuthorityBundle: () =>
    Effect.sync(() => {
      const pair = readPair();
      return {
        sourceIdentity: pair.sourceIdentity,
        canonicalJson: pair.bundleCanonicalJson,
      };
    }),
  readSandboxAuthorityHighWater: () =>
    Effect.sync(() => readPair().highWaterCanonicalJson),
  commitSandboxAuthorityHighWater: () => Effect.succeed(false),
  appendSandboxAuthorityAudit: (canonicalJson) =>
    Effect.sync(() => {
      appendFileSync(`${sourceFilename}.audit`, `${canonicalJson}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      return true;
    }),
};
const onWebTransportListening = createFunctionalDaemonListenReporter();
const startupDiagnosticProbe = createAh19StartupDiagnosticProbe(
  process.env.ARBOR_AH19_STARTUP_TRACE === "1",
);
const targetAhBoundary = process.env.ARBOR_AH_BOUNDARY;
const skipAhBoundaryCount = Number.parseInt(
  process.env.ARBOR_AH_BOUNDARY_SKIP_COUNT ?? "0",
  10,
);
let matchedAhBoundaryCount = 0;
const pauseAtAhBoundary = async (event) => {
  if (event.boundary !== targetAhBoundary) return;
  matchedAhBoundaryCount += 1;
  if (matchedAhBoundaryCount <= skipAhBoundaryCount) return;
  process.stdout.write(`${JSON.stringify({ tag: "AH_PROBE", ...event })}\n`);
  await new Promise(() => {});
};
const toolQualificationProbe =
  targetAhBoundary === "AH7AfterToolIntentCommit" ||
  targetAhBoundary === "NativeProcessModeDenialBeforeCommit" ||
  targetAhBoundary === "NativeProcessModeDenialAfterCommit"
    ? pauseAtAhBoundary
    : undefined;
const executableToolQualificationProbe = async (event) => {
  process.stdout.write(
    `${JSON.stringify({ tag: "P4_EXECUTABLE_PROBE", ...event })}\n`,
  );
};
const sandboxPolicyDecisionPreparationQualificationProbe = async (event) => {
  process.stdout.write(
    `${JSON.stringify({ tag: "P1_SANDBOX_PREPARATION_PROBE", ...event })}\n`,
  );
};
const schedulerQualificationProbe = (event) => {
  if (process.env.ARBOR_SCHEDULER_PROBE === "1") {
    process.stdout.write(
      `${JSON.stringify({ tag: "SCHEDULER_PROBE", ...event })}\n`,
    );
  }
};
const governance = {
  authenticatedHumans: [
    parse(Principal)("user:local"),
    parse(Principal)("user:operator"),
  ],
  directParentOf: [],
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
  trustedHostConfigurationSource,
  webTransport,
  onWebTransportListening,
  startupDiagnosticProbe,
  ...(process.env.ARBOR_WORKSPACE_ID !== undefined
    ? { workspaceId: parse(WorkspaceId)(process.env.ARBOR_WORKSPACE_ID) }
    : {}),
  ...(process.env.ARBOR_SCHEDULER_PROBE === "1"
    ? { schedulerQualificationProbe }
    : {}),
  // The process test commits an initially current policy, then changes the
  // protected V2 pair and kills this daemon before another scheduler tick.
  tickIntervalMs: Number(process.env.ARBOR_TICK_INTERVAL_MS ?? "60000"),
  ...(targetAhBoundary === "AH7AfterToolIntentCommit" ||
  targetAhBoundary === "NativeProcessModeDenialBeforeCommit" ||
  targetAhBoundary === "NativeProcessModeDenialAfterCommit"
    ? { toolQualificationProbe: pauseAtAhBoundary }
    : {}),
};
const daemonProgram = runDaemonForever(config);
await Effect.runPromise(
  Effect.provide(
    Effect.scoped(daemonProgram),
    functionalTestMain({
      projectResourceProfiles,
      trustedHostConfigurationSource,
      startupDiagnosticProbe,
      governance,
      executableToolQualificationProbe,
      sandboxPolicyDecisionPreparationQualificationProbe,
      ...(toolQualificationProbe === undefined
        ? {}
        : { toolQualificationProbe }),
    }),
    {
      allowTrustedLocalProcessExecution:
        process.env.ARBOR_TEST_ONLY_TRUSTED_LOCAL_PROCESS_EXECUTION === "1",
    },
  ),
);
