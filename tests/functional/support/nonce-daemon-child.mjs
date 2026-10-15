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
  ...(process.env.ARBOR_WORKSPACE_ID !== undefined
    ? { workspaceId: parse(WorkspaceId)(process.env.ARBOR_WORKSPACE_ID) }
    : {}),
};

const daemonProgram = runDaemonForever(config);
reportStartupPhase("layer.construction.before");
const applicationLayer = main({
  projectResourceProfiles,
  startupDiagnosticProbe,
});
reportStartupPhase("layer.construction.after");
await Effect.runPromise(
  Effect.provide(Effect.scoped(daemonProgram), applicationLayer),
);
