import {
  decodeCanonicalExecutionEpisodeBinding,
  type EventId,
  type ExecutionId,
  encodeExecutionEpisodeBinding,
  type ProjectId,
  type SandboxProfile,
  type SandboxProviderId,
  type WorkspaceId,
} from "@arbor/domain";
import {
  DomainEventJournal,
  IdGenerator,
  type RecordSandboxProviderUnavailableInput,
  SANDBOX_UNAVAILABLE_ATTENTION_BATCH_MAX,
  SANDBOX_UNAVAILABLE_ATTENTION_CLAIM_TTL_MS,
  SandboxProviderUnavailableAttentionQueue,
  type SandboxProviderUnavailableAttentionQueueClaim,
  type SandboxProviderUnavailableAttentionQueueService,
  type SandboxProviderUnavailableFactV1,
  SandboxProviderUnavailableStore,
  type SandboxProviderUnavailableStoreError,
  type SandboxProviderUnavailableStoreService,
  sha256Hex,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  persistenceCorruption,
  repositoryFailure,
} from "./repository-error.js";

interface FactDbRow {
  readonly attention_fact_id: string;
  readonly event_id: string;
  readonly project_id: string;
  readonly execution_id: string;
  readonly workspace_id: string;
  readonly episode_binding_json: string;
  readonly policy_revision: number;
  readonly policy_digest: string;
  readonly profile_id: string;
  readonly provider_id: string;
  readonly provider_version: string;
  readonly probe_evidence_ref: string | null;
  readonly failure_code: string;
  readonly first_detected_at: string;
}

const FACT_COLUMNS = `attention_fact_id, event_id, project_id, execution_id,
  workspace_id, episode_binding_json, policy_revision, policy_digest,
  profile_id, provider_id, provider_version, probe_evidence_ref, failure_code,
  first_detected_at`;
const digestPattern = /^[0-9a-f]{64}$/u;
const profiles: ReadonlyArray<string> = [
  "ReadOnly",
  "WorkspaceWrite",
  "FullAccess",
];

const canonicalUtc = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
};

const validFailureCode = (value: string): boolean => {
  const bytes = new TextEncoder().encode(value).length;
  return (
    bytes > 0 && bytes <= 128 && value.trim() === value && value.length > 0
  );
};

export const sandboxProviderUnavailableFactIdV1 = (
  executionId: string,
  policyRevision: number,
): string =>
  `att_${sha256Hex(
    JSON.stringify({ version: 1, executionId, policyRevision }),
  )}`;

const toFact = (row: FactDbRow): SandboxProviderUnavailableFactV1 => {
  const episodeBinding = decodeCanonicalExecutionEpisodeBinding(
    row.episode_binding_json,
  );
  const invalid: Array<string> = [];
  if (
    episodeBinding === undefined ||
    encodeExecutionEpisodeBinding(episodeBinding) !== row.episode_binding_json
  )
    invalid.push("episodeBinding");
  if (!Number.isSafeInteger(row.policy_revision) || row.policy_revision < 1)
    invalid.push("policyRevision");
  if (!digestPattern.test(row.policy_digest)) invalid.push("policyDigest");
  if (!profiles.includes(row.profile_id)) invalid.push("profileId");
  if (
    row.provider_id.trim() !== row.provider_id ||
    row.provider_id.length === 0
  )
    invalid.push("providerId");
  if (
    row.provider_version.trim() !== row.provider_version ||
    row.provider_version.length === 0
  )
    invalid.push("providerVersion");
  if (
    row.probe_evidence_ref !== null &&
    (row.probe_evidence_ref.trim() !== row.probe_evidence_ref ||
      row.probe_evidence_ref.length === 0)
  )
    invalid.push("probeEvidenceRef");
  if (!validFailureCode(row.failure_code)) invalid.push("failureCode");
  if (!canonicalUtc(row.first_detected_at)) invalid.push("firstDetectedAt");
  if (
    row.attention_fact_id !==
    sandboxProviderUnavailableFactIdV1(row.execution_id, row.policy_revision)
  )
    invalid.push("attentionFactId");
  if (row.event_id.length === 0) invalid.push("eventId");
  if (invalid.length > 0) {
    throw new TypeError(
      `persisted sandbox provider unavailable fact malformed: ${invalid.join(",")}`,
    );
  }
  if (episodeBinding === undefined) {
    throw new TypeError(
      "persisted sandbox provider unavailable episode binding is invalid",
    );
  }
  return {
    attentionFactId: row.attention_fact_id,
    eventId: row.event_id as EventId,
    projectId: row.project_id as ProjectId,
    executionId: row.execution_id as ExecutionId,
    workspaceId: row.workspace_id as WorkspaceId,
    episodeBinding,
    policyRevision: row.policy_revision,
    policyDigest: row.policy_digest,
    profileId: row.profile_id as SandboxProfile,
    providerId: row.provider_id as SandboxProviderId,
    providerVersion: row.provider_version,
    probeEvidenceRef: row.probe_evidence_ref,
    failureCode: row.failure_code,
    firstDetectedAt: row.first_detected_at,
  };
};

