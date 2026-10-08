import { Effect } from "effect";
import {
  main,
  runDaemonForever,
} from "../../../apps/single-workspace/dist/main.js";

const targetBoundary = process.env.ARBOR_AH17_BOUNDARY;
if (
  targetBoundary !== "AH17BeforeCheckpointEpochCommit" &&
  targetBoundary !== "AH17AfterCheckpointEpochCommit"
) {
  throw new Error("AH17 child needs an exact checkpoint/epoch boundary");
}

const qualificationProbe = async (event) => {
  if (event.boundary !== targetBoundary) return;
  process.stdout.write(`${JSON.stringify({ tag: "AH17_PROBE", ...event })}\n`);
  await new Promise(() => {});
};

const config = {
  tickIntervalMs: 25,
  webTransport: {
    staticRoot: process.env.ARBOR_WEB_DIST,
    port: Number(process.env.ARBOR_HTTP_PORT),
    host: "127.0.0.1",
  },
  qualificationProbe,
};

await Effect.runPromise(
  Effect.provide(Effect.scoped(runDaemonForever(config)), main(config)),
);
