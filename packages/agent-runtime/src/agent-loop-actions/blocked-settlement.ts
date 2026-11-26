import {
  blockedFailureFingerprint,
  verifyBlockedActionRefs,
  workBlockerIdentity,
} from "@arbor/application";
import type {
  BlockedActionRef,
  ExecutionSettlement,
  WorkRevision,
} from "@arbor/domain";
import { workEpisode as exactWorkEpisode } from "@arbor/domain";
import type {
  AgentLoopStepActionRecord,
  AgentLoopStepRecord,
} from "@arbor/ports";
import { Effect, type Option } from "effect";
import type { BlockedSettlementError } from "./errors.js";
import type { AgentLoopActionDependencies } from "./types.js";

const terminalDenialOf = (
  value: unknown,
): BlockedActionRef["terminalDenial"] | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record._tag === "HandlerRejected" && record.routeKind === "Executable") {
    return { _tag: "HandlerRejected", routeKind: "Executable" };
  }
  if (
    record._tag === "P4NoEffectDenied" &&
    typeof record.reasonCode === "string" &&
    record.reasonCode !== "ApprovalRequired"
  ) {
    return {
      _tag: "P4NoEffectDenied",
      reasonCode: record.reasonCode as Extract<
        BlockedActionRef["terminalDenial"],
        { readonly _tag: "P4NoEffectDenied" }
      >["reasonCode"],
    };
  }
  return null;
};

const compareActionOrder = (
  left: {
    readonly logicalStepNo: number;
    readonly repairAttempt: number;
    readonly actionIndex?: number;
  },
  right: {
    readonly logicalStepNo: number;
    readonly repairAttempt: number;
    readonly actionIndex?: number;
  },
): number =>
  left.logicalStepNo - right.logicalStepNo ||
  left.repairAttempt - right.repairAttempt ||
  (left.actionIndex ?? 0) - (right.actionIndex ?? 0);

