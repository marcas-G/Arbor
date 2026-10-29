import type {
  Actor,
  CommandId,
  WorkContractSnapshot,
  WorkId,
  WorkRevision,
} from "@arbor/domain";
import {
  type AppendWorkContractRevision,
  canonicalWorkContractJson,
  TransactionScope,
  type WorkContractRevisionKind,
  type WorkContractRevisionRecord,
  WorkContractRevisionRepository,
  type WorkRepositoryError,
  workContractSnapshotDigest,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { repositoryFailure } from "./repository-error.js";

interface WorkContractRevisionRow {
  readonly work_id: string;
  readonly work_revision: number;
  readonly contract_json: string;
  readonly contract_sha256: string;
  readonly record_kind: string;
  readonly source_command_id: string | null;
  readonly actor: string | null;
  readonly provenance_json: string | null;
  readonly recorded_at: string;
}

const corruption = (
  operation: string,
  reason: string,
): WorkRepositoryError => ({
  _tag: "PersistenceCorruption",
  repository: "WorkRepository",
  operation,
  reason,
});

const decodeRecord = (
  row: WorkContractRevisionRow,
  operation: string,
): WorkContractRevisionRecord => {
  let contract: WorkContractSnapshot;
  let provenance: unknown | null;
  try {
    contract = JSON.parse(row.contract_json) as WorkContractSnapshot;
    provenance =
      row.provenance_json === null ? null : JSON.parse(row.provenance_json);
  } catch {
    throw corruption(operation, "stored Work contract revision is malformed");
  }
  const kinds = new Set<WorkContractRevisionKind>([
    "Initial",
    "DirectionGuidance",
    "ContractAmendment",
    "LegacyCurrentSnapshot",
  ]);
  if (!kinds.has(row.record_kind as WorkContractRevisionKind)) {
    throw corruption(
      operation,
      "stored Work contract revision kind is unsupported",
    );
  }
  if (!/^[0-9a-f]{64}$/.test(row.contract_sha256)) {
    throw corruption(
      operation,
      "stored Work contract revision digest is malformed",
    );
  }
  if (workContractSnapshotDigest(contract) !== row.contract_sha256) {
    throw corruption(
      operation,
      "stored Work contract revision digest mismatches",
    );
  }
  return {
    workId: row.work_id as WorkId,
    workRevision: Number(row.work_revision) as WorkRevision,
    contract,
    contractSha256: row.contract_sha256,
    kind: row.record_kind as WorkContractRevisionKind,
    sourceCommandId: row.source_command_id as CommandId | null,
    actor: row.actor as Actor | null,
    provenance,
    recordedAt: row.recorded_at,
  };
};

export const WorkContractRevisionRepositoryLive: Layer.Layer<
  WorkContractRevisionRepository,
  never,
  SqlClient
> = Layer.effect(
  WorkContractRevisionRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const failure = repositoryFailure("WorkRepository", "contract-revision");
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));

    const findRaw = (
      workId: WorkId,
      workRevision: WorkRevision,
    ): Effect.Effect<
      Option.Option<WorkContractRevisionRow>,
      WorkRepositoryError,
      TransactionScope
    > =>
      Effect.gen(function* () {
        yield* TransactionScope;
        const rows = yield* run(
          sql.unsafe<WorkContractRevisionRow>(
            `SELECT work_id, work_revision, contract_json, contract_sha256,
                    record_kind, source_command_id, actor, provenance_json,
                    recorded_at
               FROM work_contract_revisions
              WHERE work_id = ? AND work_revision = ?`,
            [workId, workRevision],
          ),
        );
        return rows[0] === undefined ? Option.none() : Option.some(rows[0]);
      });

    return WorkContractRevisionRepository.of({
      append: (input: AppendWorkContractRevision) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const contractJson = canonicalWorkContractJson(input.contract);
          const contractSha256 = workContractSnapshotDigest(input.contract);
          yield* run(
            sql.unsafe(
              `INSERT INTO work_contract_revisions (
                 work_id, work_revision, contract_json, contract_sha256,
                 record_kind, source_command_id, actor, provenance_json,
                 recorded_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                input.workId,
                input.workRevision,
                contractJson,
                contractSha256,
                input.kind,
                input.sourceCommandId,
                input.actor,
                input.provenance === null
                  ? null
                  : JSON.stringify(input.provenance),
                input.recordedAt,
              ],
            ),
          );
        }),
      findByWorkRevision: (workId, workRevision) =>
        Effect.map(findRaw(workId, workRevision), (found) =>
          Option.map(found, (row) =>
            decodeRecord(row, "find-by-work-revision"),
          ),
        ),
      listByWork: (workId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<WorkContractRevisionRow>(
              `SELECT work_id, work_revision, contract_json, contract_sha256,
                      record_kind, source_command_id, actor, provenance_json,
                      recorded_at
                 FROM work_contract_revisions
                WHERE work_id = ? ORDER BY work_revision`,
              [workId],
            ),
          );
          return rows.map((row) => decodeRecord(row, "list-by-work"));
        }),
    });
  }),
);
