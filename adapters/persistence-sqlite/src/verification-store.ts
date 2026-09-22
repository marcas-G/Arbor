import type {
  Acceptance,
  ConclusionReason,
  EvidenceId,
  ExecutionId,
  ProjectId,
  Verification,
  VerificationId,
  VerificationVerdict,
  WorkId,
  WorkspaceId,
} from "@arbor/domain";
import {
  AcceptanceRepository,
  type AcceptanceRepositoryError,
  type EvidenceRecordRow,
  EvidenceRepository,
  type EvidenceRepositoryError,
  TransactionScope,
  VerificationRepository,
  type VerificationRepositoryError,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

interface VerificationRow {
  readonly verification_id: string;
  readonly work_id: string;
  readonly target_work_revision: number;
  readonly owner_workspace_id: string;
  readonly mission_snapshot: string;
  readonly target_deliverables: string;
  readonly target_artifact_versions: string;
  readonly target_environment_revision: string | null;
  readonly environment_snapshot_ref: string | null;
  readonly verification_execution_ids: string;
  readonly state: string;
  readonly verdict: string | null;
  readonly conclusion_reason: string | null;
}

const toVerification = (row: VerificationRow): Verification =>
  ({
    verificationId: row.verification_id,
    workId: row.work_id,
    targetWorkRevision: row.target_work_revision,
    missionSnapshot: JSON.parse(row.mission_snapshot),
    targetDeliverables: JSON.parse(row.target_deliverables),
    targetArtifactVersions: JSON.parse(row.target_artifact_versions),
    targetEnvironmentRevision: row.target_environment_revision,
    environmentSnapshotRef: row.environment_snapshot_ref,
    evidenceRefs: [],
    verificationExecutionIds: JSON.parse(row.verification_execution_ids),
    state:
      row.state === "Open"
        ? { status: "Open" }
        : {
            status: "Concluded",
            verdict: row.verdict as VerificationVerdict,
            ...(row.conclusion_reason === null
              ? {}
              : {
                  conclusionReason: row.conclusion_reason as ConclusionReason,
                }),
          },
  }) as unknown as Verification;

const VERIFICATION_COLUMNS =
  "verification_id, work_id, target_work_revision, owner_workspace_id, mission_snapshot, target_deliverables, target_artifact_versions, target_environment_revision, environment_snapshot_ref, verification_execution_ids, state, verdict, conclusion_reason";

export const VerificationRepositoryLive: Layer.Layer<
  VerificationRepository,
  never,
  SqlClient
> = Layer.effect(
  VerificationRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const failure = (cause: unknown): VerificationRepositoryError => ({
      _tag: "VerificationRepositoryFailure",
      cause,
    });
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));
    return VerificationRepository.of({
      insert: (verification, projectId, ownerWorkspaceId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const now = new Date().toISOString();
          yield* run(
            sql.unsafe(
              "INSERT INTO verifications (verification_id, project_id, work_id, target_work_revision, owner_workspace_id, mission_snapshot, target_deliverables, target_artifact_versions, target_environment_revision, environment_snapshot_ref, verification_execution_ids, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
              [
                verification.verificationId,
                projectId,
                verification.workId,
                verification.targetWorkRevision,
                ownerWorkspaceId,
                JSON.stringify(verification.missionSnapshot),
                JSON.stringify(verification.targetDeliverables),
                JSON.stringify(verification.targetArtifactVersions),
                verification.targetEnvironmentRevision,
                verification.environmentSnapshotRef,
                JSON.stringify(verification.verificationExecutionIds),
                "Open",
                now,
                now,
              ],
            ),
          );
        }),
      findById: (verificationId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<VerificationRow>(
              `SELECT ${VERIFICATION_COLUMNS} FROM verifications WHERE verification_id = ?`,
              [verificationId],
            ),
          );
          return rows.length > 0
            ? Option.some(toVerification(rows[0] as VerificationRow))
            : Option.none();
        }),
      findOpenByWorkRevision: (workId, targetWorkRevision) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<VerificationRow>(
              `SELECT ${VERIFICATION_COLUMNS} FROM verifications WHERE work_id = ? AND target_work_revision = ? AND state = 'Open'`,
              [workId, targetWorkRevision],
            ),
          );
          return rows.length > 0
            ? Option.some(toVerification(rows[0] as VerificationRow))
            : Option.none();
        }),
      listOpen: () =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<VerificationRow>(
              `SELECT ${VERIFICATION_COLUMNS} FROM verifications WHERE state = 'Open'`,
            ),
          );
          return rows.map((row) => toVerification(row as VerificationRow));
        }),
      concludeIfOpen: (verificationId, verdict, conclusionReason) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<{ verification_id: string }>(
              "UPDATE verifications SET state = 'Concluded', verdict = ?, conclusion_reason = ?, updated_at = ? WHERE verification_id = ? AND state = 'Open' RETURNING verification_id",
              [
                verdict,
                conclusionReason ?? null,
                new Date().toISOString(),
                verificationId,
              ],
            ),
          );
          if (rows.length !== 1) {
            return Option.none();
          }
          const found = yield* run(
            sql.unsafe<VerificationRow>(
              `SELECT ${VERIFICATION_COLUMNS} FROM verifications WHERE verification_id = ?`,
              [verificationId],
            ),
          );
          return found.length > 0
            ? Option.some(toVerification(found[0] as VerificationRow))
            : Option.none();
        }),
      bindExecution: (verificationId, executionId, boundAt) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* run(
            sql.unsafe(
              "INSERT INTO verification_executions (verification_id, execution_id, bound_at) VALUES (?,?,?) ON CONFLICT(verification_id, execution_id) DO NOTHING",
              [verificationId, executionId, boundAt],
            ),
          );
          yield* run(
            sql.unsafe(
              "UPDATE verifications SET verification_execution_ids = (SELECT json_group_array(DISTINCT execution_id) FROM verification_executions WHERE verification_id = ?), updated_at = ? WHERE verification_id = ?",
              [verificationId, new Date().toISOString(), verificationId],
            ),
          );
        }),
    });
  }),
);

