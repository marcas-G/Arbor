import { Effect } from "effect";
import {
  main,
  runDaemonForever,
} from "../../../apps/single-workspace/dist/main.js";

const boundaries = new Set([
  "AH18BeforeOverflowLinksCommit",
  "AH18AfterOverflowLinksCommit",
  "AH18BeforeInferenceFailTurnCommit",
  "AH18BeforeSummaryTurnCommit",
  "AH18AfterSummaryTurnCommit",
  "AH18AfterSummaryRetryableFailureCommit",
]);
const targetBoundary = process.env.ARBOR_AH18_BOUNDARY;
if (!boundaries.has(targetBoundary)) {
  throw new Error("AH18 child needs an exact overflow-chain boundary");
}

const pauseAtBoundary = async (event) => {
  if (event.boundary !== targetBoundary) return;
  process.stdout.write(`${JSON.stringify({ tag: "AH18_PROBE", ...event })}\n`);
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