const rowMatchesInput = (
  fact: SandboxProviderUnavailableFactV1,
  input: RecordSandboxProviderUnavailableInput,
): boolean => {
  const { outcome } = input;
  return (
    fact.projectId === outcome.projectId &&
    fact.executionId === outcome.executionId &&
    fact.workspaceId === outcome.workspaceId &&
    encodeExecutionEpisodeBinding(fact.episodeBinding) ===
      encodeExecutionEpisodeBinding(outcome.episodeBinding) &&
    fact.policyRevision === outcome.policyRevision &&
    fact.policyDigest === outcome.policyDigest &&
    fact.profileId === outcome.profileId &&
    fact.providerId === outcome.providerId &&
    fact.providerVersion === outcome.providerVersion &&
    fact.probeEvidenceRef === outcome.probeEvidenceRef &&
    fact.failureCode === outcome.failureCode
  );
};

const invariant = (reason: string): SandboxProviderUnavailableStoreError => ({
  _tag: "SandboxProviderUnavailableFactInvariantConflict",
  reason,
});

const makeFactLayer = () =>
  Layer.effect(
    SandboxProviderUnavailableStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const journal = yield* DomainEventJournal;
      const ids = yield* IdGenerator;
      const run = <A>(effect: Effect.Effect<A, SqlError>) =>
        effect.pipe(
          Effect.mapError(
            repositoryFailure(
              "SandboxProviderUnavailableStore",
              "provider-unavailable-fact",
            ),
          ),
        );
      const readByTuple = (executionId: ExecutionId, policyRevision: number) =>
        run(
          sql.unsafe<FactDbRow>(
            `SELECT ${FACT_COLUMNS}
               FROM sandbox_provider_unavailable_facts
              WHERE execution_id = ? AND policy_revision = ?`,
            [executionId, policyRevision],
          ),
        );
      const readByEvent = (eventId: EventId) =>
        run(
          sql.unsafe<FactDbRow>(
            `SELECT ${FACT_COLUMNS}
               FROM sandbox_provider_unavailable_facts WHERE event_id = ?`,
            [eventId],
          ),
        );
      const decodeRows = (rows: ReadonlyArray<FactDbRow>, operation: string) =>
        Effect.try({
          try: () => rows.map(toFact),
          catch: (cause) =>
            persistenceCorruption(
              "SandboxProviderUnavailableStore",
              operation,
              cause instanceof TypeError
                ? cause.message
                : "persisted sandbox provider unavailable fact failed strict decoding",
            ),
        });
      const assertFence = (input: {
        readonly executionId: ExecutionId;
        readonly workerId: string;
        readonly workerIncarnationId: string;
        readonly fencingGeneration: number;
        readonly now: string;
      }) =>
        Effect.gen(function* () {
          const rows = yield* run(
            sql.unsafe<{ readonly ok: number }>(
              `SELECT 1 AS ok
                 FROM executions AS e
                 JOIN execution_leases AS l ON l.execution_id = e.execution_id
                WHERE e.execution_id = ? AND e.settled_at IS NULL
                  AND e.stop_requested_at IS NULL
                  AND l.worker_id = ? AND l.worker_incarnation_id = ?
                  AND l.generation = ? AND l.expires_at > ?`,
              [
                input.executionId,
                input.workerId,
                input.workerIncarnationId,
                input.fencingGeneration,
                input.now,
              ],
            ),
          );
          if (rows.length !== 1) {
            return yield* Effect.fail<SandboxProviderUnavailableStoreError>({
              _tag: "LeaseFencingRejected",
              executionId: input.executionId,
              generation: input.fencingGeneration,
            });
          }
        });

      const record: SandboxProviderUnavailableStoreService["record"] = (
        input,
      ) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const { outcome, fence, firstDetectedAt } = input;
          if (
            outcome.executionId !== fence.executionId ||
            !Number.isSafeInteger(outcome.policyRevision) ||
            outcome.policyRevision < 1 ||
            !digestPattern.test(outcome.policyDigest) ||
            !profiles.includes(outcome.profileId) ||
            outcome.providerId.trim() !== outcome.providerId ||
            outcome.providerId.length === 0 ||
            outcome.providerVersion.trim() !== outcome.providerVersion ||
            outcome.providerVersion.length === 0 ||
            (outcome.probeEvidenceRef !== null &&
              (outcome.probeEvidenceRef.trim() !== outcome.probeEvidenceRef ||
                outcome.probeEvidenceRef.length === 0)) ||
            !validFailureCode(outcome.failureCode) ||
            !canonicalUtc(firstDetectedAt)
          ) {
            return yield* Effect.fail(
              invariant("sandbox outcome input is malformed"),
            );
          }
          yield* assertFence({ ...fence, now: firstDetectedAt });
          const episodeJson = encodeExecutionEpisodeBinding(
            outcome.episodeBinding,
          );
          const sourceRows = yield* run(
            sql.unsafe<{
              readonly project_id: string;
              readonly workspace_id: string;
              readonly episode_binding_json: string;
              readonly policy_digest: string;
              readonly profile_id: string;
              readonly provider_id: string;
              readonly policy_revision: number;
            }>(
              `SELECT e.project_id, e.workspace_id, s.episode_json AS episode_binding_json,
                      d.policy_digest, d.profile_id, d.provider_id, d.policy_revision
                 FROM executions e
                 JOIN agent_execution_state s ON s.execution_id = e.execution_id
                 JOIN sandbox_policy_decisions d ON d.execution_id = e.execution_id
                  AND d.project_id = e.project_id AND d.workspace_id = e.workspace_id
                  AND d.episode_binding_json = s.episode_json
                WHERE e.execution_id = ? AND e.settled_at IS NULL
                  AND e.stop_requested_at IS NULL AND d.policy_revision = ?`,
              [outcome.executionId, outcome.policyRevision],
            ),
          );
          if (
            sourceRows.length !== 1 ||
            sourceRows[0]?.project_id !== outcome.projectId ||
            sourceRows[0]?.workspace_id !== outcome.workspaceId ||
            sourceRows[0]?.episode_binding_json !== episodeJson ||
            sourceRows[0]?.policy_digest !== outcome.policyDigest ||
            sourceRows[0]?.profile_id !== outcome.profileId ||
            sourceRows[0]?.provider_id !== outcome.providerId
          ) {
            return yield* Effect.fail(
              invariant(
                "provider outcome does not match the exact active policy decision",
              ),
            );
          }
          const appendWithIds = journal.appendWithIds;
          if (appendWithIds === undefined) {
            return yield* Effect.fail(
              persistenceCorruption(
                "SandboxProviderUnavailableStore",
                "provider-unavailable-fact",
                "domain journal cannot persist the reserved wake-event identity",
              ),
            );
          }
          const existingRows = yield* readByTuple(
            outcome.executionId,
            outcome.policyRevision,
          );
          const existingRow = existingRows[0];
          if (existingRow !== undefined) {
            const [fact] = yield* decodeRows([existingRow], "record-read");
            if (fact === undefined || !rowMatchesInput(fact, input)) {
              return yield* Effect.fail(
                invariant(
                  "non-identical provider unavailable retry conflicts with the immutable fact",
                ),
              );
            }
            return fact;
          }

          const attentionFactId = sandboxProviderUnavailableFactIdV1(
            outcome.executionId,
            outcome.policyRevision,
          );
          const eventId = yield* ids.generate<EventId>("Event");
          yield* run(
            sql.unsafe(
              `INSERT INTO sandbox_provider_unavailable_facts (
                 attention_fact_id, event_id, project_id, execution_id,
                 workspace_id, episode_binding_json, policy_revision,
                 policy_digest, profile_id, provider_id, provider_version,
                 probe_evidence_ref, failure_code, first_detected_at
               ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              [
                attentionFactId,
                eventId,
                outcome.projectId,
                outcome.executionId,
                outcome.workspaceId,
                episodeJson,
                outcome.policyRevision,
                outcome.policyDigest,
                outcome.profileId,
                outcome.providerId,
                outcome.providerVersion,
                outcome.probeEvidenceRef,
                outcome.failureCode,
                firstDetectedAt,
              ],
            ),
          );
          yield* run(
            sql.unsafe(
              `INSERT INTO sandbox_provider_unavailable_attention_queue (
                 project_id, attention_fact_id, workspace_id, state,
                 claim_id, claim_expires_at, attempt_count, enqueued_at,
                 consumed_at
               ) VALUES (?,?,?,'Pending',NULL,NULL,0,?,NULL)`,
              [
                outcome.projectId,
                attentionFactId,
                outcome.workspaceId,
                firstDetectedAt,
              ],
            ),
          );
          yield* appendWithIds([
            {
              eventId,
              draft: {
                projectId: outcome.projectId,
                eventType: "SandboxProviderUnavailable",
                eventVersion: 1,
                occurredAt: firstDetectedAt,
                aggregateRef: outcome.executionId,
                actor: "system:recovery" as never,
                correlationRef: attentionFactId,
                payload: {
                  attentionFactId,
                  executionId: outcome.executionId,
                  workspaceId: outcome.workspaceId,
                  policyRevision: outcome.policyRevision,
                },
              },
            },
          ]);
          return {
            attentionFactId,
            eventId,
            projectId: outcome.projectId,
            executionId: outcome.executionId,
            workspaceId: outcome.workspaceId,
            episodeBinding: outcome.episodeBinding,
            policyRevision: outcome.policyRevision,
            policyDigest: outcome.policyDigest,
            profileId: outcome.profileId,
            providerId: outcome.providerId,
            providerVersion: outcome.providerVersion,
            probeEvidenceRef: outcome.probeEvidenceRef,
            failureCode: outcome.failureCode,
            firstDetectedAt,
          } satisfies SandboxProviderUnavailableFactV1;
        });

      const findByExecutionAndRevision: SandboxProviderUnavailableStoreService["findByExecutionAndRevision"] =
        (executionId, policyRevision) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const rows = yield* readByTuple(executionId, policyRevision);
            const decoded = yield* decodeRows(
              rows,
              "find-by-execution-revision",
            );
            return decoded[0];
          });
      const findByEventId: SandboxProviderUnavailableStoreService["findByEventId"] =
        (eventId) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const rows = yield* readByEvent(eventId);
            const decoded = yield* decodeRows(rows, "find-by-event-id");
            return decoded[0];
          });
      const list: SandboxProviderUnavailableStoreService["list"] = (
        projectId,
      ) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<FactDbRow>(
              `SELECT ${FACT_COLUMNS} FROM sandbox_provider_unavailable_facts
                WHERE project_id = ? ORDER BY first_detected_at, attention_fact_id`,
              [projectId],
            ),
          );
          return yield* decodeRows(rows, "list");
        });

      return SandboxProviderUnavailableStore.of({
        record,
        findByExecutionAndRevision,
        findByEventId,
        list,
      });
    }),
  );

const makeQueueLayer = () =>
  Layer.effect(
    SandboxProviderUnavailableAttentionQueue,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const ids = yield* IdGenerator;
      const run = <A>(effect: Effect.Effect<A, SqlError>) =>
        effect.pipe(
          Effect.mapError(
            repositoryFailure(
              "SandboxProviderUnavailableStore",
              "provider-unavailable-attention-queue",
            ),
          ),
        );
      const claimBatch: SandboxProviderUnavailableAttentionQueueService["claimBatch"] =
        (input) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            if (
              !canonicalUtc(input.now) ||
              !Number.isSafeInteger(input.claimTtlMs) ||
              input.claimTtlMs !== SANDBOX_UNAVAILABLE_ATTENTION_CLAIM_TTL_MS ||
              !Number.isSafeInteger(input.limit) ||
              input.limit <= 0 ||
              input.limit > SANDBOX_UNAVAILABLE_ATTENTION_BATCH_MAX
            ) {
              return yield* Effect.fail(
                persistenceCorruption(
                  "SandboxProviderUnavailableStore",
                  "queue-claim",
                  "claim time, TTL or batch size is invalid",
                ),
              );
            }
            const expiresAtMillis =
              Date.parse(input.now) +
              SANDBOX_UNAVAILABLE_ATTENTION_CLAIM_TTL_MS;
            if (
              !Number.isFinite(expiresAtMillis) ||
              Math.abs(expiresAtMillis) > 8.64e15
            ) {
              return yield* Effect.fail(
                persistenceCorruption(
                  "SandboxProviderUnavailableStore",
                  "queue-claim",
                  "claim expiry exceeds the finite canonical UTC date range",
                ),
              );
            }
            const claimExpiresAt = new Date(expiresAtMillis).toISOString();
            const rows = yield* run(
              sql.unsafe<{
                readonly attention_fact_id: string;
                readonly workspace_id: string;
                readonly enqueued_at: string;
                readonly attempt_count: number;
              }>(
                `SELECT attention_fact_id, workspace_id, enqueued_at, attempt_count
                 FROM sandbox_provider_unavailable_attention_queue
                WHERE project_id = ? AND (
                      (state = 'Pending' AND enqueued_at <= ?) OR
                      (state = 'Claimed' AND claim_expires_at <= ?))
                ORDER BY enqueued_at, project_id, attention_fact_id LIMIT ?`,
                [input.projectId, input.now, input.now, input.limit],
              ),
            );
            const claims: SandboxProviderUnavailableAttentionQueueClaim[] = [];
            for (const row of rows) {
              const claimId = yield* ids.generate<string>(
                "sandbox-attention-claim",
              );
              const updated = yield* run(
                sql.unsafe<{ readonly claim_id: string }>(
                  `UPDATE sandbox_provider_unavailable_attention_queue
                    SET state = 'Claimed', claim_id = ?, claim_expires_at = ?,
                        attempt_count = attempt_count + 1
                  WHERE project_id = ? AND attention_fact_id = ?
                    AND (state = 'Pending' OR
                         (state = 'Claimed' AND claim_expires_at <= ?))
                 RETURNING claim_id`,
                  [
                    claimId,
                    claimExpiresAt,
                    input.projectId,
                    row.attention_fact_id,
                    input.now,
                  ],
                ),
              );
              if (updated.length !== 0) {
                claims.push({
                  projectId: input.projectId,
                  attentionFactId: row.attention_fact_id,
                  workspaceId: row.workspace_id as WorkspaceId,
                  claimId,
                  claimExpiresAt,
                  attemptCount: row.attempt_count + 1,
                  enqueuedAt: row.enqueued_at,
                });
              }
            }
            return claims;
          });
      const consume: SandboxProviderUnavailableAttentionQueueService["consume"] =
        (input) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const { claim } = input;
            if (!canonicalUtc(input.now)) {
              return yield* Effect.fail(
                persistenceCorruption(
                  "SandboxProviderUnavailableStore",
                  "queue-consume",
                  "consume time is invalid",
                ),
              );
            }
            const rows = yield* run(
              sql.unsafe<{
                readonly attention_fact_id: string;
                readonly workspace_id: string;
                readonly state: string;
                readonly claim_id: string | null;
                readonly claim_expires_at: string | null;
                readonly attempt_count: number;
                readonly enqueued_at: string;
              }>(
                `SELECT attention_fact_id, workspace_id, state, claim_id,
                      claim_expires_at, attempt_count, enqueued_at
                 FROM sandbox_provider_unavailable_attention_queue
                WHERE project_id = ? AND attention_fact_id = ?`,
                [claim.projectId, claim.attentionFactId],
              ),
            );
            const queue = rows[0];
            if (
              queue === undefined ||
              queue.state !== "Claimed" ||
              queue.claim_id !== claim.claimId ||
              queue.claim_expires_at !== claim.claimExpiresAt ||
              queue.claim_expires_at <= input.now ||
              queue.workspace_id !== claim.workspaceId
            ) {
              return undefined;
            }
            const factRows = yield* run(
              sql.unsafe<FactDbRow>(
                `SELECT ${FACT_COLUMNS}
                 FROM sandbox_provider_unavailable_facts
                WHERE project_id = ? AND attention_fact_id = ?
                  AND workspace_id = ?`,
                [claim.projectId, claim.attentionFactId, claim.workspaceId],
              ),
            );
            if (factRows.length !== 1) {
              return yield* Effect.fail(
                invariant("claimed queue row has no unique P9 source fact"),
              );
            }
            let fact: SandboxProviderUnavailableFactV1;
            try {
              fact = toFact(factRows[0] as FactDbRow);
            } catch (cause) {
              return yield* Effect.fail(
                persistenceCorruption(
                  "SandboxProviderUnavailableStore",
                  "queue-consume",
                  cause instanceof TypeError
                    ? cause.message
                    : "source fact failed strict decoding",
                ),
              );
            }
            const currentRows = yield* run(
              sql.unsafe<{
                readonly workspace_id: string;
                readonly episode_json: string;
                readonly settled_at: string | null;
                readonly stop_requested_at: string | null;
                readonly policy_digest: string;
                readonly profile_id: string;
                readonly provider_id: string;
                readonly policy_revision: number;
              }>(
                `SELECT e.workspace_id, s.episode_json, e.settled_at,
                      e.stop_requested_at, d.policy_digest, d.profile_id,
                      d.provider_id, d.policy_revision
                 FROM executions e
                 JOIN agent_execution_state s ON s.execution_id = e.execution_id
                 JOIN sandbox_policy_decisions d ON d.execution_id = e.execution_id
                  AND d.workspace_id = e.workspace_id AND d.project_id = e.project_id
                  AND d.episode_binding_json = s.episode_json
                  AND d.policy_revision = (
                    SELECT MAX(d2.policy_revision) FROM sandbox_policy_decisions d2
                     WHERE d2.execution_id = e.execution_id
                       AND d2.episode_binding_json = s.episode_json
                  )
                WHERE e.execution_id = ? AND e.project_id = ?`,
                [fact.executionId, fact.projectId],
              ),
            );
            const current = currentRows[0];
            const currentStale =
              current === undefined ||
              current.policy_revision !== fact.policyRevision ||
              current.workspace_id !== fact.workspaceId ||
              current.episode_json !==
                encodeExecutionEpisodeBinding(fact.episodeBinding) ||
              current.settled_at !== null ||
              current.stop_requested_at !== null;
            if (
              !currentStale &&
              (current.policy_digest !== fact.policyDigest ||
                current.profile_id !== fact.profileId ||
                current.provider_id !== fact.providerId)
            ) {
              return yield* Effect.fail(
                invariant(
                  "current policy decision conflicts with the unavailable source fact",
                ),
              );
            }
            if (currentStale) {
              yield* run(
                sql.unsafe<{ readonly attention_fact_id: string }>(
                  `UPDATE sandbox_provider_unavailable_attention_queue
                    SET state = 'Consumed', claim_id = NULL,
                        claim_expires_at = NULL, consumed_at = ?
                  WHERE project_id = ? AND attention_fact_id = ?
                    AND state = 'Claimed' AND claim_id = ?
                 RETURNING attention_fact_id`,
                  [
                    input.now,
                    claim.projectId,
                    claim.attentionFactId,
                    claim.claimId,
                  ],
                ),
              );
              return undefined;
            }
            yield* run(
              sql.unsafe(
                `INSERT INTO sandbox_provider_unavailable_attention_rows
                 (project_id, attention_fact_id, workspace_id)
               VALUES (?,?,?) ON CONFLICT(project_id, attention_fact_id) DO NOTHING`,
                [fact.projectId, fact.attentionFactId, fact.workspaceId],
              ),
            );
            const markerRows = yield* run(
              sql.unsafe<{ readonly workspace_id: string }>(
                `SELECT workspace_id FROM sandbox_provider_unavailable_attention_rows
                WHERE project_id = ? AND attention_fact_id = ?`,
                [fact.projectId, fact.attentionFactId],
              ),
            );
            if (
              markerRows.length !== 1 ||
              markerRows[0]?.workspace_id !== fact.workspaceId
            ) {
              return yield* Effect.fail(
                invariant(
                  "sandbox attention marker binding conflicts with source fact",
                ),
              );
            }
            yield* run(
              sql.unsafe(
                `UPDATE sandbox_provider_unavailable_attention_queue
                  SET state = 'Consumed', claim_id = NULL,
                      claim_expires_at = NULL, consumed_at = ?
                WHERE project_id = ? AND attention_fact_id = ?
                  AND state = 'Claimed' AND claim_id = ?`,
                [
                  input.now,
                  claim.projectId,
                  claim.attentionFactId,
                  claim.claimId,
                ],
              ),
            );
            return fact;
          });
      const rearm: SandboxProviderUnavailableAttentionQueueService["rearm"] = (
        fact,
      ) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const sourceRows = yield* run(
            sql.unsafe<FactDbRow>(
              `SELECT ${FACT_COLUMNS}
                 FROM sandbox_provider_unavailable_facts
                WHERE project_id = ? AND attention_fact_id = ?`,
              [fact.projectId, fact.attentionFactId],
            ),
          );
          if (sourceRows.length !== 1) {
            return yield* Effect.fail(
              invariant("queue re-arm has no unique P9 source fact"),
            );
          }
          let source: SandboxProviderUnavailableFactV1;
          try {
            source = toFact(sourceRows[0] as FactDbRow);
          } catch {
            return yield* Effect.fail(
              persistenceCorruption(
                "SandboxProviderUnavailableStore",
                "queue-rearm",
                "source fact failed strict decoding",
              ),
            );
          }
          if (
            source.eventId !== fact.eventId ||
            source.projectId !== fact.projectId ||
            source.executionId !== fact.executionId ||
            source.workspaceId !== fact.workspaceId ||
            encodeExecutionEpisodeBinding(source.episodeBinding) !==
              encodeExecutionEpisodeBinding(fact.episodeBinding) ||
            source.policyRevision !== fact.policyRevision ||
            source.policyDigest !== fact.policyDigest ||
            source.profileId !== fact.profileId ||
            source.providerId !== fact.providerId ||
            source.providerVersion !== fact.providerVersion ||
            source.probeEvidenceRef !== fact.probeEvidenceRef ||
            source.failureCode !== fact.failureCode ||
            source.firstDetectedAt !== fact.firstDetectedAt
          ) {
            return yield* Effect.fail(
              invariant(
                "queue re-arm fact binding conflicts with the immutable P9 row",
              ),
            );
          }
          const rows = yield* run(
            sql.unsafe<{
              readonly workspace_id: string;
              readonly enqueued_at: string;
            }>(
              `SELECT workspace_id, enqueued_at
                 FROM sandbox_provider_unavailable_attention_queue
                WHERE project_id = ? AND attention_fact_id = ?`,
              [fact.projectId, fact.attentionFactId],
            ),
          );
          if (rows.length === 0) {
            yield* run(
              sql.unsafe(
                `INSERT INTO sandbox_provider_unavailable_attention_queue
                   (project_id, attention_fact_id, workspace_id, state,
                    claim_id, claim_expires_at, attempt_count, enqueued_at,
                    consumed_at)
                 VALUES (?,?,?,'Pending',NULL,NULL,0,?,NULL)`,
                [
                  fact.projectId,
                  fact.attentionFactId,
                  fact.workspaceId,
                  fact.firstDetectedAt,
                ],
              ),
            );
            return;
          }
          const row = rows[0];
          if (
            rows.length !== 1 ||
            row?.workspace_id !== fact.workspaceId ||
            row.enqueued_at !== fact.firstDetectedAt
          ) {
            return yield* Effect.fail(
              invariant("sandbox queue identity conflicts with source fact"),
            );
          }
          yield* run(
            sql.unsafe(
              `UPDATE sandbox_provider_unavailable_attention_queue
                  SET state = 'Pending', claim_id = NULL,
                      claim_expires_at = NULL, consumed_at = NULL
                WHERE project_id = ? AND attention_fact_id = ?`,
              [fact.projectId, fact.attentionFactId],
            ),
          );
        });
      return SandboxProviderUnavailableAttentionQueue.of({
        claimBatch,
        consume,
        rearm,
      });
    }),
  );

export const SandboxProviderUnavailableStoreLive = makeFactLayer();
export const SandboxProviderUnavailableAttentionQueueLive = makeQueueLayer();
