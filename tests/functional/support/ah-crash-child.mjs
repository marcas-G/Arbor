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
import { Principal, parse } from "../../../packages/domain/dist/index.js";
import { SHELL_DEFINITION } from "../../../packages/tool-runtime/dist/catalog.js";
import { createFunctionalDaemonListenReporter } from "./functional-daemon-lifecycle.mjs";
import { functionalTestMain } from "./functional-test-composition.mjs";

const onWebTransportListening = createFunctionalDaemonListenReporter();
const sandboxAuthoritySourceFile =
  process.env.ARBOR_SANDBOX_AUTHORITY_SOURCE_FILE;
const trustedHostConfigurationSource =
  sandboxAuthoritySourceFile === undefined
    ? undefined
    : {
        readVerifiedSandboxAuthorityBundle: () =>
          Effect.sync(() => {
            const pair = JSON.parse(
              readFileSync(sandboxAuthoritySourceFile, "utf8"),
            );
            return {
              sourceIdentity: pair.sourceIdentity,
              canonicalJson: pair.bundleCanonicalJson,
            };
          }),
        readSandboxAuthorityHighWater: () =>
          Effect.sync(
            () =>
              JSON.parse(readFileSync(sandboxAuthoritySourceFile, "utf8"))
                .highWaterCanonicalJson,
          ),
        commitSandboxAuthorityHighWater: () => Effect.succeed(false),
        appendSandboxAuthorityAudit: (canonicalJson) =>
          Effect.sync(() => {
            appendFileSync(
              `${sandboxAuthoritySourceFile}.audit`,
              `${canonicalJson}\n`,
              { encoding: "utf8", mode: 0o600 },
            );
            return true;
          }),
      };
const governance = {
  authenticatedHumans: [
    parse(Principal)("user:local"),
    parse(Principal)("user:operator"),
  ],
  directParentOf: [],
};

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
  targetBoundary !== "AH7BeforeActionResultCommit" &&
  targetBoundary !== "AH7AfterActionResultCommit" &&
  targetBoundary !== "AH7AfterToolIntentCommit" &&
  targetBoundary !== "AH7BeforeToolSettlementTransaction" &&
  targetBoundary !== "AH7BeforeToolSettlementCommit" &&
  targetBoundary !== "AH7AfterToolEffectBeforeSettlement" &&
  targetBoundary !== "AH7AfterToolSettlementCommit" &&
  targetBoundary !== "disabled" &&
  targetBoundary !== "AH9BeforeTerminalActionCommit" &&
  targetBoundary !== "AH9AfterTerminalActionCommit" &&
  targetBoundary !== "AH11BeforeStepEffectsCommit" &&
  targetBoundary !== "AH11AfterStepEffectsCommit" &&
  targetBoundary !== "AH12BeforeSettleGatewaySubmission" &&
  targetBoundary !== "AH12BeforeSettleExecutionCommit" &&
  targetBoundary !== "AH12AfterSettleCommandCommit" &&
  targetBoundary !== "AH13BeforeResponseSweepCommit" &&
  targetBoundary !== "AH13AfterResponseSweepCommit" &&
  targetBoundary !== "AH14BeforeLegacyAdoptionCommit" &&
  targetBoundary !== "AH14AfterLegacyAdoptionCommit" &&
  targetBoundary !== "AH14BeforeLegacyAdoptionAttentionCommit" &&
  targetBoundary !== "AH14AfterLegacyAdoptionAttentionCommit" &&
  targetBoundary !== "AH14BeforeLegacyAdoptionResolutionCommit" &&
  targetBoundary !== "AH14AfterLegacyAdoptionResolutionCommit" &&
  targetBoundary !== "AH15BeforeInboxPromotionCommit" &&
  targetBoundary !== "AH15AfterInboxPromotionCommit" &&
  targetBoundary !== "RAI-DG02BeforeFinalAttemptSettlementCommit" &&
  targetBoundary !== "RAI-DG02AfterFinalAttemptSettlementCommit"
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
  tickIntervalMs: Number(process.env.ARBOR_TICK_INTERVAL_MS ?? "25"),
  projectResourceProfiles: makeProjectResourceProfilePort(
    projectResourceProfilesFromEnvironment(),
  ),
  webTransport: {
    staticRoot: process.env.ARBOR_WEB_DIST,
    port: Number(process.env.ARBOR_HTTP_PORT),
    host: "127.0.0.1",
  },
  onWebTransportListening,
  ...(trustedHostConfigurationSource === undefined
    ? {}
    : { trustedHostConfigurationSource }),
  qualificationProbe: pauseAtBoundary,
  inputPromotionQualificationProbe: pauseAtBoundary,
  providerQualificationProbe: pauseAtBoundary,
  toolQualificationProbe: pauseAtBoundary,
  executionSettlementQualificationProbe: pauseAtBoundary,
  gatewayQualificationProbe: pauseAtBoundary,
  conversationResponseQualificationProbe: pauseAtBoundary,
};

if (process.env.ARBOR_AH_NON_IDEMPOTENT === "1") {
  SHELL_DEFINITION.hash = "shell-v2-ah7-non-idempotent-qualification";
  SHELL_DEFINITION.sideEffectSemantics = "NonIdempotent";
}

const mainOverrides = {
  ...config,
  ...(trustedHostConfigurationSource === undefined
    ? {}
    : { trustedHostConfigurationSource }),
  ...(trustedHostConfigurationSource === undefined ? {} : { governance }),
};
const daemonLayer =
  process.env.ARBOR_TEST_ONLY_TRUSTED_LOCAL_PROCESS_EXECUTION === "1"
    ? functionalTestMain(mainOverrides, {
        allowTrustedLocalProcessExecution: true,
      })
    : main(mainOverrides);

await Effect.runPromise(
  Effect.provide(Effect.scoped(runDaemonForever(config)), daemonLayer),
);
