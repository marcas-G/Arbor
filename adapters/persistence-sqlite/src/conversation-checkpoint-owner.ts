import type {
  ContextEpochNumber,
  ExecutionId,
  WorkspaceId,
} from "@arbor/domain";
import { ProviderTurnId, parse } from "@arbor/domain";
import {
  type CommitConversationCheckpointOwnerInput,
  type ConversationCheckpointFrontier,
  type ConversationCheckpointKind,
  type ConversationCheckpointOwner,
  type ConversationCheckpointOwnerConflict,
  type ConversationCheckpointSourceManifestV1,
  ConversationCheckpointStore,
  type ConversationCheckpointStoreError,
  type InitializeConversationCheckpointOwnerInput,
  isConversationCheckpointKind,
  isValidConversationCheckpointBinding,
  type LeaseFencingRejected,
  type SessionWriteFence,
  sha256Hex,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { repositoryFailure } from "./repository-error.js";

interface OwnerRow {
  readonly root_workspace_id: string;
  readonly context_epoch: number;
  readonly covered_through_created_at: string | null;
  readonly covered_through_message_id: string | null;
  readonly checkpoint_kind: string | null;
  readonly checkpoint_ref: string | null;
  readonly binding_fingerprint: string | null;
  readonly source_manifest_json: string | null;
  readonly producer_execution_id: string | null;
  readonly producer_provider_turn_id: string | null;
  readonly updated_at: string;
}

interface CurrentConversationRow {
  readonly execution_id: string;
  readonly project_id: string;
  readonly workspace_id: string;
  readonly episode_kind: string;
  readonly episode_ref: string;
  readonly episode_revision: number;
  readonly session_id: string;
  readonly worker_id: string | null;
  readonly worker_incarnation_id: string | null;
  readonly generation: number | null;
  readonly expires_at: string | null;
  readonly execution_settlement_json: string | null;
  readonly job_state: string | null;
  readonly job_project_id: string | null;
  readonly job_root_workspace_id: string | null;
  readonly active_execution_id: string | null;
  readonly response_job_revision: number | null;
  readonly next_attempt_no: number | null;
  readonly attempt_execution_id: string | null;
  readonly attempt_no: number | null;
  readonly attempt_settled_at: string | null;
  readonly attempt_settlement_kind: string | null;
  readonly attempt_retry_decision_json: string | null;
}

interface SourceMessageRow {
  readonly message_id: string;
  readonly project_id: string;
  readonly root_workspace_id: string;
  readonly body_ref: string;
  readonly created_at: string;
  readonly response_state: string | null;
  readonly response_project_id: string | null;
  readonly response_root_workspace_id: string | null;
  readonly response_revision: number | null;
  readonly response_body: string | null;
  readonly response_execution_id: string | null;
  readonly next_attempt_no: number | null;
  readonly attempt_no: number | null;
  readonly attempt_execution_id: string | null;
  readonly attempt_settled_at: string | null;
  readonly attempt_settlement_kind: string | null;
  readonly attempt_retry_decision_json: string | null;
  readonly execution_id: string | null;
  readonly execution_project_id: string | null;
  readonly execution_workspace_id: string | null;
  readonly episode_kind: string | null;
  readonly episode_ref: string | null;
  readonly admission_job_revision: number | null;
  readonly execution_settlement_json: string | null;
}

interface ProviderManifestRow {
  readonly execution_id: string;
  readonly session_id: string;
  readonly context_epoch: number;
  readonly manifest_id: string;
}

const ownerColumns = `root_workspace_id, context_epoch,
  covered_through_created_at, covered_through_message_id, checkpoint_kind,
  checkpoint_ref, binding_fingerprint, source_manifest_json,
  producer_execution_id, producer_provider_turn_id, updated_at`;

const toOwner = (row: OwnerRow): ConversationCheckpointOwner => ({
  rootWorkspaceId: row.root_workspace_id as WorkspaceId,
  contextEpoch: Number(row.context_epoch) as ContextEpochNumber,
  coveredThrough:
    row.covered_through_created_at === null ||
    row.covered_through_message_id === null
      ? null
      : {
          createdAt: row.covered_through_created_at,
          messageId: row.covered_through_message_id,
        },
  checkpointKind:
    row.checkpoint_kind === null
      ? null
      : (row.checkpoint_kind as ConversationCheckpointKind),
  checkpointRef: row.checkpoint_ref,
  bindingFingerprint: row.binding_fingerprint,
  sourceManifestJson: row.source_manifest_json,
  producerExecutionId: row.producer_execution_id as ExecutionId | null,
  producerProviderTurnId:
    row.producer_provider_turn_id === null
      ? null
      : parse(ProviderTurnId)(row.producer_provider_turn_id),
  updatedAt: row.updated_at,
});

const sameFrontier = (
  left: ConversationCheckpointFrontier | null,
  right: ConversationCheckpointFrontier | null,
): boolean =>
  left === null || right === null
    ? left === right
    : left.createdAt === right.createdAt && left.messageId === right.messageId;

const compareFrontier = (
  left: ConversationCheckpointFrontier,
  right: ConversationCheckpointFrontier,
): number =>
  left.createdAt === right.createdAt
    ? left.messageId < right.messageId
      ? -1
      : left.messageId > right.messageId
        ? 1
        : 0
    : left.createdAt < right.createdAt
      ? -1
      : 1;

const conflict = (
  reason: ConversationCheckpointOwnerConflict["reason"],
): ConversationCheckpointOwnerConflict => ({
  _tag: "ConversationCheckpointOwnerConflict",
  reason,
});

const isAnswerRetryDecision = (value: string): boolean => {
  try {
    const parsed: unknown = JSON.parse(value);
    return JSON.stringify(parsed) === JSON.stringify({ _tag: "Answer" });
  } catch {
    return false;
  }
};

const isProducedSettlement = (
  value: string | null,
  messageId: string,
): boolean => {
  if (value === null) return false;
  try {
    const parsed = JSON.parse(value) as {
      readonly _tag?: unknown;
      readonly result?: {
        readonly _tag?: unknown;
        readonly messageId?: unknown;
      };
    };
    return (
      parsed._tag === "Completed" &&
      parsed.result?._tag === "ConversationResponseProduced" &&
      parsed.result.messageId === messageId
    );
  } catch {
    return false;
  }
};

const validOwnerShape = (owner: ConversationCheckpointOwner): boolean => {
  if (
    !Number.isSafeInteger(owner.contextEpoch) ||
    owner.contextEpoch < 0 ||
    owner.updatedAt.length === 0
  ) {
    return false;
  }
  if ((owner.checkpointKind === null) !== (owner.checkpointRef === null)) {
    return false;
  }
  if (owner.checkpointKind === null) {
    return (
      owner.bindingFingerprint === null &&
      owner.sourceManifestJson === null &&
      owner.producerExecutionId === null &&
      owner.producerProviderTurnId === null
    );
  }
  if (
    owner.sourceManifestJson === null ||
    owner.producerExecutionId === null ||
    owner.producerProviderTurnId === null ||
    owner.checkpointRef === null
  ) {
    return false;
  }
  return (
    isConversationCheckpointKind(owner.checkpointKind) &&
    isValidConversationCheckpointBinding(
      owner.checkpointKind,
      owner.checkpointRef,
      owner.bindingFingerprint,
    )
  );
};

export const ConversationCheckpointStoreLive: Layer.Layer<
  ConversationCheckpointStore,
  never,
  SqlClient
> = Layer.effect(
  ConversationCheckpointStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(
        Effect.mapError(
          repositoryFailure("ConversationCheckpointStore", "owner"),
        ),
      );

    const readOwner = (rootWorkspaceId: WorkspaceId) =>
      run(
        sql.unsafe<OwnerRow>(
          `SELECT ${ownerColumns} FROM conversation_checkpoint_owners
            WHERE root_workspace_id = ?`,
          [rootWorkspaceId],
        ),
      );

    const assertConversationFence = (
      rootWorkspaceId: WorkspaceId,
      fence: SessionWriteFence,
      now: string,
      expectedManifest?: ConversationCheckpointSourceManifestV1,
    ) =>
      Effect.gen(function* () {
        const rows = yield* run(
          sql.unsafe<CurrentConversationRow>(
            `SELECT e.execution_id, e.project_id, e.workspace_id,
                    e.episode_kind, e.episode_ref, e.episode_revision,
                    e.session_id, l.worker_id, l.worker_incarnation_id,
                    l.generation, l.expires_at,
                    e.settlement_json AS execution_settlement_json,
                    j.state AS job_state,
                    j.project_id AS job_project_id,
                    j.root_workspace_id AS job_root_workspace_id,
                    j.active_execution_id, j.revision AS response_job_revision,
                    j.next_attempt_no, a.execution_id AS attempt_execution_id,
                    a.attempt_no, a.settled_at AS attempt_settled_at,
                    a.settlement_kind AS attempt_settlement_kind,
                    a.retry_decision_json AS attempt_retry_decision_json
               FROM executions e
               JOIN execution_leases l ON l.execution_id = e.execution_id
               JOIN projects p ON p.project_id = e.project_id
               LEFT JOIN conversation_response_jobs j
                 ON j.message_id = e.episode_ref
               LEFT JOIN conversation_attempts a
                 ON a.message_id = j.message_id
                AND a.attempt_no = j.next_attempt_no - 1
                AND a.execution_id = e.execution_id
              WHERE e.execution_id = ? AND p.root_workspace_id = ?
                AND e.workspace_id = ? AND e.episode_kind = 'ConversationResponseEpisode'
                AND e.settled_at IS NULL AND l.worker_id = ?
                AND l.worker_incarnation_id = ? AND l.generation = ?
                AND l.expires_at > ?`,
            [
              fence.executionId,
              rootWorkspaceId,
              rootWorkspaceId,
              fence.workerId,
              fence.workerIncarnationId,
              fence.fencingGeneration,
              now,
            ],
          ),
        );
        const row = rows[0];
        const rejected: LeaseFencingRejected = {
          _tag: "LeaseFencingRejected",
          executionId: fence.executionId,
          generation: fence.fencingGeneration,
        };
        if (row === undefined) return yield* Effect.fail(rejected);
        if (
          row.job_state !== "Running" ||
          row.job_project_id !== row.project_id ||
          row.job_root_workspace_id !== rootWorkspaceId ||
          row.active_execution_id !== fence.executionId ||
          row.response_job_revision !== row.episode_revision + 1 ||
          row.next_attempt_no === null ||
          row.attempt_no !== row.next_attempt_no - 1 ||
          row.attempt_execution_id !== fence.executionId ||
          row.attempt_settled_at !== null ||
          row.attempt_settlement_kind !== null ||
          row.attempt_retry_decision_json !== null ||
          row.execution_settlement_json !== null
        ) {
          return yield* Effect.fail(conflict("FenceOwnerMismatch"));
        }
        if (
          expectedManifest !== undefined &&
          (expectedManifest.currentMessageId !== row.episode_ref ||
            expectedManifest.currentRunningJobRevision !==
              row.response_job_revision ||
            expectedManifest.currentRunningAttemptNo !== row.attempt_no ||
            expectedManifest.currentAdmissionJobRevision !==
              row.episode_revision)
        ) {
          return yield* Effect.fail(conflict("InvalidSourceManifest"));
        }
        return row;
      });

    const validateOwner = (
      row: OwnerRow | undefined,
    ): Effect.Effect<
      ConversationCheckpointOwner,
      ConversationCheckpointOwnerConflict
    > => {
      if (row === undefined) return Effect.fail(conflict("MalformedOwner"));
      if (
        (row.covered_through_created_at === null) !==
        (row.covered_through_message_id === null)
      ) {
        return Effect.fail(conflict("MalformedOwner"));
      }
      let owner: ConversationCheckpointOwner;
      try {
        owner = toOwner(row);
      } catch {
        return Effect.fail(conflict("MalformedOwner"));
      }
      return validOwnerShape(owner)
        ? Effect.succeed(owner)
        : Effect.fail(conflict("MalformedOwner"));
    };

    const validateManifest = (
      input: CommitConversationCheckpointOwnerInput,
      currentOwner: ConversationCheckpointOwner,
      current: CurrentConversationRow,
    ): Effect.Effect<void, ConversationCheckpointStoreError> =>
      Effect.gen(function* () {
        const manifest = input.sourceManifest;
        const manifestText = JSON.stringify(manifest);
        if (
          manifest.version !== 1 ||
          manifest.rootWorkspaceId !== input.rootWorkspaceId ||
          manifest.fromEpoch !== input.expectedContextEpoch ||
          manifest.toEpoch !== input.nextContextEpoch ||
          !sameFrontier(manifest.fromFrontier, input.expectedCoveredThrough) ||
          !sameFrontier(manifest.coveredThrough, input.coveredThrough) ||
          manifest.checkpointKind !== input.checkpointKind ||
          manifest.producerExecutionId !== input.producerExecutionId ||
          manifest.producerProviderTurnId !== input.producerProviderTurnId ||
          manifest.currentMessageId !== current.episode_ref ||
          manifest.currentRunningJobRevision !==
            current.response_job_revision ||
          manifest.currentRunningAttemptNo !== current.attempt_no ||
          manifest.currentAdmissionJobRevision !== current.episode_revision ||
          manifest.producerManifestId.length === 0 ||
          manifestText.includes("undefined")
        ) {
          return yield* Effect.fail(conflict("InvalidSourceManifest"));
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(manifestText) as unknown;
        } catch {
          return yield* Effect.fail(conflict("InvalidSourceManifest"));
        }
        if (JSON.stringify(parsed) !== manifestText) {
          return yield* Effect.fail(conflict("InvalidSourceManifest"));
        }
        const sourceRows = yield* run(
          sql.unsafe<SourceMessageRow>(
            `SELECT hm.message_id, hm.project_id, hm.root_workspace_id,
                    hm.body_ref, hm.created_at, j.state AS response_state,
                    j.project_id AS response_project_id,
                    j.root_workspace_id AS response_root_workspace_id,
                    j.revision AS response_revision, j.response_body,
                    j.response_execution_id, j.next_attempt_no,
                    a.attempt_no, a.execution_id AS attempt_execution_id,
                    a.settled_at AS attempt_settled_at,
                    a.settlement_kind AS attempt_settlement_kind,
                    a.retry_decision_json AS attempt_retry_decision_json,
                    e.execution_id, e.project_id AS execution_project_id,
                    e.workspace_id AS execution_workspace_id,
                    e.episode_kind, e.episode_ref,
                    e.episode_revision AS admission_job_revision,
                    e.settlement_json AS execution_settlement_json
               FROM human_messages hm
               LEFT JOIN conversation_response_jobs j
                 ON j.message_id = hm.message_id
               LEFT JOIN conversation_attempts a
                 ON a.message_id = j.message_id
                AND a.attempt_no = j.next_attempt_no - 1
                AND a.execution_id = j.response_execution_id
               LEFT JOIN executions e
                 ON e.execution_id = a.execution_id
              WHERE hm.root_workspace_id = ?
              ORDER BY hm.created_at ASC, hm.message_id ASC`,
            [input.rootWorkspaceId],
          ),
        );
        const currentIndex = sourceRows.findIndex(
          (row) => row.message_id === manifest.currentMessageId,
        );
        if (currentIndex < 0) {
          return yield* Effect.fail(conflict("InvalidSourceManifest"));
        }
        const completePrefix: ConversationCheckpointSourceManifestV1["coveredSources"][number][] =
          [];
        for (const row of sourceRows.slice(0, currentIndex)) {
          if (
            row.response_state !== "Answered" ||
            row.response_project_id !== row.project_id ||
            row.response_root_workspace_id !== input.rootWorkspaceId ||
            row.response_execution_id === null ||
            row.response_body === null ||
            row.response_revision === null ||
            row.next_attempt_no === null ||
            row.attempt_no !== row.next_attempt_no - 1 ||
            row.attempt_execution_id !== row.response_execution_id ||
            row.attempt_settled_at === null ||
            row.attempt_settlement_kind !== "Completed" ||
            row.attempt_retry_decision_json === null ||
            row.execution_id !== row.response_execution_id ||
            row.execution_project_id !== row.project_id ||
            row.execution_workspace_id !== input.rootWorkspaceId ||
            row.episode_kind !== "ConversationResponseEpisode" ||
            row.episode_ref !== row.message_id ||
            row.admission_job_revision === null ||
            row.response_revision !== row.admission_job_revision + 2 ||
            !isAnswerRetryDecision(row.attempt_retry_decision_json) ||
            !isProducedSettlement(row.execution_settlement_json, row.message_id)
          ) {
            break;
          }
          completePrefix.push({
            createdAt: row.created_at,
            messageId: row.message_id,
            bodyRef: row.body_ref,
            bodySha256: sha256Hex(row.body_ref),
            responseBodySha256: sha256Hex(row.response_body),
            answeredJobRevision: row.response_revision,
            responseExecutionId: row.response_execution_id as never,
            attemptNo: row.attempt_no,
            admissionJobRevision: row.admission_job_revision,
          });
        }
        if (
          completePrefix.length !== manifest.coveredSources.length ||
          completePrefix.some((source, index) => {
            const candidate = manifest.coveredSources[index];
            return (
              candidate === undefined ||
              source.createdAt !== candidate.createdAt ||
              source.messageId !== candidate.messageId ||
              source.bodyRef !== candidate.bodyRef ||
              source.bodySha256 !== candidate.bodySha256 ||
              source.responseBodySha256 !== candidate.responseBodySha256 ||
              source.answeredJobRevision !== candidate.answeredJobRevision ||
              source.responseExecutionId !== candidate.responseExecutionId ||
              source.attemptNo !== candidate.attemptNo ||
              source.admissionJobRevision !== candidate.admissionJobRevision
            );
          })
        ) {
          return yield* Effect.fail(conflict("InvalidSourceManifest"));
        }
        const actualFrontier = completePrefix.at(-1);
        const expectedNewFrontier =
          actualFrontier === undefined
            ? currentOwner.coveredThrough
            : {
                createdAt: actualFrontier.createdAt,
                messageId: actualFrontier.messageId,
              };
        if (!sameFrontier(input.coveredThrough, expectedNewFrontier)) {
          return yield* Effect.fail(conflict("InvalidFrontierTransition"));
        }
        const currentMessage = sourceRows[currentIndex];
        if (currentMessage?.message_id !== manifest.currentMessageId) {
          return yield* Effect.fail(conflict("InvalidSourceManifest"));
        }
        const providerRows = yield* run(
          sql.unsafe<ProviderManifestRow>(
            `SELECT t.execution_id, t.session_id, t.context_epoch,
                    m.manifest_id
               FROM provider_turns t
               JOIN model_context_manifests m
                 ON m.provider_turn_id = t.provider_turn_id
                AND m.manifest_id = t.manifest_id
              WHERE t.provider_turn_id = ?`,
            [input.producerProviderTurnId],
          ),
        );
        const producer = providerRows[0];
        if (
          producer === undefined ||
          producer.execution_id !== input.producerExecutionId ||
          producer.session_id !== current.session_id ||
          producer.context_epoch < 0 ||
          producer.manifest_id !== manifest.producerManifestId
        ) {
          return yield* Effect.fail(conflict("InvalidSourceManifest"));
        }
      });

    const findOwner = (rootWorkspaceId: WorkspaceId) =>
      Effect.gen(function* () {
        yield* TransactionScope;
        const rows = yield* readOwner(rootWorkspaceId);
        const row = rows[0];
        return row === undefined
          ? Option.none<ConversationCheckpointOwner>()
          : Option.some(yield* validateOwner(row));
      });

    const initializeIfAbsent = (
      input: InitializeConversationCheckpointOwnerInput,
    ) =>
      Effect.gen(function* () {
        yield* TransactionScope;
        yield* assertConversationFence(
          input.rootWorkspaceId,
          input.fence,
          input.initializedAt,
        );
        const existing = yield* readOwner(input.rootWorkspaceId);
        if (existing[0] !== undefined) return yield* validateOwner(existing[0]);
        yield* run(
          sql.unsafe(
            `INSERT INTO conversation_checkpoint_owners (
               root_workspace_id, context_epoch, covered_through_created_at,
               covered_through_message_id, checkpoint_kind, checkpoint_ref,
               binding_fingerprint, source_manifest_json, producer_execution_id,
               producer_provider_turn_id, updated_at
             ) VALUES (?, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)
             ON CONFLICT(root_workspace_id) DO NOTHING`,
            [input.rootWorkspaceId, input.initializedAt],
          ),
        );
        const inserted = yield* readOwner(input.rootWorkspaceId);
        return yield* validateOwner(inserted[0]);
      });

    const commit = (input: CommitConversationCheckpointOwnerInput) =>
      Effect.gen(function* () {
        yield* TransactionScope;
        const active = yield* assertConversationFence(
          input.rootWorkspaceId,
          input.fence,
          input.updatedAt,
          input.sourceManifest,
        );
        if (
          input.fence.executionId !== input.producerExecutionId ||
          input.rootWorkspaceId !== active.workspace_id
        ) {
          return yield* Effect.fail(conflict("FenceOwnerMismatch"));
        }
        const ownerRows = yield* readOwner(input.rootWorkspaceId);
        const owner = yield* validateOwner(ownerRows[0]);
        if (owner.contextEpoch !== input.expectedContextEpoch) {
          return yield* Effect.fail(conflict("ExpectedEpochMismatch"));
        }
        if (!sameFrontier(owner.coveredThrough, input.expectedCoveredThrough)) {
          return yield* Effect.fail(conflict("ExpectedFrontierMismatch"));
        }
        if (input.nextContextEpoch !== input.expectedContextEpoch + 1) {
          return yield* Effect.fail(conflict("InvalidEpochTransition"));
        }
        if (
          !isValidConversationCheckpointBinding(
            input.checkpointKind,
            input.checkpointRef,
            input.bindingFingerprint,
          )
        ) {
          return yield* Effect.fail(conflict("InvalidCheckpointBinding"));
        }
        if (
          owner.coveredThrough !== null &&
          input.coveredThrough !== null &&
          compareFrontier(input.coveredThrough, owner.coveredThrough) < 0
        ) {
          return yield* Effect.fail(conflict("InvalidFrontierTransition"));
        }
        yield* validateManifest(input, owner, active);
        // Recheck the active generation immediately before the owner CAS. The
        // surrounding P1 TransactionScope serializes the lease and owner rows.
        yield* assertConversationFence(
          input.rootWorkspaceId,
          input.fence,
          input.updatedAt,
          input.sourceManifest,
        );
        const manifestJson = JSON.stringify(input.sourceManifest);
        const written = yield* run(
          sql.unsafe<OwnerRow>(
            `UPDATE conversation_checkpoint_owners
                SET context_epoch = ?, covered_through_created_at = ?,
                    covered_through_message_id = ?, checkpoint_kind = ?,
                    checkpoint_ref = ?, binding_fingerprint = ?,
                    source_manifest_json = ?, producer_execution_id = ?,
                    producer_provider_turn_id = ?, updated_at = ?
              WHERE root_workspace_id = ? AND context_epoch = ?
                AND covered_through_created_at IS ?
                AND covered_through_message_id IS ?
              RETURNING ${ownerColumns}`,
            [
              input.nextContextEpoch,
              input.coveredThrough?.createdAt ?? null,
              input.coveredThrough?.messageId ?? null,
              input.checkpointKind,
              input.checkpointRef,
              input.bindingFingerprint,
              manifestJson,
              input.producerExecutionId,
              input.producerProviderTurnId,
              input.updatedAt,
              input.rootWorkspaceId,
              input.expectedContextEpoch,
              input.expectedCoveredThrough?.createdAt ?? null,
              input.expectedCoveredThrough?.messageId ?? null,
            ],
          ),
        );
        const row = written[0];
        if (row === undefined) {
          const latest = yield* readOwner(input.rootWorkspaceId);
          let actual: ConversationCheckpointOwner | undefined;
          try {
            actual = latest[0] === undefined ? undefined : toOwner(latest[0]);
          } catch {
            return yield* Effect.fail(conflict("MalformedOwner"));
          }
          return yield* Effect.fail(
            actual?.contextEpoch !== input.expectedContextEpoch
              ? conflict("ExpectedEpochMismatch")
              : conflict("ExpectedFrontierMismatch"),
          );
        }
        const nextOwner = yield* validateOwner(row);
        if (
          nextOwner.contextEpoch !== input.nextContextEpoch ||
          !sameFrontier(nextOwner.coveredThrough, input.coveredThrough) ||
          nextOwner.sourceManifestJson !== manifestJson
        ) {
          return yield* Effect.fail(conflict("MalformedOwner"));
        }
        return nextOwner;
      });

    return ConversationCheckpointStore.of({
      findOwner,
      initializeIfAbsent,
      commit,
    });
  }),
);
