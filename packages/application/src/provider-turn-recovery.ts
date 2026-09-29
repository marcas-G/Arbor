import type {
  ExecutionId,
  Principal,
  ProjectId,
  ProviderTurnId,
} from "@arbor/domain";
import {
  Clock,
  type ClockService,
  decideProviderRetry,
  noAttemptObservation,
  type ProviderContinuationCheckpoint,
  type ProviderFailure,
  type ProviderRetryDecision,
  ProviderTurnStore,
  type ProviderTurnStoreService,
  providerRetryCauseFromAttempt,
  type TransactionOperationalFailure,
  TransactionPort,
  type TransactionPortService,
  type UnsettledProviderTurn,
  unknownAttemptObservation,
} from "@arbor/ports";
import { Effect } from "effect";

/** Recovery plan produced by the same durable-evidence retry decision used
 * by live Provider Runtime. Recovery itself never calls a provider. */
export interface ProviderTurnRetryPlanEntry {
  readonly providerTurnId: ProviderTurnId;
  readonly executionId: ExecutionId;
  readonly manifestId: string;
  readonly manifestJson: string;
  readonly portableRequestJson: string;
  readonly nextAttemptNo: number;
  readonly lastProviderErrorKind: string | null;
  readonly retryDecision: ProviderRetryDecision;
  readonly continuationCheckpoint?: ProviderContinuationCheckpoint;
}

export interface ProviderTurnFailureMark {
  readonly providerTurnId: ProviderTurnId;
  readonly executionId: ExecutionId;
  readonly providerErrorKind: string | null;
  readonly exhausted: boolean;
  readonly markedBy: Principal;
  readonly retryDecision: ProviderRetryDecision | null;
}

export interface ProviderTurnRecoveryReport {
  readonly retryPlan: ReadonlyArray<ProviderTurnRetryPlanEntry>;
  readonly failedTurns: ReadonlyArray<ProviderTurnFailureMark>;
}

export interface ProviderTurnRecoveryDeps {
  readonly turns: ProviderTurnStoreService;
  readonly tx: TransactionPortService;
  readonly clock: ClockService;
}

export const providerTurnRecoveryDeps: Effect.Effect<
  ProviderTurnRecoveryDeps,
  never,
  ProviderTurnStore | TransactionPort | Clock
> = Effect.gen(function* () {
  const turns = yield* ProviderTurnStore;
  const tx = yield* TransactionPort;
  const clock = yield* Clock;
  return { turns, tx, clock };
});

const nextAttemptNo = (turn: UnsettledProviderTurn): number =>
  turn.attempts.reduce((max, attempt) => Math.max(max, attempt.attemptNo), -1) +
  1;

const manifestMatchesTurn = (entry: UnsettledProviderTurn): boolean => {
  if (entry.manifestJson === null || entry.portableRequestJson === null) {
    return false;
  }
  try {
    const manifest = JSON.parse(entry.manifestJson) as Record<string, unknown>;
    const request = JSON.parse(entry.portableRequestJson) as Record<
      string,
      unknown
    >;
    return (
      manifest.providerTurnId === entry.turn.providerTurnId &&
      manifest.executionId === entry.turn.executionId &&
      manifest.sessionId === entry.turn.sessionId &&
      manifest.contextEpoch === entry.turn.contextEpoch &&
      manifest.modelRef === entry.turn.modelRef &&
      manifest.outputContractRef === entry.turn.outputContractRef &&
      typeof manifest.compiledRequestHash === "string" &&
      request.modelRef === entry.turn.modelRef &&
      request.outputContractRef === entry.turn.outputContractRef &&
      Array.isArray(request.instructions) &&
      Array.isArray(request.messages) &&
      Array.isArray(request.toolDefinitions)
    );
  } catch {
    return false;
  }
};

const turnDeadlineExpired = (turn: UnsettledProviderTurn): boolean =>
  turn.turn.turnDeadlineAt !== undefined &&
  Date.parse(turn.turn.turnDeadlineAt) <= Date.now();

const unresolvedDecision = (reason: string): ProviderRetryDecision => ({
  safety: "UnsafeReplay",
  decision: "Stop",
  strategy: null,
  reason,
});

export const recoverUnsettledProviderTurns = (
  deps: ProviderTurnRecoveryDeps,
  projectId: ProjectId,
  principal: Principal,
): Effect.Effect<
  ProviderTurnRecoveryReport,
  ProviderFailure | TransactionOperationalFailure,
  never
