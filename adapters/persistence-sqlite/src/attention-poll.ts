import type { ProjectId } from "@arbor/domain";
import {
  AttentionPollStore,
  type AttentionPollStoreError,
  type AttentionPollStoreService,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { P10_ATTENTION_CONSUMER_ID } from "./consumer.js";
import { repositoryFailure } from "./repository-error.js";

interface DispatchRow {
  readonly next_attempt_sequence: number;
  readonly active_project_id: string | null;
  readonly lease_owner: string | null;
  readonly lease_generation: number;
  readonly claim_started_at: string | null;
  readonly lease_expires_at: string | null;
}

interface FailureStateRow {
  readonly consecutive_failed_attempts: number;
}

const timestampMs = (value: string): number => Date.parse(value);

const safeBackoffDelay = (
  failedAttempts: number,
  baseBackoffMs: number,
  maxBackoffMs: number,
  exponentCap: number,
): number => {
  const exponent = Math.min(Math.max(0, failedAttempts - 1), exponentCap);
  const multiplier = 2 ** exponent;
  if (
    !Number.isFinite(multiplier) ||
    baseBackoffMs > maxBackoffMs / multiplier
  ) {
    return maxBackoffMs;
  }
  return Math.min(maxBackoffMs, baseBackoffMs * multiplier);
};

const validBackoff = (input: {
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly backoffExponentCap: number;
}): boolean =>
  Number.isSafeInteger(input.baseBackoffMs) &&
  input.baseBackoffMs > 0 &&
  Number.isSafeInteger(input.maxBackoffMs) &&
  input.maxBackoffMs >= input.baseBackoffMs &&
  Number.isSafeInteger(input.backoffExponentCap) &&
  input.backoffExponentCap >= 0;

const addDelay = (at: string, delay: number): string => {
  const parsed = timestampMs(at);
  if (!Number.isFinite(parsed)) return at;
  const latest = 8_640_000_000_000_000;
  return new Date(Math.min(latest, parsed + delay)).toISOString();
};

export const AttentionPollStoreLive: Layer.Layer<
  AttentionPollStore,
  never,
  SqlClient
> = Layer.effect(
  AttentionPollStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(
        Effect.mapError(repositoryFailure("AttentionPollStore", "dispatcher")),
      );

    const readDispatch = () =>
      run(
        sql.unsafe<DispatchRow>(
          `SELECT next_attempt_sequence, active_project_id, lease_owner,
                  lease_generation, claim_started_at, lease_expires_at
             FROM p10_attention_dispatch_state WHERE singleton = 1`,
        ),
      );

    const finalizeExpired = (
      projectId: string,
      failedAt: string,
      backoff: {
        readonly baseBackoffMs: number;
        readonly maxBackoffMs: number;
        readonly backoffExponentCap: number;
      },
    ) =>
      Effect.gen(function* () {
        const state = yield* run(
          sql.unsafe<FailureStateRow>(
            `SELECT consecutive_failed_attempts
               FROM p10_attention_project_poll_state WHERE project_id = ?`,
            [projectId],
          ),
        );
        const attempts = Number(state[0]?.consecutive_failed_attempts ?? 0) + 1;
        const delay = safeBackoffDelay(
          attempts,
          backoff.baseBackoffMs,
          backoff.maxBackoffMs,
          backoff.backoffExponentCap,
        );
        yield* run(
          sql.unsafe(
            `UPDATE p10_attention_project_poll_state
                SET consecutive_failed_attempts = ?, next_eligible_at = ?,
                    last_failure_code = 'PollLeaseExpired', last_failure_at = ?
              WHERE project_id = ?`,
            [attempts, addDelay(failedAt, delay), failedAt, projectId],
          ),
        );
      });

    return AttentionPollStore.of({
      tryClaim: (input) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const nowMs = timestampMs(input.now);
          if (
            !Number.isFinite(nowMs) ||
            !Number.isSafeInteger(input.leaseTtlMs) ||
            input.leaseTtlMs <= 0 ||
            nowMs + input.leaseTtlMs > 8_640_000_000_000_000 ||
            !validBackoff(input)
          ) {
            return yield* Effect.fail<AttentionPollStoreError>({
              _tag: "PersistenceCorruption",
              repository: "AttentionPollStore",
              operation: "claim",
              reason: "invalid Attention poll lease or backoff parameters",
            });
          }
          const dispatchRows = yield* readDispatch();
          const dispatch = dispatchRows[0];
          if (dispatch === undefined) {
            return yield* Effect.fail<AttentionPollStoreError>({
              _tag: "PersistenceCorruption",
              repository: "AttentionPollStore",
              operation: "claim",
              reason: "Attention dispatcher singleton is missing",
            });
          }
          if (
            dispatch.lease_expires_at !== null &&
            !Number.isFinite(timestampMs(dispatch.lease_expires_at))
          ) {
            return yield* Effect.fail<AttentionPollStoreError>({
              _tag: "PersistenceCorruption",
              repository: "AttentionPollStore",
              operation: "claim",
              reason: "Attention dispatcher lease expiry is malformed",
            });
          }
          if (
            dispatch.lease_expires_at !== null &&
            timestampMs(dispatch.lease_expires_at) > nowMs
          ) {
            return { _tag: "NoClaim" as const };
          }

          if (dispatch.active_project_id !== null) {
            yield* finalizeExpired(
              dispatch.active_project_id,
              input.now,
              input,
            );
          }

          yield* run(
            sql.unsafe(
              `INSERT OR IGNORE INTO p10_attention_project_poll_state
                 (project_id, last_attempt_sequence, next_eligible_at)
               SELECT p.project_id,
                      (SELECT next_attempt_sequence FROM p10_attention_dispatch_state
                        WHERE singleton = 1),
                      ?
                 FROM projects AS p
                WHERE p.lifecycle = 'Open'
                  AND (
                    EXISTS (SELECT 1 FROM deliver_replay_attention_pending AS q
                             WHERE q.project_id = p.project_id)
                    OR EXISTS (
                      SELECT 1 FROM project_event_sequences AS seq
                      LEFT JOIN consumer_offsets AS off
                        ON off.consumer_id = ? AND off.project_id = seq.project_id
                       WHERE seq.project_id = p.project_id
                         AND seq.last_sequence > COALESCE(off.last_sequence, 0)
                    )
                  )`,
              [input.now, P10_ATTENTION_CONSUMER_ID],
            ),
          );
          const eligible = yield* run(
            sql.unsafe<{ readonly project_id: string }>(
              `SELECT state.project_id
                 FROM p10_attention_project_poll_state AS state
                 JOIN projects AS p ON p.project_id = state.project_id
                WHERE p.lifecycle = 'Open'
                  AND state.next_eligible_at <= ?
                  AND (
                    EXISTS (SELECT 1 FROM deliver_replay_attention_pending AS q
                             WHERE q.project_id = state.project_id)
                    OR EXISTS (
                      SELECT 1 FROM project_event_sequences AS seq
                      LEFT JOIN consumer_offsets AS off
                        ON off.consumer_id = ? AND off.project_id = seq.project_id
                       WHERE seq.project_id = state.project_id
                         AND seq.last_sequence > COALESCE(off.last_sequence, 0)
                    )
                  )
                ORDER BY state.last_attempt_sequence, state.project_id
                LIMIT 1`,
              [input.now, P10_ATTENTION_CONSUMER_ID],
            ),
          );
          const projectId = eligible[0]?.project_id;
          if (projectId === undefined) {
            if (dispatch.active_project_id !== null) {
              yield* run(
                sql.unsafe(
                  `UPDATE p10_attention_dispatch_state
                      SET active_project_id = NULL, lease_owner = NULL,
                          claim_started_at = NULL, lease_expires_at = NULL
                    WHERE singleton = 1 AND lease_generation = ?
                      AND active_project_id = ? AND lease_expires_at <= ?`,
                  [
                    dispatch.lease_generation,
                    dispatch.active_project_id,
                    input.now,
                  ],
                ),
              );
            }
            return { _tag: "NoClaim" as const };
          }
          const leaseExpiresAt = new Date(
            nowMs + input.leaseTtlMs,
          ).toISOString();
          const claimRows = yield* run(
            sql.unsafe<{
              readonly lease_generation: number;
              readonly attempt_sequence: number;
            }>(
              `UPDATE p10_attention_dispatch_state
                  SET active_project_id = ?, lease_owner = ?,
                      lease_generation = lease_generation + 1,
                      claim_started_at = ?, lease_expires_at = ?,
                      next_attempt_sequence = next_attempt_sequence + 1
                WHERE singleton = 1 AND lease_generation = ?
                  AND (lease_owner IS NULL OR lease_expires_at <= ?)
                RETURNING lease_generation,
                          next_attempt_sequence - 1 AS attempt_sequence`,
              [
                projectId,
                input.leaseOwner,
                input.now,
                leaseExpiresAt,
                dispatch.lease_generation,
                input.now,
              ],
            ),
          );
          const claimed = claimRows[0];
          if (claimed === undefined) return { _tag: "NoClaim" as const };
          yield* run(
            sql.unsafe(
              `UPDATE p10_attention_project_poll_state
                  SET last_attempt_sequence = ? WHERE project_id = ?`,
              [claimed.attempt_sequence, projectId],
            ),
          );
          return {
            _tag: "Claimed" as const,
            claim: {
              projectId: projectId as ProjectId,
              leaseOwner: input.leaseOwner,
              leaseGeneration: Number(claimed.lease_generation),
              attemptSequence: Number(claimed.attempt_sequence),
              leaseExpiresAt,
            },
          };
        }),
      isCurrentClaim: (claim, now) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<{ readonly present: number }>(
              `SELECT 1 AS present FROM p10_attention_dispatch_state
                WHERE singleton = 1 AND active_project_id = ?
                  AND lease_owner = ? AND lease_generation = ?
                  AND lease_expires_at > ?`,
              [claim.projectId, claim.leaseOwner, claim.leaseGeneration, now],
            ),
          );
          return rows.length === 1;
        }),
      completeSuccess: (claim, completedAt) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const current = yield* run(
            sql.unsafe<{ readonly present: number }>(
              `SELECT 1 AS present FROM p10_attention_dispatch_state
                WHERE singleton = 1 AND active_project_id = ?
                  AND lease_owner = ? AND lease_generation = ?
                  AND lease_expires_at > ?`,
              [
                claim.projectId,
                claim.leaseOwner,
                claim.leaseGeneration,
                completedAt,
              ],
            ),
          );
          if (current.length !== 1) return false;
          yield* run(
            sql.unsafe(
              `UPDATE p10_attention_project_poll_state
                  SET consecutive_failed_attempts = 0,
                      last_failure_code = NULL, last_failure_at = NULL
                WHERE project_id = ?`,
              [claim.projectId],
            ),
          );
          yield* run(
            sql.unsafe(
              `UPDATE p10_attention_dispatch_state
                  SET active_project_id = NULL, lease_owner = NULL,
                      claim_started_at = NULL, lease_expires_at = NULL
                WHERE singleton = 1 AND active_project_id = ?
                  AND lease_owner = ? AND lease_generation = ?
                  AND lease_expires_at > ?`,
              [
                claim.projectId,
                claim.leaseOwner,
                claim.leaseGeneration,
                completedAt,
              ],
            ),
          );
          return true;
        }),
      recordFailure: (claim, failureCode, failedAt, backoff) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          if (
            !validBackoff(backoff) ||
            !Number.isFinite(timestampMs(failedAt))
          ) {
            return yield* Effect.fail<AttentionPollStoreError>({
              _tag: "PersistenceCorruption",
              repository: "AttentionPollStore",
              operation: "failure",
              reason:
                "invalid Attention poll failure time or backoff parameters",
            });
          }
          const current = yield* run(
            sql.unsafe<{ readonly present: number }>(
              `SELECT 1 AS present FROM p10_attention_dispatch_state
                WHERE singleton = 1 AND active_project_id = ?
                  AND lease_owner = ? AND lease_generation = ?
                  AND lease_expires_at > ?`,
              [
                claim.projectId,
                claim.leaseOwner,
                claim.leaseGeneration,
                failedAt,
              ],
            ),
          );
          if (current.length !== 1) return false;
          const state = yield* run(
            sql.unsafe<FailureStateRow>(
              `SELECT consecutive_failed_attempts
                 FROM p10_attention_project_poll_state WHERE project_id = ?`,
              [claim.projectId],
            ),
          );
          const attempts =
            Number(state[0]?.consecutive_failed_attempts ?? 0) + 1;
          const delay = safeBackoffDelay(
            attempts,
            backoff.baseBackoffMs,
            backoff.maxBackoffMs,
            backoff.backoffExponentCap,
          );
          yield* run(
            sql.unsafe(
              `UPDATE p10_attention_project_poll_state
                  SET consecutive_failed_attempts = ?, next_eligible_at = ?,
                      last_failure_code = ?, last_failure_at = ?
                WHERE project_id = ?`,
              [
                attempts,
                addDelay(failedAt, delay),
                failureCode,
                failedAt,
                claim.projectId,
              ],
            ),
          );
          yield* run(
            sql.unsafe(
              `UPDATE p10_attention_dispatch_state
                  SET active_project_id = NULL, lease_owner = NULL,
                      claim_started_at = NULL, lease_expires_at = NULL
                WHERE singleton = 1 AND active_project_id = ?
                  AND lease_owner = ? AND lease_generation = ?
                  AND lease_expires_at > ?`,
              [
                claim.projectId,
                claim.leaseOwner,
                claim.leaseGeneration,
                failedAt,
              ],
            ),
          );
          return true;
        }),
    } satisfies AttentionPollStoreService);
  }),
);
