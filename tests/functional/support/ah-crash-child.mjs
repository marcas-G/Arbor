import { Effect } from "effect";
import {
  main,
  runDaemonForever,
} from "../../../apps/single-workspace/dist/main.js";

const targetBoundary = process.env.ARBOR_AH_BOUNDARY;
if (
  targetBoundary !== "AH3BeforeStepAvailable" &&
  targetBoundary !== "AH3AfterStepAvailable" &&
  targetBoundary !== "AH12BeforeSuccessCommit" &&
  targetBoundary !== "AH12AfterSuccessCommit"
) {
  throw new Error("AH test child needs an exact boundary");
}

const pauseAtBoundary = async ({ boundary, providerTurnId }) => {
  if (boundary !== targetBoundary) return;
  process.stdout.write(
    `${JSON.stringify({ tag: "AH_PROBE", boundary, providerTurnId })}\n`,
  );
  await new Promise(() => {});
};

const config = {
  tickIntervalMs: 25,
  webTransport: {
    staticRoot: process.env.ARBOR_WEB_DIST,
    port: Number(process.env.ARBOR_HTTP_PORT),
    host: "127.0.0.1",
  },
  qualificationProbe: pauseAtBoundary,
  providerQualificationProbe: pauseAtBoundary,
};

await Effect.runPromise(
  Effect.provide(Effect.scoped(runDaemonForever(config)), main(config)),
);