export const makeBlockedSettlement = (
  dependencies: AgentLoopActionDependencies,
  request: string,
  currentLoopStep: AgentLoopStepRecord | undefined,
): Effect.Effect<ExecutionSettlement | null, BlockedSettlementError> =>
  Effect.gen(function* () {
    const execution = dependencies.input.execution;
    const episode = exactWorkEpisode(execution);
    const current = currentLoopStep;
    const steps = dependencies.loopSteps;
    const turns = dependencies.providerTurns;
    const inbox = dependencies.inboxSequence;
    if (
      episode === null ||
      current === undefined ||
      steps === undefined ||
      turns === undefined ||
      inbox === undefined
    ) {
      return null;
    }

    const chain: AgentLoopStepRecord[] = [];
    let step: AgentLoopStepRecord | undefined = current;
    for (let count = 0; step !== undefined && count < 256; count += 1) {
      chain.push(step);
      if (step.predecessor === undefined) break;
      const previous: Option.Option<AgentLoopStepRecord> =
        yield* dependencies.tx.transact(steps.find(step.predecessor));
      if (previous._tag === "None") return null;
      step = previous.value;
    }
    if (step?.predecessor !== undefined) return null;
    chain.sort((left, right) =>
      compareActionOrder(left.identity, right.identity),
    );

    const actions: Array<{
      readonly step: AgentLoopStepRecord;
      readonly action: AgentLoopStepActionRecord;
    }> = [];
    for (const candidate of chain) {
      const records = yield* dependencies.tx.transact(
        steps.listActions(candidate.identity),
      );
      for (const action of records) actions.push({ step: candidate, action });
    }
    actions.sort(
      (left, right) =>
        compareActionOrder(left.action.identity, right.action.identity) ||
        left.action.actionIndex - right.action.actionIndex,
    );
    const terminalDenials: Array<{
      readonly step: AgentLoopStepRecord;
      readonly action: AgentLoopStepActionRecord;
      readonly terminalDenial: BlockedActionRef["terminalDenial"];
    }> = [];
    for (const row of actions) {
      if (
        row.action.state !== "TerminalRejected" ||
        row.action.routeKind !== "Executable"
      ) {
        continue;
      }
      const disposition = row.action.disposition;
      const record =
        typeof disposition === "object" &&
        disposition !== null &&
        !Array.isArray(disposition)
          ? (disposition as Record<string, unknown>)
          : null;
      const terminalDenial = terminalDenialOf(record?.terminalDenial);
      if (
        record?.status !== "Denied" ||
        terminalDenial === null ||
        row.action.resultRef === undefined ||
        row.action.settlementRef === undefined ||
        row.action.observationSourceRef === undefined
      ) {
        // A legacy or malformed P9 row is not upgraded from its free-form
        // disposition. The Agent must explicitly repair/dispose it first.
        return null;
      }
      terminalDenials.push({ ...row, terminalDenial });
    }
    const unresolved = terminalDenials.filter((denied) => {
      const laterSuccess = actions.some(
        (candidate) =>
          candidate.action.routeKind === "Executable" &&
          candidate.action.state === "Applied" &&
          candidate.action.actionKind === denied.action.actionKind &&
          candidate.action.inputHash === denied.action.inputHash &&
          compareActionOrder(
            candidate.action.identity,
            denied.action.identity,
          ) > 0 &&
          candidate.action.disposition !== undefined &&
          typeof candidate.action.disposition === "object" &&
          candidate.action.disposition !== null &&
          (candidate.action.disposition as Record<string, unknown>).status ===
            "Succeeded",
      );
      return !laterSuccess;
    });
    if (unresolved.length === 0) return null;
    const mappedRefs = unresolved.map(
      ({ step: item, action, terminalDenial }) => ({
        executionId: execution.executionId,
        providerTurnId: item.providerTurnId,
        logicalStepNo: item.identity.logicalStepNo,
        repairAttempt: item.identity.repairAttempt,
        actionIndex: action.actionIndex,
        logicalActionId: action.logicalActionId,
        callRef: action.callRef,
        resultRef: action.resultRef as string,
        settlementRef: action.settlementRef as string,
        observationSourceRef: action.observationSourceRef as string,
        terminalDenial,
      }),
    );
    const firstRef = mappedRefs[0];
    if (firstRef === undefined) return null;
    const refs = [firstRef, ...mappedRefs.slice(1)] as const;
    const verification = yield* Effect.match(
      dependencies.tx.transact(
        verifyBlockedActionRefs(
          { executionId: execution.executionId, refs },
          { loopSteps: steps, providerTurns: turns },
        ),
      ),
      {
        onFailure: (cause) => ({ ok: false as const, cause }),
        onSuccess: (value) => ({ ok: true as const, value }),
      },
    );
    if (!verification.ok) {
      if (
        typeof verification.cause === "object" &&
        verification.cause !== null &&
        "_tag" in verification.cause &&
        verification.cause._tag === "BlockedActionEvidenceInvalid"
      ) {
        return null;
      }
      return yield* Effect.fail(verification.cause);
    }
    const verified = verification.value;
    const failureFingerprint = blockedFailureFingerprint(verified);
    const blockerId = workBlockerIdentity({
      projectId: execution.projectId,
      workId: episode.workId,
      targetWorkRevision: episode.targetWorkRevision,
      failureFingerprint,
    });
    const observedSequence = yield* dependencies.tx.transact(
      inbox.currentSequence(execution.workspaceId),
    );
    return {
      _tag: "Completed",
      result: {
        _tag: "Blocked",
        workId: episode.workId,
        targetWorkRevision: episode.targetWorkRevision as WorkRevision,
        blockerId: blockerId as never,
        waitFor: {
          mode: "Any",
          conditions: [
            { _tag: "Manual" },
            {
              _tag: "InboxAdvanced",
              workspaceId: execution.workspaceId,
              observedSequence,
            },
          ],
        },
        request,
        failedActionRefs: refs,
      },
    };
  });