export const EvidenceRepositoryLive: Layer.Layer<
  EvidenceRepository,
  never,
  SqlClient
> = Layer.effect(
  EvidenceRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const failure = (cause: unknown): EvidenceRepositoryError => ({
      _tag: "EvidenceRepositoryFailure",
      cause,
    });
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));
    return EvidenceRepository.of({
      append: (record) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* run(
            sql.unsafe(
              "INSERT INTO verification_evidence (evidence_id, verification_id, criterion_id, kind, artifact_ref, observed_environment_revision, recorded_by_execution_id, recorded_at) VALUES (?,?,?,?,?,?,?,?)",
              [
                record.evidenceId,
                record.verificationId,
                record.criterionId,
                record.kind,
                record.artifactRef,
                record.observedEnvironmentRevision,
                record.recordedByExecutionId,
                record.recordedAt,
              ],
            ),
          );
        }),
      listByVerification: (verificationId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<{
              evidence_id: string;
              verification_id: string;
              criterion_id: string;
              kind: string;
              artifact_ref: string | null;
              observed_environment_revision: string | null;
              recorded_by_execution_id: string;
              recorded_at: string;
            }>(
              "SELECT evidence_id, verification_id, criterion_id, kind, artifact_ref, observed_environment_revision, recorded_by_execution_id, recorded_at FROM verification_evidence WHERE verification_id = ? ORDER BY recorded_at, evidence_id",
              [verificationId],
            ),
          );
          return rows.map(
            (row): EvidenceRecordRow => ({
              evidenceId: row.evidence_id as EvidenceId,
              verificationId: row.verification_id as VerificationId,
              criterionId: row.criterion_id,
              kind: row.kind,
              artifactRef: row.artifact_ref,
              observedEnvironmentRevision: row.observed_environment_revision,
              recordedByExecutionId:
                row.recorded_by_execution_id as ExecutionId,
              recordedAt: row.recorded_at,
            }),
          );
        }),
    });
  }),
);

export const AcceptanceRepositoryLive: Layer.Layer<
  AcceptanceRepository,
  never,
  SqlClient
> = Layer.effect(
  AcceptanceRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const failure = (cause: unknown): AcceptanceRepositoryError => ({
      _tag: "AcceptanceRepositoryFailure",
      cause,
    });
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));
    return AcceptanceRepository.of({
      insert: (acceptance, projectId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* run(
            sql.unsafe(
              "INSERT INTO work_acceptances (acceptance_id, project_id, work_id, target_work_revision, verification_id, actor, accepted_at) VALUES (?,?,?,?,?,?,?)",
              [
                acceptance.acceptanceId,
                projectId,
                acceptance.workId,
                acceptance.targetWorkRevision,
                acceptance.verificationId,
                acceptance.actor,
                acceptance.acceptedAt,
              ],
            ),
          );
        }),
      findByWorkRevision: (workId, targetWorkRevision) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<{
              acceptance_id: string;
              work_id: string;
              target_work_revision: number;
              verification_id: string;
              actor: string;
              accepted_at: string;
            }>(
              "SELECT acceptance_id, work_id, target_work_revision, verification_id, actor, accepted_at FROM work_acceptances WHERE work_id = ? AND target_work_revision = ?",
              [workId, targetWorkRevision],
            ),
          );
          const row = rows[0];
          return row === undefined
            ? Option.none()
            : Option.some({
                acceptanceId: row.acceptance_id as never,
                workId: row.work_id as WorkId,
                targetWorkRevision: row.target_work_revision as never,
                verificationId: row.verification_id as VerificationId,
                actor: row.actor as never,
                acceptedAt: row.accepted_at,
              } satisfies Acceptance);
        }),
    });
  }),
);
