import { existsSync, writeFileSync } from "node:fs";
import { Effect } from "effect";
import {
  main,
  runDaemonForever,
} from "../../../apps/single-workspace/dist/main.js";
import {
  makeProjectResourceProfilePort,
  projectResourceProfilesFromEnvironment,
} from "../../../apps/single-workspace/dist/project-resource-profiles.js";
import { createFunctionalDaemonListenReporter } from "./functional-daemon-lifecycle.mjs";

const onWebTransportListening = createFunctionalDaemonListenReporter();

const boundary = process.env.F21_ACTIVATION_PROBE_BOUNDARY;
const markerFile = process.env.F21_ACTIVATION_MARKER;
const releaseFile = process.env.F21_ACTIVATION_RELEASE;
if (
  (boundary !== "P11BeforeActivationCommit" &&
    boundary !== "P11AfterActivationCommit" &&
    boundary !== "GatewayCommittedBeforeP11Activation" &&
    boundary !== "GatewayCommittedBeforeP11ActivationReleasable") ||
  markerFile === undefined
) {
  throw new Error("expected F21 activation boundary and marker path");
}

const profiles = makeProjectResourceProfilePort(
  projectResourceProfilesFromEnvironment(),
);
const daemonConfig = {
  projectResourceProfiles: profiles,
  onWebTransportListening,
  ...(process.env.ARBOR_HTTP_PORT !== undefined
    ? {
        webTransport: {
          ...(process.env.ARBOR_WEB_DIST !== undefined
            ? { staticRoot: process.env.ARBOR_WEB_DIST }
            : {}),
          port: Number(process.env.ARBOR_HTTP_PORT),
          ...(process.env.ARBOR_HTTP_HOST !== undefined
            ? { host: process.env.ARBOR_HTTP_HOST }
            : {}),
        },
      }
    : {}),
};
const app = main({
  projectResourceProfiles: profiles,
  ...(boundary === "GatewayCommittedBeforeP11Activation" ||
  boundary === "GatewayCommittedBeforeP11ActivationReleasable"
    ? {
        createProjectPostCommitBeforeActivationQualificationProbe: async (
          event,
        ) => {
          writeFileSync(
            markerFile,
            JSON.stringify({
              boundary,
              ...event,
            }),
            "utf8",
          );
          if (boundary === "GatewayCommittedBeforeP11Activation") {
            await new Promise(() => {
              setInterval(() => {}, 1_000);
            });
          }
          if (boundary === "GatewayCommittedBeforeP11ActivationReleasable") {
            if (releaseFile === undefined) {
              throw new Error("expected F21 activation release path");
            }
            const deadline = Date.now() + 60_000;
            while (!existsSync(releaseFile)) {
              if (Date.now() >= deadline) {
                throw new Error("timed out waiting for F21 activation release");
              }
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }
        },
      }
    : {
        workspaceResourceActivationQualificationProbe: async (event) => {
          if (event.boundary === boundary) {
            writeFileSync(markerFile, JSON.stringify(event), "utf8");
            await new Promise(() => {
              setInterval(() => {}, 1_000);
            });
          }
        },
      }),
});

await Effect.runPromise(
  Effect.provide(Effect.scoped(runDaemonForever(daemonConfig)), app),
);
