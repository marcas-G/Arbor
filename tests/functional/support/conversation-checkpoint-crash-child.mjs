import { Effect } from "effect";
import {
  main,
  runDaemonForever,
} from "../../../apps/single-workspace/dist/main.js";
import { createFunctionalDaemonListenReporter } from "./functional-daemon-lifecycle.mjs";

const onWebTransportListening = createFunctionalDaemonListenReporter();
const targetBoundary = process.env.ARBOR_AH19_CONVERSATION_BOUNDARY;
if (
  targetBoundary !== "AH19BeforeConversationCheckpointOwnerCommit" &&
  targetBoundary !== "AH19AfterConversationCheckpointOwnerCommit"
) {
  throw new Error("AH19 child needs an exact Conversation owner boundary");
}

const qualificationProbe = async (event) => {
  if (event.boundary !== targetBoundary) return;
  process.stdout.write(
    `${JSON.stringify({ tag: "AH19_CONVERSATION_PROBE", ...event })}\n`,
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
  onWebTransportListening,
  qualificationProbe,
};

await Effect.runPromise(
  Effect.provide(Effect.scoped(runDaemonForever(config)), main(config)),
);
