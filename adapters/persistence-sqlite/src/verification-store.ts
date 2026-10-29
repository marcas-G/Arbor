import type {
  Acceptance,
  ConclusionReason,
  ExecutionId,
  Verification,
  VerificationId,
  VerificationVerdict,
  WorkId,
} from "@arbor/domain";
import { aggregateVerdict, EvidenceId, parse } from "@arbor/domain";
import {
  AcceptanceRepository,
  type EvidenceRecordRow,
  EvidenceRepository,
  TransactionScope,
  VerificationRepository,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { repositoryFailure } from "./repository-error.js";

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
  readonly summary_ref?: string | null;
  readonly criteria_results?: string | null;
  readonly snapshot_status?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: unknown,
  keys: ReadonlyArray<string>,
): value is Record<string, unknown> =>
  isRecord(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

const decodeMission = (raw: string, requireValidMission: boolean) => {
  const value: unknown = JSON.parse(raw);
  if (
    !hasExactKeys(value, ["goal", "criteria", "riskRequirements"]) ||
    typeof value.goal !== "string" ||
    !Array.isArray(value.criteria) ||
    !Array.isArray(value.riskRequirements) ||
    !value.riskRequirements.every((item) => typeof item === "string") ||
    !value.criteria.every(
      (criterion) =>
        hasExactKeys(criterion, ["criterionId", "requirement", "required"]) &&
        typeof criterion.criterionId === "string" &&
        typeof criterion.requirement === "string" &&
        typeof criterion.required === "boolean",
    )
  ) {
    throw new Error("verification mission_snapshot is malformed");
  }
  if (
    requireValidMission &&
    ((value.goal as string).length === 0 ||
      (
        value.criteria as ReadonlyArray<{
          readonly criterionId: string;
          readonly requirement: string;
        }>
      ).some(
        (criterion) =>
          criterion.criterionId.length === 0 ||
          criterion.requirement.length === 0,
      ) ||
      !(value.criteria as ReadonlyArray<{ readonly required: boolean }>).some(
        (criterion) => criterion.required,
      ))
  ) {
    throw new Error("verification mission_snapshot is semantically invalid");
  }
  return value as import("@arbor/domain").VerificationMission;
};

const toVerification = (row: VerificationRow): Verification => {
  const missionSnapshot = decodeMission(
    row.mission_snapshot,
    row.snapshot_status !== undefined &&
      row.snapshot_status !== "UnavailableLegacy",
  );
  const criteriaResults =
    row.criteria_results == null
      ? null
      : (JSON.parse(row.criteria_results) as unknown);
  const snapshotStatus =
    row.snapshot_status ??
    (row.state === "Open" ? "Pending" : "UnavailableLegacy");
  let decodedCriteriaResults: Verification["criteriaResults"] = null;
  if (criteriaResults !== null) {
    if (
      !Array.isArray(criteriaResults) ||
      !criteriaResults.every(
        (result) =>
          hasExactKeys(result, [
            "criterionId",
            "requirement",
            "required",
            "verdict",
            "evidenceRefs",
          ]) &&
          typeof result.criterionId === "string" &&
          typeof result.requirement === "string" &&
          typeof result.required === "boolean" &&
          ["Pass", "Fail", "Unknown"].includes(String(result.verdict)) &&
          Array.isArray(result.evidenceRefs) &&
          result.evidenceRefs.every((id) => {
            if (typeof id !== "string") return false;
            try {
              parse(EvidenceId)(id);
              return true;
            } catch {
              return false;
            }
          }),
      )
    ) {
      throw new Error("verification criteria_results is malformed");
    }
    decodedCriteriaResults = criteriaResults as Verification["criteriaResults"];
  }
  if (snapshotStatus === "Available") {
    if (
      row.state !== "Concluded" ||
      decodedCriteriaResults === null ||
      row.conclusion_reason !== null ||
      decodedCriteriaResults.length !== missionSnapshot.criteria.length ||
      decodedCriteriaResults.some(
        (result) => result.evidenceRefs.length === 0,
      ) ||
      decodedCriteriaResults.some((result, index) => {
        const criterion = missionSnapshot.criteria[index];
        return (
          criterion === undefined ||
          result.criterionId !== criterion.criterionId ||
          result.requirement !== criterion.requirement ||
          result.required !== criterion.required
        );
      }) ||
      aggregateVerdict(decodedCriteriaResults) !== row.verdict
    ) {
      throw new Error("verification Available snapshot conflicts with its row");
    }
  } else if (snapshotStatus === "NotApplicableOrphaned") {
    if (
      row.state !== "Concluded" ||
      row.verdict !== "Unknown" ||
      row.conclusion_reason !== "Orphaned" ||
      JSON.stringify(decodedCriteriaResults) !== "[]"
    ) {
      throw new Error("verification NotApplicableOrphaned snapshot is invalid");
    }
  } else if (snapshotStatus === "UnavailableLegacy") {
    if (row.state !== "Concluded" || decodedCriteriaResults !== null)
      throw new Error("verification UnavailableLegacy snapshot is invalid");
  } else if (
    snapshotStatus !== "Pending" ||
    row.state !== "Open" ||
    decodedCriteriaResults !== null
  ) {
    throw new Error("verification Pending snapshot is invalid");
  }
  return {
    verificationId: row.verification_id,
    workId: row.work_id,
    ownerWorkspaceId: row.owner_workspace_id,
    targetWorkRevision: row.target_work_revision,
    missionSnapshot,
    criteriaResults: decodedCriteriaResults,
    snapshotStatus,
    targetDeliverables: JSON.parse(row.target_deliverables),
    targetArtifactVersions: JSON.parse(row.target_artifact_versions),
    targetEnvironmentRevision: row.target_environment_revision,
    environmentSnapshotRef: row.environment_snapshot_ref,
    evidenceRefs: [],
    verificationExecutionIds: JSON.parse(row.verification_execution_ids),
    summaryRef: row.summary_ref ?? null,
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
  } as unknown as Verification;
};

// `*` intentionally keeps the repository readable against historical phase
// schemas used by migration tests; P22 contributes `summary_ref` in current
// production databases.
const VERIFICATION_COLUMNS = "*";

export const VerificationRepositoryLive: Layer.Layer<
  VerificationRepository,
  never,
  SqlClient
> = Layer.effect(
  VerificationRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const failure = repositoryFailure("VerificationRepository", "sql");
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
      findByExecutionId: (executionId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<VerificationRow>(
              "SELECT v.* FROM verifications v INNER JOIN verification_executions ve ON ve.verification_id = v.verification_id WHERE ve.execution_id = ? ORDER BY ve.bound_at, v.verification_id LIMIT 1",
              [executionId],
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
      listByWork: (workId: WorkId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<VerificationRow>(
              `SELECT ${VERIFICATION_COLUMNS} FROM verifications WHERE work_id = ? ORDER BY target_work_revision, verification_id`,
              [workId],
            ),
          );
          return rows.map((row) => toVerification(row as VerificationRow));
        }),
      concludeIfOpen: (
        verificationId,
        verdict,
        summaryRef,
        conclusionReason,
        criteriaResults,
      ) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const columns = yield* run(
            sql.unsafe<{ name: string }>("PRAGMA table_info(verifications)"),
          );
          const supportsSummary = columns.some(
            (column) => column.name === "summary_ref",
          );
          const supportsSnapshot = columns.some(
            (column) => column.name === "criteria_results",
          );
          const rows = yield* run(
            sql.unsafe<{ verification_id: string }>(
              supportsSnapshot
                ? "UPDATE verifications SET state = 'Concluded', verdict = ?, summary_ref = ?, conclusion_reason = ?, criteria_results = ?, snapshot_status = ?, updated_at = ? WHERE verification_id = ? AND state = 'Open' RETURNING verification_id"
                : supportsSummary
                  ? "UPDATE verifications SET state = 'Concluded', verdict = ?, summary_ref = ?, conclusion_reason = ?, updated_at = ? WHERE verification_id = ? AND state = 'Open' RETURNING verification_id"
                  : "UPDATE verifications SET state = 'Concluded', verdict = ?, conclusion_reason = ?, updated_at = ? WHERE verification_id = ? AND state = 'Open' RETURNING verification_id",
              supportsSnapshot
                ? [
                    verdict,
                    summaryRef,
                    conclusionReason ?? null,
                    criteriaResults == null
                      ? null
                      : JSON.stringify(criteriaResults),
                    conclusionReason === "Orphaned"
                      ? "NotApplicableOrphaned"
                      : "Available",
                    new Date().toISOString(),
                    verificationId,
                  ]
                : supportsSummary
                  ? [
                      verdict,
                      summaryRef,
                      conclusionReason ?? null,
                      new Date().toISOString(),
                      verificationId,
                    ]
                  : [
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
    const failure = repositoryFailure("EvidenceRepository", "sql");
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));
    return EvidenceRepository.of({
      append: (record) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const columns = yield* run(
            sql.unsafe<{ name: string }>(
              "PRAGMA table_info(verification_evidence)",
            ),
          );
          const supportsSourceIdentity = columns.some(
            (column) => column.name === "tool_invocation_id",
          );
          yield* run(
            sql.unsafe(
              supportsSourceIdentity
                ? "INSERT INTO verification_evidence (evidence_id, verification_id, criterion_id, kind, artifact_ref, observed_environment_revision, recorded_by_execution_id, recorded_at, tool_invocation_id, observation_ref, call_ref) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
                : "INSERT INTO verification_evidence (evidence_id, verification_id, criterion_id, kind, artifact_ref, observed_environment_revision, recorded_by_execution_id, recorded_at) VALUES (?,?,?,?,?,?,?,?)",
              supportsSourceIdentity
                ? [
                    record.evidenceId,
                    record.verificationId,
                    record.criterionId,
                    record.kind,
                    record.artifactRef,
                    record.observedEnvironmentRevision,
                    record.recordedByExecutionId,
                    record.recordedAt,
                    record.toolInvocationId ?? null,
                    record.observationRef ?? null,
                    record.callRef ?? null,
                  ]
                : [
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
              tool_invocation_id?: string | null;
              observation_ref?: string | null;
              call_ref?: string | null;
            }>(
              "SELECT * FROM verification_evidence WHERE verification_id = ? ORDER BY recorded_at, evidence_id",
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
              toolInvocationId: (row.tool_invocation_id ?? null) as never,
              observationRef: row.observation_ref ?? null,
              callRef: row.call_ref ?? null,
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
    const failure = repositoryFailure("AcceptanceRepository", "sql");
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
