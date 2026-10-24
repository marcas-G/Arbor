import type { WorkContractSnapshot } from "@arbor/domain";
import { canonicalWorkContractJson, sha256Hex } from "@arbor/ports";
import { Effect } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { MigrationApplyContext, MigrationFile } from "./migrate.js";

interface MigrationSqlClient {
  readonly unsafe: <Row = unknown>(
    statement: string,
    params?: ReadonlyArray<unknown>,
  ) => Effect.Effect<ReadonlyArray<Row>, SqlError>;
}

interface LegacyWorkRow {
  readonly work_id: string;
  readonly revision: number;
  readonly objective: string;
  readonly why: string;
  readonly constraints: string;
  readonly completion_expectation: string;
  readonly verification_mission: string;
  readonly provenance: string;
  readonly updated_at: string;
}

const backfillCurrentWorkSnapshots = (
  unknownSql: unknown,
  _context?: MigrationApplyContext,
) => {
  const sql = unknownSql as MigrationSqlClient;
  return Effect.gen(function* () {
    const works = yield* sql.unsafe<LegacyWorkRow>(
      `SELECT work_id, revision, objective, why, constraints,
              completion_expectation, verification_mission, provenance,
              updated_at
         FROM works ORDER BY work_id`,
    );
    for (const work of works) {
      const contract: WorkContractSnapshot = {
        objective: work.objective,
        why: work.why,
        constraints: JSON.parse(work.constraints) as ReadonlyArray<string>,
        completionExpectation: work.completion_expectation,
        verificationMission: JSON.parse(work.verification_mission),
      };
      const canonical = canonicalWorkContractJson(contract);
      yield* sql.unsafe(
        `INSERT INTO work_contract_revisions (
           work_id, work_revision, contract_json, contract_sha256,
           record_kind, source_command_id, actor, provenance_json, recorded_at
         ) VALUES (?, ?, ?, ?, 'LegacyCurrentSnapshot', NULL, NULL, ?, ?)`,
        [
          work.work_id,
          Number(work.revision),
          canonical,
          sha256Hex(canonical),
          work.provenance,
          work.updated_at,
        ],
      );
    }
  });
};

export const P52_WORK_CONTRACT_REVISION_DDL = `
CREATE TABLE work_contract_revisions (
  work_id TEXT NOT NULL REFERENCES works(work_id),
  work_revision INTEGER NOT NULL CHECK (work_revision >= 0),
  contract_json TEXT NOT NULL CHECK (json_valid(contract_json)),
  contract_sha256 TEXT NOT NULL CHECK (
    length(contract_sha256) = 64 AND contract_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  record_kind TEXT NOT NULL CHECK (record_kind IN (
    'Initial','DirectionGuidance','ContractAmendment','LegacyCurrentSnapshot'
  )),
  source_command_id TEXT,
  actor TEXT,
  provenance_json TEXT CHECK (provenance_json IS NULL OR json_valid(provenance_json)),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (work_id, work_revision)
);

CREATE INDEX work_contract_revisions_source
  ON work_contract_revisions(source_command_id) WHERE source_command_id IS NOT NULL;

CREATE TRIGGER work_contract_revisions_no_update
BEFORE UPDATE ON work_contract_revisions
BEGIN
  SELECT RAISE(ABORT, 'Work contract revision snapshots are immutable');
END;

CREATE TRIGGER work_contract_revisions_no_delete
BEFORE DELETE ON work_contract_revisions
BEGIN
  SELECT RAISE(ABORT, 'Work contract revision snapshots are retained');
END;
`;

export const P52_WORK_CONTRACT_REVISION_MIGRATION: MigrationFile & {
  readonly requiresUserVersion: 51;
} = {
  id: 52,
  name: "work_contract_revision_history",
  sql: P52_WORK_CONTRACT_REVISION_DDL,
  requiresUserVersion: 51,
  onApply: backfillCurrentWorkSnapshots,
};
