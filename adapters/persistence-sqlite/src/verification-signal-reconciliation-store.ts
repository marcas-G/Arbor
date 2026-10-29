import type {
  VerificationSignalReconciliationIdentity,
  VerificationSignalReconciliationPhase,
  VerificationSignalReconciliationRow,
  VerificationSignalReconciliationStoreService,
} from "@arbor/ports";
import { VerificationSignalReconciliationStore } from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  persistenceCorruption,
  repositoryFailure,
} from "./repository-error.js";

interface DbRow {
  readonly consumer_id: string;
  readonly project_id: string;
  readonly event_sequence: number;
  readonly event_id: string | null;
  readonly source_command_id: string | null;
  readonly verification_id: string | null;
  readonly work_id: string | null;
  readonly work_revision: number | null;
  readonly verdict: "Pass" | "Fail" | "Unknown" | null;
  readonly owner_workspace_id: string | null;
  readonly parent_workspace_id: string | null;
  readonly source_digest: string | null;
  readonly effect_plan_digest: string | null;
  readonly phase: VerificationSignalReconciliationPhase;
  readonly failure_code: VerificationSignalReconciliationRow["failureCode"];
  readonly attention_fact_id: string | null;
  readonly lease_owner: string | null;
  readonly lease_generation: number;
  readonly lease_expires_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const toRow = (row: DbRow): VerificationSignalReconciliationRow => ({
  consumerId: "workflow-signals",
  projectId: row.project_id as never,
  eventSequence: Number(row.event_sequence),
  eventId: row.event_id as never,
  sourceCommandId: row.source_command_id,
  verificationId: row.verification_id,
  workId: row.work_id,
  workRevision: row.work_revision === null ? null : Number(row.work_revision),
  verdict: row.verdict,
  ownerWorkspaceId: row.owner_workspace_id as never,
  parentWorkspaceId: row.parent_workspace_id as never,
  sourceDigest: row.source_digest,
  effectPlanDigest: row.effect_plan_digest,
  phase: row.phase,
  failureCode: row.failure_code,
  attentionFactId: row.attention_fact_id,
  leaseOwner: row.lease_owner,
  leaseGeneration: Number(row.lease_generation),
  leaseExpiresAt: row.lease_expires_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const identityArgs = (identity: VerificationSignalReconciliationIdentity) => [
  identity.consumerId,
  identity.projectId,
  identity.eventSequence,
];

const canonicalUtc = (value: string): boolean => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};

export const VerificationSignalReconciliationStoreLive = Layer.effect(
  VerificationSignalReconciliationStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const run = <A>(
      effect: Effect.Effect<A, SqlError>,
      operation = "reconciliation",
    ) =>
      effect.pipe(
        Effect.mapError(
          repositoryFailure("VerificationSignalReconciliationStore", operation),
        ),
      );
    const find = (identity: VerificationSignalReconciliationIdentity) =>
      Effect.gen(function* () {
        const rows = yield* run(
          sql.unsafe<DbRow>(
            `SELECT * FROM verification_signal_reconciliations
              WHERE consumer_id = ? AND project_id = ? AND event_sequence = ?`,
            identityArgs(identity),
          ),
        );
        return rows[0] === undefined ? null : toRow(rows[0]);
      });
    return VerificationSignalReconciliationStore.of({
      listDeadLetterCandidates: (input) =>
        Effect.gen(function* () {
          if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
            return yield* Effect.fail(
              persistenceCorruption(
                "VerificationSignalReconciliationStore",
                "list-dead-letter-candidates",
                "candidate batch limit must be a positive safe integer",
              ),
            );
          }
          const rows = yield* run(
            sql.unsafe<{
              readonly event_id: unknown;
              readonly project_id: unknown;
              readonly sequence: unknown;
              readonly event_type: unknown;
              readonly event_version: unknown;
              readonly occurred_at: unknown;
              readonly aggregate_ref: unknown;
              readonly actor: unknown;
              readonly caused_by_command_id: unknown;
              readonly caused_by_event_id: unknown;
              readonly correlation_ref: unknown;
              readonly payload_json: unknown;
              readonly reason: string;
            }>(
              `SELECT event.event_id, event.project_id, event.sequence,
                      event.event_type, event.event_version, event.occurred_at,
                      event.aggregate_ref, event.actor,
                      event.caused_by_command_id, event.caused_by_event_id,
                      event.correlation_ref, event.payload_json,
                      dead_letter.reason
                 FROM consumer_dead_letters AS dead_letter
                 JOIN domain_events AS event
                   ON event.project_id = dead_letter.project_id
                  AND event.sequence = dead_letter.sequence
                WHERE dead_letter.consumer_id = 'workflow-signals'
                  AND dead_letter.project_id = ?
                  AND NOT EXISTS (
                    SELECT 1 FROM verification_signal_reconciliations AS reconciliation
                     WHERE reconciliation.consumer_id = dead_letter.consumer_id
                       AND reconciliation.project_id = dead_letter.project_id
                       AND reconciliation.event_sequence = dead_letter.sequence
                       AND (
                         reconciliation.phase IN ('Completed', 'Attention')
                         OR reconciliation.lease_expires_at > ?
                       )
                  )
                  AND dead_letter.reason IN (
                    'unsupported eventVersion 2', 'malformed event payload'
                  )
                  AND event.event_type = 'VerificationConcluded'
                  AND event.event_version = 2
                ORDER BY event.sequence LIMIT ?`,
              [input.projectId, input.now, input.limit],
            ),
          );
          return rows.map((row) => ({
            eventIdRaw: row.event_id,
            projectIdRaw: row.project_id,
            sequenceRaw: row.sequence,
            eventTypeRaw: row.event_type,
            eventVersionRaw: row.event_version,
            occurredAtRaw: row.occurred_at,
            aggregateRefRaw: row.aggregate_ref,
            actorRaw: row.actor,
            causedByCommandIdRaw: row.caused_by_command_id,
            causedByEventIdRaw: row.caused_by_event_id,
            correlationRefRaw: row.correlation_ref,
            payloadJsonRaw: row.payload_json,
            deadLetterReason: row.reason,
          }));
        }),
      activationHighwater: (projectId) =>
        Effect.gen(function* () {
          const rows = yield* run(
            sql.unsafe<{
              readonly project_id: unknown;
              readonly max_event_sequence: unknown;
              readonly captured_at: unknown;
              readonly fact_digest: unknown;
            }>(
              `SELECT project_id, max_event_sequence, captured_at, fact_digest
                 FROM verification_conclusion_v2_activation_highwaters
                WHERE project_id = ?`,
              [projectId],
            ),
          );
          const row = rows[0];
          return row === undefined
            ? null
            : {
                projectIdRaw: row.project_id,
                maxEventSequenceRaw: row.max_event_sequence,
                capturedAtRaw: row.captured_at,
                factDigestRaw: row.fact_digest,
              };
        }),
      find: (identity) =>
        Effect.gen(function* () {
          const row = yield* find(identity);
          return row;
        }),
      insertPending: (source, leaseOwner, leaseExpiresAt, now) =>
        Effect.gen(function* () {
          const { identity } = source;
          yield* run(
            sql.unsafe(
              `INSERT INTO verification_signal_reconciliations (
                consumer_id, project_id, event_sequence, event_id,
                source_command_id, verification_id, work_id, work_revision,
                verdict, owner_workspace_id, parent_workspace_id,
                source_digest, effect_plan_digest, phase, failure_code,
                attention_fact_id, lease_owner, lease_generation,
                lease_expires_at, created_at, updated_at
              ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'Pending',NULL,NULL,?,1,?,?,?)
              ON CONFLICT(consumer_id, project_id, event_sequence) DO NOTHING`,
              [
                identity.consumerId,
                identity.projectId,
                identity.eventSequence,
                source.eventId,
                source.sourceCommandId,
                source.verificationId,
                source.workId,
                source.workRevision,
                source.verdict,
                source.ownerWorkspaceId,
                source.parentWorkspaceId,
                source.sourceDigest,
                source.effectPlanDigest,
                leaseOwner,
                leaseExpiresAt,
                now,
                now,
              ],
            ),
            "insert-pending",
          );
          const stored = yield* find(identity);
          if (
            stored === null ||
            stored.eventId !== source.eventId ||
            stored.sourceCommandId !== source.sourceCommandId ||
            stored.verificationId !== source.verificationId ||
            stored.workId !== source.workId ||
            stored.workRevision !== source.workRevision ||
            stored.verdict !== source.verdict ||
            stored.ownerWorkspaceId !== source.ownerWorkspaceId ||
            stored.parentWorkspaceId !== source.parentWorkspaceId ||
            stored.sourceDigest !== source.sourceDigest ||
            stored.effectPlanDigest !== source.effectPlanDigest
          ) {
            return yield* Effect.fail(
              persistenceCorruption(
                "VerificationSignalReconciliationStore",
                "insert-pending",
                "workflow reconciliation identity is bound to a different source",
              ),
            );
          }
          return stored;
        }),
      claimBatch: (input) =>
        Effect.gen(function* () {
          if (
            input.leaseOwner.length === 0 ||
            !canonicalUtc(input.now) ||
            !Number.isSafeInteger(input.leaseTtlMs) ||
            input.leaseTtlMs <= 0 ||
            !Number.isSafeInteger(input.limit) ||
            input.limit <= 0
          ) {
            return yield* Effect.fail(
              persistenceCorruption(
                "VerificationSignalReconciliationStore",
                "claim-batch",
                "invalid lease or batch policy",
              ),
            );
          }
          const expiresAt = new Date(
            Date.parse(input.now) + input.leaseTtlMs,
          ).toISOString();
          const candidates = yield* run(
            sql.unsafe<{
              readonly project_id: string;
              readonly event_sequence: number;
              readonly lease_generation: number;
            }>(
              `SELECT project_id, event_sequence, lease_generation
                 FROM verification_signal_reconciliations
                WHERE project_id = ?
                  AND phase NOT IN ('Completed','Attention')
                  AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
                ORDER BY event_sequence LIMIT ?`,
              [input.projectId, input.now, input.limit],
            ),
          );
          for (const candidate of candidates) {
            yield* run(
              sql.unsafe(
                `UPDATE verification_signal_reconciliations
                    SET lease_owner = ?, lease_generation = lease_generation + 1,
                        lease_expires_at = ?, updated_at = ?
                  WHERE consumer_id = 'workflow-signals' AND project_id = ?
                    AND event_sequence = ? AND lease_generation = ?
                    AND phase NOT IN ('Completed','Attention')
                    AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
                [
                  input.leaseOwner,
                  expiresAt,
                  input.now,
                  candidate.project_id,
                  candidate.event_sequence,
                  candidate.lease_generation,
                  input.now,
                ],
              ),
            );
          }
          const rows = yield* run(
            sql.unsafe<DbRow>(
              `SELECT * FROM verification_signal_reconciliations
                WHERE project_id = ? AND lease_owner = ? AND lease_expires_at = ?
                  AND phase NOT IN ('Completed','Attention')
                ORDER BY event_sequence LIMIT ?`,
              [input.projectId, input.leaseOwner, expiresAt, input.limit],
            ),
          );
          return rows.map(toRow);
        }),
      claim: (input) =>
        Effect.gen(function* () {
          if (
            input.leaseOwner.length === 0 ||
            !canonicalUtc(input.now) ||
            !Number.isSafeInteger(input.leaseTtlMs) ||
            input.leaseTtlMs <= 0
          ) {
            return yield* Effect.fail(
              persistenceCorruption(
                "VerificationSignalReconciliationStore",
                "claim",
                "invalid lease policy",
              ),
            );
          }
          const expiresAt = new Date(
            Date.parse(input.now) + input.leaseTtlMs,
          ).toISOString();
          yield* run(
            sql.unsafe(
              `UPDATE verification_signal_reconciliations
                  SET lease_owner = ?, lease_generation = lease_generation + 1,
                      lease_expires_at = ?, updated_at = ?
                WHERE consumer_id = ? AND project_id = ? AND event_sequence = ?
                  AND phase NOT IN ('Completed','Attention')
                  AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
                RETURNING event_sequence`,
              [
                input.leaseOwner,
                expiresAt,
                input.now,
                ...identityArgs(input.identity),
                input.now,
              ],
            ),
          );
          const claimed = yield* find(input.identity);
          return claimed?.leaseOwner === input.leaseOwner &&
            claimed.leaseExpiresAt === expiresAt
            ? claimed
            : null;
        }),
      advance: (input) =>
        Effect.gen(function* () {
          const allowed: Readonly<Record<string, ReadonlyArray<string>>> = {
            Pending: ["VerificationWakeDelivered"],
            VerificationWakeDelivered: ["ParentInboxCommitted", "Completed"],
            ParentInboxCommitted: ["ParentWakeDelivered"],
            ParentWakeDelivered: ["Completed"],
          };
          if (
            !allowed[input.expectedPhase]?.includes(input.nextPhase) ||
            !canonicalUtc(input.now)
          ) {
            return yield* Effect.fail(
              persistenceCorruption(
                "VerificationSignalReconciliationStore",
                "advance",
                "illegal reconciliation phase transition or timestamp",
              ),
            );
          }
          const rows = yield* run(
            sql.unsafe(
              `UPDATE verification_signal_reconciliations
                  SET phase = ?,
                      lease_owner = CASE WHEN ? = 'Completed' THEN NULL ELSE lease_owner END,
                      lease_expires_at = CASE WHEN ? = 'Completed' THEN NULL ELSE lease_expires_at END,
                      updated_at = ?
                WHERE consumer_id = ? AND project_id = ? AND event_sequence = ?
                  AND phase = ? AND lease_owner = ? AND lease_generation = ?
                  AND lease_expires_at > ?
                RETURNING event_sequence`,
              [
                input.nextPhase,
                input.nextPhase,
                input.nextPhase,
                input.now,
                ...identityArgs(input.identity),
                input.expectedPhase,
                input.leaseOwner,
                input.leaseGeneration,
                input.now,
              ],
            ),
          );
          return rows.length === 1;
        }),
      recordAttention: (input) =>
        Effect.gen(function* () {
          const existing = yield* find(input.identity);
          if (
            existing?.eventId !== null &&
            existing?.eventId !== undefined &&
            input.eventId !== existing.eventId
          ) {
            return yield* Effect.fail(
              persistenceCorruption(
                "VerificationSignalReconciliationStore",
                "record-attention",
                "Attention source EventId conflicts with reconciliation identity",
              ),
            );
          }
          yield* run(
            sql.unsafe(
              `INSERT INTO verification_signal_reconciliations (
                consumer_id, project_id, event_sequence, event_id, phase,
                failure_code, attention_fact_id, lease_owner, lease_generation,
                lease_expires_at, created_at, updated_at
              ) VALUES (?,?,?,?,'Attention',?,?,NULL,0,NULL,?,?)
              ON CONFLICT(consumer_id, project_id, event_sequence) DO UPDATE SET
                phase = 'Attention', failure_code = excluded.failure_code,
                attention_fact_id = excluded.attention_fact_id,
                lease_owner = NULL, lease_expires_at = NULL,
                updated_at = excluded.updated_at
              WHERE verification_signal_reconciliations.phase <> 'Attention'`,
              [
                input.identity.consumerId,
                input.identity.projectId,
                input.identity.eventSequence,
                input.eventId,
                input.failureCode,
                input.attentionFactId,
                input.firstDetectedAt,
                input.firstDetectedAt,
              ],
            ),
          );
          yield* run(
            sql.unsafe(
              `INSERT INTO verification_signal_reconciliation_attention_facts (
                attention_fact_id, source_identity, consumer_id, project_id,
                event_sequence, event_id, failure_code, evidence_digest,
                target_workspace_id, first_detected_at
              ) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_identity) DO NOTHING`,
              [
                input.attentionFactId,
                input.sourceIdentity,
                input.identity.consumerId,
                input.identity.projectId,
                input.identity.eventSequence,
                input.eventId,
                input.failureCode,
                input.evidenceDigest,
                input.targetWorkspaceId,
                input.firstDetectedAt,
              ],
            ),
          );
          const facts = yield* run(
            sql.unsafe<{
              readonly attention_fact_id: string;
              readonly event_id: string | null;
              readonly failure_code: string;
              readonly evidence_digest: string;
              readonly target_workspace_id: string;
              readonly first_detected_at: string;
            }>(
              `SELECT attention_fact_id, event_id, failure_code, evidence_digest,
                      target_workspace_id, first_detected_at
                 FROM verification_signal_reconciliation_attention_facts
                WHERE source_identity = ?`,
              [input.sourceIdentity],
            ),
          );
          const fact = facts[0];
          if (
            fact === undefined ||
            fact.attention_fact_id !== input.attentionFactId ||
            fact.event_id !== input.eventId ||
            fact.failure_code !== input.failureCode ||
            fact.evidence_digest !== input.evidenceDigest ||
            fact.target_workspace_id !== input.targetWorkspaceId ||
            fact.first_detected_at !== input.firstDetectedAt
          ) {
            return yield* Effect.fail(
              persistenceCorruption(
                "VerificationSignalReconciliationStore",
                "record-attention",
                "Attention identity conflicts with an existing immutable fact",
              ),
            );
          }
          yield* run(
            sql.unsafe(
              `INSERT INTO verification_signal_reconciliation_attention_queue (
                project_id, attention_fact_id, state, lease_owner,
                lease_generation, lease_expires_at, enqueued_at, projected_at
              ) VALUES (?,?,'Pending',NULL,0,NULL,?,NULL)
              ON CONFLICT(project_id, attention_fact_id) DO NOTHING`,
              [
                input.identity.projectId,
                input.attentionFactId,
                input.firstDetectedAt,
              ],
            ),
          );
        }),
      claimAttentionQueue: (input) =>
        Effect.gen(function* () {
          if (
            input.leaseOwner.length === 0 ||
            !canonicalUtc(input.now) ||
            !Number.isSafeInteger(input.leaseTtlMs) ||
            input.leaseTtlMs <= 0 ||
            !Number.isSafeInteger(input.limit) ||
            input.limit <= 0
          ) {
            return yield* Effect.fail(
              persistenceCorruption(
                "VerificationSignalReconciliationStore",
                "claim-attention-queue",
                "invalid lease or batch policy",
              ),
            );
          }
          const expiresAt = new Date(
            Date.parse(input.now) + input.leaseTtlMs,
          ).toISOString();
          const candidates = yield* run(
            sql.unsafe<{
              readonly attention_fact_id: string;
              readonly lease_generation: number;
            }>(
              `SELECT attention_fact_id, lease_generation
                 FROM verification_signal_reconciliation_attention_queue
                WHERE project_id = ? AND state = 'Pending'
                  AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
                ORDER BY enqueued_at, attention_fact_id LIMIT ?`,
              [input.projectId, input.now, input.limit],
            ),
          );
          for (const candidate of candidates) {
            yield* run(
              sql.unsafe(
                `UPDATE verification_signal_reconciliation_attention_queue
                    SET lease_owner = ?, lease_generation = lease_generation + 1,
                        lease_expires_at = ?
                  WHERE project_id = ? AND attention_fact_id = ? AND state = 'Pending'
                    AND lease_generation = ?
                    AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
                [
                  input.leaseOwner,
                  expiresAt,
                  input.projectId,
                  candidate.attention_fact_id,
                  candidate.lease_generation,
                  input.now,
                ],
              ),
            );
          }
          const rows = yield* run(
            sql.unsafe<{
              readonly project_id: string;
              readonly attention_fact_id: string;
              readonly lease_generation: number;
              readonly lease_expires_at: string;
            }>(
              `SELECT project_id, attention_fact_id, lease_generation, lease_expires_at
                 FROM verification_signal_reconciliation_attention_queue
                WHERE project_id = ? AND lease_owner = ? AND lease_expires_at = ? AND state = 'Pending'
                ORDER BY enqueued_at, attention_fact_id LIMIT ?`,
              [input.projectId, input.leaseOwner, expiresAt, input.limit],
            ),
          );
          return rows.map((row) => ({
            projectId: row.project_id as never,
            attentionFactId: row.attention_fact_id,
            leaseOwner: input.leaseOwner,
            leaseGeneration: Number(row.lease_generation),
            leaseExpiresAt: row.lease_expires_at,
          }));
        }),
      projectAttentionClaim: (claim, now) =>
        Effect.gen(function* () {
          const rows = yield* run(
            sql.unsafe<{
              readonly target_workspace_id: string;
              readonly root_workspace_id: string;
              readonly reconciliation_phase: string;
            }>(
              `SELECT fact.target_workspace_id, project.root_workspace_id,
                      reconciliation.phase AS reconciliation_phase
                 FROM verification_signal_reconciliation_attention_facts AS fact
                 JOIN projects AS project ON project.project_id = fact.project_id
                 JOIN verification_signal_reconciliations AS reconciliation
                   ON reconciliation.consumer_id = fact.consumer_id
                  AND reconciliation.project_id = fact.project_id
                  AND reconciliation.event_sequence = fact.event_sequence
                WHERE fact.project_id = ? AND fact.attention_fact_id = ?`,
              [claim.projectId, claim.attentionFactId],
            ),
          );
          const fact = rows[0];
          if (
            fact === undefined ||
            fact.target_workspace_id !== fact.root_workspace_id ||
            fact.reconciliation_phase !== "Attention"
          ) {
            return yield* Effect.fail(
              persistenceCorruption(
                "VerificationSignalReconciliationStore",
                "project-attention-claim",
                "Attention fact, reconciliation state, or Project root target does not bind",
              ),
            );
          }
          const queue = yield* run(
            sql.unsafe<{
              readonly state: string;
              readonly lease_owner: string | null;
              readonly lease_generation: number;
            }>(
              `SELECT state, lease_owner, lease_generation
                 FROM verification_signal_reconciliation_attention_queue
                WHERE project_id = ? AND attention_fact_id = ?`,
              [claim.projectId, claim.attentionFactId],
            ),
          );
          if (queue[0]?.state === "Projected") return false;
          if (
            queue[0]?.state !== "Pending" ||
            queue[0].lease_owner !== claim.leaseOwner ||
            Number(queue[0].lease_generation) !== claim.leaseGeneration
          )
            return false;
          const updated = yield* run(
            sql.unsafe(
              `UPDATE verification_signal_reconciliation_attention_queue
                  SET state = 'Projected', lease_owner = NULL, lease_expires_at = NULL,
                      projected_at = ?
                WHERE project_id = ? AND attention_fact_id = ? AND state = 'Pending'
                  AND lease_owner = ? AND lease_generation = ? AND lease_expires_at > ?
                RETURNING attention_fact_id`,
              [
                now,
                claim.projectId,
                claim.attentionFactId,
                claim.leaseOwner,
                claim.leaseGeneration,
                now,
              ],
            ),
          );
          if (updated.length !== 1) return false;
          yield* run(
            sql.unsafe(
              `INSERT INTO verification_signal_reconciliation_attention_rows
                (attention_fact_id, project_id) VALUES (?,?)
                ON CONFLICT(attention_fact_id) DO NOTHING`,
              [claim.attentionFactId, claim.projectId],
            ),
          );
          const marker = yield* run(
            sql.unsafe<{ readonly project_id: string }>(
              `SELECT project_id FROM verification_signal_reconciliation_attention_rows
                WHERE attention_fact_id = ?`,
              [claim.attentionFactId],
            ),
          );
          if (marker[0]?.project_id !== claim.projectId) {
            return yield* Effect.fail(
              persistenceCorruption(
                "VerificationSignalReconciliationStore",
                "project-attention-marker",
                "P10 F18 marker conflicts with its immutable attention fact",
              ),
            );
          }
          return true;
        }),
    } satisfies VerificationSignalReconciliationStoreService);
  }),
);
