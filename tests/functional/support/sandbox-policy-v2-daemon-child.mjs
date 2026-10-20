import { appendFileSync, readFileSync } from "node:fs";
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
  // The process test commits an initially current policy, then changes the
  // protected V2 pair and kills this daemon before another scheduler tick.
  tickIntervalMs: 60_000,
};
const daemonProgram = runDaemonForever(config);
await Effect.runPromise(
  Effect.provide(
    Effect.scoped(daemonProgram),
    main({
      projectResourceProfiles,
      trustedHostConfigurationSource,
      startupDiagnosticProbe,
    }),
  ),
);
