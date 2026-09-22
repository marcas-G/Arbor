import type {
  ExecutionId,
  Principal,
  ProjectId,
  ProviderTurnId,
} from "@arbor/domain";
import {
  Clock,
  type ClockService,
  type ProviderFailure,
  ProviderTurnStore,
  type ProviderTurnStoreService,
  type TransactionOperationalFailure,
  TransactionPort,
  type TransactionPortService,
  type UnsettledProviderTurn,
} from "@arbor/ports";
import { Effect } from "effect";

/** P9 `04` §2.2 / `02` §6 PD4 — unsettled-ProviderTurn crash recovery
 * (P9-owned frozen surface; P3 `06` §7 deferred it here).
 *
 * Decision table (GQ4, zero new failure tags):
 *
 * ```text
 * dangling turn (settled_at IS NULL), last recorded attempt:
 *   no attempt error (crash leftover, or attempt not yet persisted)
 *     | kind ∈ {RateLimited, ProviderUnavailable, StreamInterrupted}
 *     && attempt budget NOT exhausted
 *       → ResumeRetry: same ProviderTurn, new ProviderAttempt
 *         (attempt_no = MAX+1, Turn-local); Agent turnNo unchanged; no new
 *         Manifest (DID §6A.9 — transport retry is not a new model round)
 *   retryable kind && attempt budget exhausted
 *   terminal kind (AuthenticationFailed / RequestRejected / ProtocolViolation)
 *       → TurnFailureMark: the Turn settles failed under the driver
 *         Turn-failure semantics (P3 `06` §2); Execution-level disposition
 *         follows P2 `06` §4 — recovery never invents a settlement
 * ```
 *
 * The recovery pass itself never calls the provider: a ResumeRetry entry is
 * a retry plan for the Scheduler re-dispatch; the driver resumes the
 * dangling Turn under the same `providerTurnId` + `manifestId`.
 * Provider turns carry no external side effect beyond the provider request
 * itself — tool-style `OutcomeUnknown` ambiguity does not arise
 * (P4 `06` vocabulary). */

const RETRYABLE_KINDS: ReadonlySet<string> = new Set([
  "RateLimited",
  "ProviderUnavailable",
  "StreamInterrupted",
]);

export interface ProviderTurnRetryPlanEntry {
  readonly providerTurnId: ProviderTurnId;
  readonly executionId: ExecutionId;
  readonly manifestId: string;
  /** `attempt_no = MAX+1`, Turn-local (04 §2.2 case 1). */
  readonly nextAttemptNo: number;
  readonly lastProviderErrorKind: string | null;
}

export interface ProviderTurnFailureMark {
  readonly providerTurnId: ProviderTurnId;
  readonly executionId: ExecutionId;
  readonly providerErrorKind: string | null;
  /** true = retry budget exhausted (I-6); false = terminal failure class. */
  readonly exhausted: boolean;
  readonly markedBy: Principal;
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

/** Service-resolution helper (runRecovery precedent): pulls the store /
 * transaction / clock services from the environment. */
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

export const recoverUnsettledProviderTurns = (
  deps: ProviderTurnRecoveryDeps,
  projectId: ProjectId,
  principal: Principal,
  options: { readonly maxAttempts?: number } = {},
): Effect.Effect<
  ProviderTurnRecoveryReport,
  ProviderFailure | TransactionOperationalFailure,
  never
> => {
  const maxAttempts = options.maxAttempts ?? 3;
  return Effect.gen(function* () {
    const dangling = yield* deps.tx.transact(
      deps.turns.findUnsettledByProject(projectId),
    );
    const retryPlan: Array<ProviderTurnRetryPlanEntry> = [];
    const failedTurns: Array<ProviderTurnFailureMark> = [];
    for (const entry of dangling) {
      const last = entry.attempts.at(-1) ?? null;
      const kind = last?.providerErrorKind ?? null;
      // GQ4 decision table: crash leftover (no attempt error) is retryable;
      // a recorded terminal class is never transport-retried (P3 `06` §2).
      const retryable =
        last === null
          ? true
          : last.outcome !== "TerminalFailure" &&
            (kind === null || RETRYABLE_KINDS.has(kind));
      const exhausted = entry.attempts.length >= maxAttempts;
      if (retryable && !exhausted) {
        retryPlan.push({
          providerTurnId: entry.turn.providerTurnId,
          executionId: entry.turn.executionId,
          manifestId: entry.turn.manifestId,
          nextAttemptNo: nextAttemptNo(entry),
          lastProviderErrorKind: kind,
        });
        continue;
      }
      const settledAt = yield* deps.clock.now();
      yield* deps.tx.transact(
        deps.turns.failTurn(entry.turn.providerTurnId, settledAt),
      );
      failedTurns.push({
        providerTurnId: entry.turn.providerTurnId,
        executionId: entry.turn.executionId,
        providerErrorKind: kind,
        exhausted,
        markedBy: principal,
      });
    }
    return { retryPlan, failedTurns };
  });
};
