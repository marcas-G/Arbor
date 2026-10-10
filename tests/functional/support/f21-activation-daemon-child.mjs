import { writeFileSync } from "node:fs";
import { Effect } from "effect";
import {
  main,
  runDaemonForever,
} from "../../../apps/single-workspace/dist/main.js";
import {
  makeProjectResourceProfilePort,
  projectResourceProfilesFromEnvironment,
} from "../../../apps/single-workspace/dist/project-resource-profiles.js";

const boundary = process.env.F21_ACTIVATION_PROBE_BOUNDARY;
const markerFile = process.env.F21_ACTIVATION_MARKER;
if (
  (boundary !== "P11BeforeActivationCommit" &&
    boundary !== "P11AfterActivationCommit" &&
    boundary !== "GatewayCommittedBeforeP11Activation") ||
  markerFile === undefined
) {
  throw new Error("expected F21 activation boundary and marker path");
}

const profiles = makeProjectResourceProfilePort(
  projectResourceProfilesFromEnvironment(),
);
const daemonConfig = {
  projectResourceProfiles: profiles,
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
  ...(boundary === "GatewayCommittedBeforeP11Activation"
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
          await new Promise(() => {
            setInterval(() => {}, 1_000);
          });
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
