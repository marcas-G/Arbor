import { decodeTurn } from "@arbor/model-context";
import type { AgentLoopStepActionRecord, AgentLoopStepRecord, ExecutionDriverError } from "@arbor/ports";
import { SandboxPolicyDecisionStore, SandboxProviderUnavailableStore, sha256Hex } from "@arbor/ports";
import { type Context, Effect, Option } from "effect";
import { matchesPersistedModelOutput } from "../persisted-model-output.js";
import { verifySandboxUnavailableStepActionResume } from "../sandbox-unavailable-recovery.js";
import type { AgentLoopActionDependencies } from "./types.js";

/** Verify the exact committed action ledger before replay may advance. */
export const verifyCommittedStep = (
  dependencies: AgentLoopActionDependencies,
  committedStep: AgentLoopStepRecord,
  sandboxUnavailableFacts: Option.Option<Context.Tag.Service<typeof SandboxProviderUnavailableStore>>,
  sandboxPolicyDecisions: Option.Option<Context.Tag.Service<typeof SandboxPolicyDecisionStore>>,
): Effect.Effect<AgentLoopStepRecord, ExecutionDriverError> => {
  const { input, loopSteps, loopStepFence, providerTurns, preparedTurn, decodedOutput, tx, sessions, failure, now } = dependencies;
  return Effect.gen(function* () {
    if (
      loopSteps === undefined ||
      loopStepFence === undefined ||
      providerTurns === undefined
    ) {
      return yield* Effect.fail(
        failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
      );
    }
    const expectedOutput = {
      providerTurnId: preparedTurn.manifest.providerTurnId,
      outputContractRef: preparedTurn.manifest.outputContractRef,
      decoderVersion: "decode-turn-v1",
      text: decodedOutput.text,
      finishReason: decodedOutput.finishReason,
      toolInvocations: decodedOutput.toolInvocations,
    } as const;
    const expectedOutputHash = sha256Hex(JSON.stringify(expectedOutput));
    const verification = yield* tx
      .transact(
        Effect.gen(function* () {
          const stepOption = yield* loopSteps.find(committedStep.identity);
          if (!Option.isSome(stepOption)) return undefined;
          const step = stepOption.value;
          if (
            step.state !== "StepEffectsCommitted" ||
            step.revision !== committedStep.revision ||
            step.providerTurnId !== preparedTurn.manifest.providerTurnId ||
            step.manifestId === undefined ||
            step.decodedOutputHash !== expectedOutputHash ||
            step.decoderVersion !== "decode-turn-v1" ||
            step.modelOutputSessionSequence === undefined ||
            !Number.isSafeInteger(step.nextActionIndex) ||
            step.nextActionIndex < 0 ||
            step.nextActionIndex > decodedOutput.toolInvocations.length
          ) {
            return undefined;
          }

          const providerResult = yield* providerTurns.findSettledResult(
            step.providerTurnId,
          );
          const persistedManifest = yield* providerTurns.findManifestByTurn(
            step.providerTurnId,
          );
          if (
            providerResult._tag !== "SettledSuccess" ||
            providerResult.evidenceVersion !== "provider-success-v1" ||
            persistedManifest === null ||
            providerResult.manifestId !== step.manifestId ||
            providerResult.manifestJson !== persistedManifest.manifestJson ||
            providerResult.turn.providerTurnId !== step.providerTurnId ||
            providerResult.turn.executionId !== input.execution.executionId ||
            providerResult.turn.sessionId !== input.execution.sessionId ||
            providerResult.turn.contextEpoch !==
              preparedTurn.manifest.contextEpoch ||
            providerResult.turn.modelRef !== preparedTurn.manifest.modelRef ||
            providerResult.turn.outputContractRef !==
              preparedTurn.manifest.outputContractRef ||
            providerResult.finishReason !== decodedOutput.finishReason
          ) {
            return undefined;
          }

          let manifest: Record<string, unknown>;
          try {
            const parsed = JSON.parse(
              persistedManifest.manifestJson,
            ) as unknown;
            if (
              typeof parsed !== "object" ||
              parsed === null ||
              Array.isArray(parsed)
            ) {
              return undefined;
            }
            manifest = parsed as Record<string, unknown>;
          } catch {
            return undefined;
          }
          const manifestRoutes = manifest.toolRoutes;
          if (
            manifest.providerTurnId !== step.providerTurnId ||
            manifest.executionId !== input.execution.executionId ||
            manifest.sessionId !== input.execution.sessionId ||
            manifest.contextEpoch !== preparedTurn.manifest.contextEpoch ||
            manifest.modelRef !== preparedTurn.manifest.modelRef ||
            manifest.outputContractRef !==
              preparedTurn.manifest.outputContractRef ||
            manifest.logicalStepNo !== step.identity.logicalStepNo ||
            manifest.repairAttempt !== step.identity.repairAttempt ||
            !Array.isArray(manifestRoutes) ||
            JSON.stringify(manifestRoutes) !==
              JSON.stringify(preparedTurn.manifest.toolRoutes) ||
            JSON.stringify(manifestRoutes) !==
              JSON.stringify(preparedTurn.toolRoutes)
          ) {
            return undefined;
          }

          const providerOutput = decodeTurn(providerResult.canonicalEvents);
          if (
            !providerOutput.ok ||
            JSON.stringify({
              providerTurnId: step.providerTurnId,
              outputContractRef: manifest.outputContractRef,
              decoderVersion: "decode-turn-v1",
              text: providerOutput.output.text,
              finishReason: providerOutput.output.finishReason,
              toolInvocations: providerOutput.output.toolInvocations,
            }) !== JSON.stringify(expectedOutput)
          ) {
            return undefined;
          }

          const outputRows = yield* sessions.listEntries(
            input.execution.sessionId,
            step.modelOutputSessionSequence - 1,
            1,
          );
          const outputEntry = outputRows[0];
          if (
            outputRows.length !== 1 ||
            !matchesPersistedModelOutput({
              providerTurnId: step.providerTurnId,
              outputContractRef: preparedTurn.manifest.outputContractRef,
              text: decodedOutput.text,
              finishReason: decodedOutput.finishReason,
              toolInvocations: decodedOutput.toolInvocations,
              decodedOutputHash: step.decodedOutputHash,
              modelOutputSessionSequence: step.modelOutputSessionSequence,
              entry: outputEntry,
            })
          ) {
            return undefined;
          }
          const actions = yield* loopSteps.listActions(step.identity);
          const terminalSandboxActions = actions.filter(
            (action) =>
              action.state === "TerminalRejected" &&
              typeof action.disposition === "object" &&
              action.disposition !== null &&
              "_tag" in action.disposition &&
              action.disposition._tag === "SandboxUnavailableV1",
          );
          const hasSandboxUnavailableResume =
            terminalSandboxActions.length === 1 &&
            Option.isSome(sandboxUnavailableFacts) &&
            Option.isSome(sandboxPolicyDecisions) &&
            actions.length === step.nextActionIndex &&
            actions.at(-1) === terminalSandboxActions[0] &&
            step.nextActionIndex ===
              (terminalSandboxActions[0]?.actionIndex ?? -2) + 1 &&
            (yield* verifySandboxUnavailableStepActionResume({
              execution: input.execution,
              step,
              action: terminalSandboxActions[0] as AgentLoopStepActionRecord,
              facts: sandboxUnavailableFacts.value,
              decisions: sandboxPolicyDecisions.value,
              now: yield* now(),
            }));
          if (
            actions.length !== step.nextActionIndex ||
            (!hasSandboxUnavailableResume &&
              actions.length !== decodedOutput.toolInvocations.length) ||
            new Set(actions.map((action) => action.actionIndex)).size !==
              actions.length
          ) {
            return undefined;
          }
          for (
            let actionIndex = 0;
            actionIndex < actions.length;
            actionIndex += 1
          ) {
            const invocation = decodedOutput.toolInvocations[actionIndex];
            const action = actions.find(
              (candidate) => candidate.actionIndex === actionIndex,
            );
            if (invocation === undefined || action === undefined) {
              return undefined;
            }
            const routes = manifestRoutes.filter(
              (
                route,
              ): route is { name: string; route: "Executable" | "Control" } =>
                typeof route === "object" &&
                route !== null &&
                "name" in route &&
                typeof route.name === "string" &&
                "route" in route &&
                (route.route === "Executable" || route.route === "Control"),
            );
            const matchingRoutes = routes.filter(
              (route) => route.name === invocation.toolName,
            );
            const route = matchingRoutes[0];
            const logicalActionId = `lac_${sha256Hex(
              JSON.stringify({
                executionId: input.execution.executionId,
                providerTurnId: step.providerTurnId,
                callRef: invocation.callRef,
                routeKind: route?.route,
                actionKind: invocation.toolName,
              }),
            )}`;
            if (
              matchingRoutes.length !== 1 ||
              action.identity.executionId !== step.identity.executionId ||
              action.identity.logicalStepNo !== step.identity.logicalStepNo ||
              action.identity.repairAttempt !== step.identity.repairAttempt ||
              action.logicalActionId !== logicalActionId ||
              action.callRef !== invocation.callRef ||
              action.routeKind !== route?.route ||
              action.actionKind !== invocation.toolName ||
              action.inputHash !== sha256Hex(invocation.argumentsJson) ||
              (action.state === "Applied"
                ? action.resultRef === undefined ||
                  action.observationSourceRef === undefined
                : !(
                    hasSandboxUnavailableResume &&
                    action === terminalSandboxActions[0]
                  ))
            ) {
              return undefined;
            }
          }
          return step;
        }),
      )
      .pipe(Effect.mapError(failure));
    if (verification === undefined) {
      return yield* Effect.fail(
        failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
      );
    }
    return verification;
  });
};