> =>
  Effect.gen(function* () {
    const dangling = yield* deps.tx.transact(
      deps.turns.findUnsettledByProject(projectId),
    );
    const retryPlan: Array<ProviderTurnRetryPlanEntry> = [];
    const failedTurns: Array<ProviderTurnFailureMark> = [];
    for (const entry of dangling) {
      const last = entry.attempts.at(-1) ?? null;
      const kind = last?.providerErrorKind ?? null;
      const policy = entry.turn.executionPolicy;
      const evidence =
        last === null ? noAttemptObservation() : (last.observation ?? null);
      const cause = providerRetryCauseFromAttempt(last);
      let retryDecision: ProviderRetryDecision;
      if (!manifestMatchesTurn(entry)) {
        retryDecision = unresolvedDecision(
          "durable ProviderTurn → ModelContextManifest binding is missing or mismatched",
        );
      } else if (policy === undefined || evidence === null) {
        retryDecision = unresolvedDecision(
          "persisted attempt evidence or execution limits are incomplete",
        );
      } else {
        retryDecision = decideProviderRetry({
          cause,
          observation: evidence,
          continuationCheckpoint: last?.continuationCheckpoint ?? null,
          attemptNo: last?.attemptNo ?? -1,
          maxAttempts: policy.maxAttempts,
          cancelled: last?.outcome === "Cancelled",
          deadlineExpired: turnDeadlineExpired(entry),
        });
      }

      const decisionEvidence = {
        attemptNo: last?.attemptNo ?? -1,
        cause,
        retryDecision,
        decidedAt: yield* deps.clock.now(),
      } as const;
      if (retryDecision.decision === "Retry") {
        if (entry.manifestJson === null || entry.portableRequestJson === null) {
          // manifestMatchesTurn above rejects this branch, retained as a
          // defensive guard if the projection changes independently.
          return yield* Effect.fail<ProviderFailure>({
            _tag: "ProviderFailure",
            kind: "UnknownProviderFailure",
            taxonomyVersion: "phase1-v2",
            safeDiagnostic: "retry-plan-manifest-missing",
          });
        }
        yield* deps.tx.transact(
          Effect.gen(function* () {
            yield* deps.turns.recordRecoveryDecision(
              entry.turn.providerTurnId,
              decisionEvidence,
            );
            if (last?.outcome === "InProgress") {
              yield* deps.turns.settleAttempt(
                entry.turn.providerTurnId,
                last.attemptNo,
                {
                  outcome: "RetryableFailure",
                  taxonomyVersion: "phase1-v2",
                  observation: last.observation ?? unknownAttemptObservation(),
                  canonicalEventPrefixJson:
                    last.canonicalEventPrefixJson ?? "[]",
                  deliveredPosition: last.deliveredPosition ?? 0,
                  ...(last.continuationCheckpoint === null ||
                  last.continuationCheckpoint === undefined
                    ? {}
                    : {
                        continuationCheckpoint: last.continuationCheckpoint,
                      }),
                  retryDecision,
                },
                decisionEvidence.decidedAt,
              );
            }
          }),
        );
        retryPlan.push({
          providerTurnId: entry.turn.providerTurnId,
          executionId: entry.turn.executionId,
          manifestId: entry.turn.manifestId,
          manifestJson: entry.manifestJson,
          portableRequestJson: entry.portableRequestJson,
          nextAttemptNo: nextAttemptNo(entry),
          lastProviderErrorKind: kind,
          retryDecision,
          ...(retryDecision.strategy === "Resume" &&
          last?.continuationCheckpoint !== null &&
          last?.continuationCheckpoint !== undefined
            ? { continuationCheckpoint: last.continuationCheckpoint }
            : {}),
        });
        continue;
      }

      const settledAt = yield* deps.clock.now();
      yield* deps.tx.transact(
        Effect.gen(function* () {
          yield* deps.turns.recordRecoveryDecision(
            entry.turn.providerTurnId,
            decisionEvidence,
          );
          if (last?.outcome === "InProgress") {
            yield* deps.turns.settleAttempt(
              entry.turn.providerTurnId,
              last.attemptNo,
              {
                outcome: "TerminalFailure",
                taxonomyVersion: "phase1-v2",
                observation: last.observation ?? unknownAttemptObservation(),
                canonicalEventPrefixJson: last.canonicalEventPrefixJson ?? "[]",
                deliveredPosition: last.deliveredPosition ?? 0,
                ...(last.continuationCheckpoint === null ||
                last.continuationCheckpoint === undefined
                  ? {}
                  : {
                      continuationCheckpoint: last.continuationCheckpoint,
                    }),
                retryDecision,
              },
              decisionEvidence.decidedAt,
            );
          }
          yield* deps.turns.failTurn(entry.turn.providerTurnId, settledAt);
        }),
      );
      failedTurns.push({
        providerTurnId: entry.turn.providerTurnId,
        executionId: entry.turn.executionId,
        providerErrorKind: kind,
        exhausted:
          policy !== undefined && nextAttemptNo(entry) >= policy.maxAttempts,
        markedBy: principal,
        retryDecision,
      });
    }
    return { retryPlan, failedTurns };
  });
