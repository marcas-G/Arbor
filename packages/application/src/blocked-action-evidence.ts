import type {
  BlockedActionRef,
  ExecutionId,
  ProjectId,
  TerminalActionDenial,
  WorkId,
  WorkRevision,
} from "@arbor/domain";
import type {
  AgentLoopStepActionRecord,
  AgentLoopStepIdentity,
  AgentLoopStepStoreError,
  AgentLoopStepStoreService,
  ProviderFailure,
  ProviderTurnStoreService,
  TransactionScope,
} from "@arbor/ports";
import { sha256Hex } from "@arbor/ports";
import { Effect, Option } from "effect";

export interface VerifiedBlockedAction {
  readonly ref: BlockedActionRef;
  readonly actionDefinition: {
    readonly stableId: string;
    readonly version: string;
    readonly hash: string;
  };
  readonly routeKind: "Executable";
  readonly actionKind: string;
  readonly inputHash: string;
  readonly resultStatus: "Denied";
}

export interface BlockedEvidenceDependencies {
  readonly loopSteps: Pick<AgentLoopStepStoreService, "find" | "listActions">;
  readonly providerTurns: Pick<ProviderTurnStoreService, "findManifestByTurn">;
}

export interface BlockedEvidenceError {
  readonly _tag: "BlockedActionEvidenceInvalid";
  readonly reason: string;
}

const invalid = (reason: string) =>
  Effect.fail<BlockedEvidenceError>({
    _tag: "BlockedActionEvidenceInvalid",
    reason,
  });

const recordOf = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const sameDenial = (left: TerminalActionDenial, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const findAction = (
  actions: ReadonlyArray<AgentLoopStepActionRecord>,
  ref: BlockedActionRef,
): AgentLoopStepActionRecord | undefined =>
  actions.find(
    (action) =>
      action.actionIndex === ref.actionIndex &&
      action.callRef === ref.callRef &&
      action.logicalActionId === ref.logicalActionId,
  );

const compareRef = (left: BlockedActionRef, right: BlockedActionRef): number =>
  left.logicalStepNo - right.logicalStepNo ||
  left.repairAttempt - right.repairAttempt ||
  left.actionIndex - right.actionIndex;

const identityOf = (ref: BlockedActionRef): AgentLoopStepIdentity => ({
  executionId: ref.executionId,
  logicalStepNo: ref.logicalStepNo,
  repairAttempt: ref.repairAttempt,
});

/** Resolve a caller-supplied ref set against durable P9 action rows and each
 * row's pinned ProviderTurn manifest. The Plan and transcript are not read. */
export const verifyBlockedActionRefs = (
  input: {
    readonly executionId: ExecutionId;
    readonly refs: ReadonlyArray<BlockedActionRef>;
  },
  deps: BlockedEvidenceDependencies,
): Effect.Effect<
  ReadonlyArray<VerifiedBlockedAction>,
  BlockedEvidenceError | AgentLoopStepStoreError | ProviderFailure,
  TransactionScope
> =>
  Effect.gen(function* () {
    if (input.refs.length === 0) {
      return yield* invalid("Blocked evidence is empty");
    }
    const verified: VerifiedBlockedAction[] = [];
    const byStep = new Map<string, ReadonlyArray<AgentLoopStepActionRecord>>();
    for (const ref of [...input.refs].sort(compareRef)) {
      if (ref.executionId !== input.executionId) {
        return yield* invalid("action ref belongs to another Execution");
      }
      const identity = identityOf(ref);
      const key = `${identity.logicalStepNo}:${identity.repairAttempt}`;
      let actions = byStep.get(key);
      if (actions === undefined) {
        const step = yield* deps.loopSteps.find(identity);
        if (Option.isNone(step)) {
          return yield* invalid("P9 AgentLoopStep is missing");
        }
        if (
          step.value.providerTurnId !== ref.providerTurnId ||
          step.value.manifestId === undefined
        ) {
          return yield* invalid(
            "action ref does not bind the pinned ProviderTurn manifest",
          );
        }
        actions = yield* deps.loopSteps.listActions(identity);
        byStep.set(key, actions);
      }
      const action = findAction(actions, ref);
      if (
        action === undefined ||
        action.state !== "TerminalRejected" ||
        action.routeKind !== "Executable" ||
        action.resultRef !== ref.resultRef ||
        action.settlementRef !== ref.settlementRef ||
        action.observationSourceRef !== ref.observationSourceRef
      ) {
        return yield* invalid(
          "ref does not match an exact TerminalRejected executable action",
        );
      }
      const disposition = recordOf(action.disposition);
      if (
        disposition?.status !== "Denied" ||
        !sameDenial(ref.terminalDenial, disposition.terminalDenial)
      ) {
        return yield* invalid(
          "TerminalRejected action lacks the paired typed Denied ToolResult",
        );
      }
      const manifest = yield* deps.providerTurns.findManifestByTurn(
        ref.providerTurnId,
      );
      const step = yield* deps.loopSteps.find(identity);
      if (
        Option.isNone(step) ||
        manifest === null ||
        manifest.manifestId !== step.value.manifestId
      ) {
        return yield* invalid(
          "pinned manifest receipt is missing or mismatched",
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(manifest.manifestJson);
      } catch {
        return yield* invalid("pinned manifest JSON is invalid");
      }
      const manifestRecord = recordOf(parsed);
      const routes = manifestRecord?.toolRoutes;
      if (
        manifestRecord?.executionId !== input.executionId ||
        manifestRecord.providerTurnId !== ref.providerTurnId ||
        manifestRecord.logicalStepNo !== ref.logicalStepNo ||
        manifestRecord.repairAttempt !== ref.repairAttempt ||
        !Array.isArray(routes)
      ) {
        return yield* invalid(
          "pinned manifest identity does not match action ref",
        );
      }
      const route = routes
        .map(recordOf)
        .find(
          (candidate) =>
            candidate?.name === action.actionKind &&
            candidate.route === "Executable",
        );
      if (
        route === undefined ||
        route === null ||
        typeof route.stableId !== "string" ||
        typeof route.version !== "string" ||
        typeof route.hash !== "string"
      ) {
        return yield* invalid(
          "manifest has no exact executable action definition",
        );
      }
      verified.push({
        ref,
        actionDefinition: {
          stableId: route.stableId,
          version: route.version,
          hash: route.hash,
        },
        routeKind: "Executable",
        actionKind: action.actionKind,
        inputHash: action.inputHash,
        resultStatus: "Denied",
      });
    }
    return verified;
  });

export const blockedFailureFingerprint = (
  actions: ReadonlyArray<VerifiedBlockedAction>,
): string =>
  sha256Hex(
    JSON.stringify(
      [...actions]
        .sort((left, right) => compareRef(left.ref, right.ref))
        .map((action) => ({
          ref: action.ref,
          actionDefinition: action.actionDefinition,
          routeKind: action.routeKind,
          actionKind: action.actionKind,
          inputHash: action.inputHash,
          resultStatus: action.resultStatus,
        })),
    ),
  );

export const workBlockerIdentity = (input: {
  readonly projectId: ProjectId;
  readonly workId: WorkId;
  readonly targetWorkRevision: WorkRevision;
  readonly failureFingerprint: string;
}): string =>
  sha256Hex(
    JSON.stringify([
      input.projectId,
      input.workId,
      input.targetWorkRevision,
      input.failureFingerprint,
    ]),
  );
