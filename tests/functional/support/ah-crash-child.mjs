import { Effect } from "effect";
import {
  main,
  runDaemonForever,
} from "../../../apps/single-workspace/dist/main.js";

const targetBoundary = process.env.ARBOR_AH_BOUNDARY;
if (
  targetBoundary !== "AH3BeforeStepAvailable" &&
  targetBoundary !== "AH3AfterStepAvailable" &&
  targetBoundary !== "AH4BeforeSettlementProposal" &&
  targetBoundary !== "AH4AfterSettlementProposal" &&
  targetBoundary !== "AH4RepairBeforeSettlementProposal" &&
  targetBoundary !== "AH4RepairAfterSettlementProposal" &&
  targetBoundary !== "AH56AfterOutputAcceptedCommit" &&
  targetBoundary !== "AH12BeforeSuccessCommit" &&
  targetBoundary !== "AH12AfterSuccessCommit" &&
  targetBoundary !== "AH7AfterActionIntentCommit" &&
  targetBoundary !== "AH7AfterActionResultCommit" &&
  targetBoundary !== "AH7AfterToolIntentCommit" &&
  targetBoundary !== "AH7AfterToolEffectBeforeSettlement" &&
  targetBoundary !== "AH7AfterToolSettlementCommit" &&
  targetBoundary !== "AH9BeforeTerminalActionCommit" &&
  targetBoundary !== "AH9AfterTerminalActionCommit" &&
  targetBoundary !== "AH11BeforeStepEffectsCommit" &&
  targetBoundary !== "AH11AfterStepEffectsCommit"
) {
  throw new Error("AH test child needs an exact boundary");
}

const pauseAtBoundary = async (event) => {
  const { boundary, providerTurnId } = event;
  if (boundary !== targetBoundary) return;
  process.stdout.write(
    `${JSON.stringify({ tag: "AH_PROBE", ...event, providerTurnId })}\n`,
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
  toolQualificationProbe: pauseAtBoundary,
};

await Effect.runPromise(
  Effect.provide(Effect.scoped(runDaemonForever(config)), main(config)),
);
