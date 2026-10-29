import type { DatabaseSync } from "node:sqlite";
import type { MigrationFile } from "./migrate.js";

export const P46_VERIFICATION_EVIDENCE_SNAPSHOT_MIGRATION = {
  id: 46,
  name: "verification_evidence_snapshot",
  requiresUserVersion: 45,
  offlineOnly: true,
  sql: `
ALTER TABLE verifications ADD COLUMN criteria_results TEXT
  CHECK (criteria_results IS NULL OR json_valid(criteria_results));
ALTER TABLE verifications ADD COLUMN snapshot_status TEXT NOT NULL DEFAULT 'Pending'
  CHECK (snapshot_status IN ('Pending','Available','NotApplicableOrphaned','UnavailableLegacy'));
UPDATE verifications SET snapshot_status = 'UnavailableLegacy' WHERE state = 'Concluded';

CREATE TRIGGER verifications_snapshot_shape_insert
BEFORE INSERT ON verifications
WHEN NOT (
  (NEW.snapshot_status = 'Pending' AND NEW.state = 'Open'
    AND NEW.criteria_results IS NULL AND NEW.verdict IS NULL
    AND NEW.conclusion_reason IS NULL AND NEW.summary_ref IS NULL)
  OR
  (NEW.snapshot_status = 'Available' AND NEW.state = 'Concluded'
    AND NEW.criteria_results IS NOT NULL AND json_valid(NEW.criteria_results)
    AND json_type(NEW.criteria_results) = 'array'
    AND NEW.verdict IN ('Pass','Fail','Unknown')
    AND NEW.conclusion_reason IS NULL AND NEW.summary_ref IS NOT NULL)
  OR
  (NEW.snapshot_status = 'NotApplicableOrphaned' AND NEW.state = 'Concluded'
    AND NEW.verdict = 'Unknown' AND NEW.conclusion_reason = 'Orphaned'
    AND NEW.criteria_results = '[]' AND NEW.summary_ref IS NOT NULL)
  OR
  (NEW.snapshot_status = 'UnavailableLegacy' AND NEW.state = 'Concluded'
    AND NEW.criteria_results IS NULL AND NEW.verdict IN ('Pass','Fail','Unknown'))
)
BEGIN SELECT RAISE(ABORT, 'verification_snapshot_shape_invalid'); END;

CREATE TRIGGER verifications_snapshot_shape_update
BEFORE UPDATE ON verifications
WHEN NOT (
  (NEW.snapshot_status = 'Pending' AND NEW.state = 'Open'
    AND NEW.criteria_results IS NULL AND NEW.verdict IS NULL
    AND NEW.conclusion_reason IS NULL AND NEW.summary_ref IS NULL)
  OR
  (NEW.snapshot_status = 'Available' AND NEW.state = 'Concluded'
    AND NEW.criteria_results IS NOT NULL AND json_valid(NEW.criteria_results)
    AND json_type(NEW.criteria_results) = 'array'
    AND NEW.verdict IN ('Pass','Fail','Unknown')
    AND NEW.conclusion_reason IS NULL AND NEW.summary_ref IS NOT NULL)
  OR
  (NEW.snapshot_status = 'NotApplicableOrphaned' AND NEW.state = 'Concluded'
    AND NEW.verdict = 'Unknown' AND NEW.conclusion_reason = 'Orphaned'
    AND NEW.criteria_results = '[]' AND NEW.summary_ref IS NOT NULL)
  OR
  (NEW.snapshot_status = 'UnavailableLegacy' AND NEW.state = 'Concluded'
    AND NEW.criteria_results IS NULL AND NEW.verdict IN ('Pass','Fail','Unknown'))
)
BEGIN SELECT RAISE(ABORT, 'verification_snapshot_shape_invalid'); END;
`,
} satisfies MigrationFile & { readonly requiresUserVersion: 45 };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (value: unknown, expected: ReadonlyArray<string>): boolean =>
  isObject(value) &&
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));

const isStrictMissionSnapshot = (raw: string): boolean => {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return false;
  }
  const mission = value as Record<string, unknown>;
  if (
    !exactKeys(value, ["goal", "criteria", "riskRequirements"]) ||
    typeof mission.goal !== "string" ||
    mission.goal.length === 0 ||
    !Array.isArray(mission.criteria) ||
    !Array.isArray(mission.riskRequirements) ||
    !mission.riskRequirements.every((item: unknown) => typeof item === "string")
  ) {
    return false;
  }
  return (
    (mission.criteria as ReadonlyArray<unknown>).every((candidate: unknown) => {
      if (!exactKeys(candidate, ["criterionId", "requirement", "required"]))
        return false;
      const criterion = candidate as Record<string, unknown>;
      return (
        typeof criterion.criterionId === "string" &&
        criterion.criterionId.length > 0 &&
        typeof criterion.requirement === "string" &&
        criterion.requirement.length > 0 &&
        typeof criterion.required === "boolean"
      );
    }) &&
    (mission.criteria as ReadonlyArray<{ readonly required: boolean }>).some(
      (criterion) => criterion.required,
    )
  );
};

/** Must run inside the same BEGIN IMMEDIATE transaction as migration 0046. */
export const preflightVerificationEvidenceSnapshot = (
  database: DatabaseSync,
): void => {
  const openRows = database
    .prepare(
      `SELECT verification_id, project_id, work_id, target_work_revision,
              mission_snapshot
         FROM verifications WHERE state = 'Open'
        ORDER BY verification_id`,
    )
    .all() as Array<{
    verification_id: string;
    project_id: string;
    work_id: string;
    target_work_revision: number;
    mission_snapshot: string;
  }>;
  const event = database.prepare(
    `SELECT event_id, payload_json FROM domain_events
       WHERE event_type = 'VerificationStarted' AND event_version = 1
         AND aggregate_ref = ? AND project_id = ?
         AND json_valid(payload_json)
         AND json_extract(payload_json, '$.verificationId') = ?
         AND json_extract(payload_json, '$.workId') = ?
         AND json_extract(payload_json, '$.targetWorkRevision') = ?`,
  );
  for (const row of openRows) {
    if (!isStrictMissionSnapshot(row.mission_snapshot)) {
      throw new Error(
        `migration 46 preflight refused Open verification ${row.verification_id}: mission_snapshot is missing or malformed`,
      );
    }
    const associated = event.all(
      row.verification_id,
      row.project_id,
      row.verification_id,
      row.work_id,
      row.target_work_revision,
    );
    if (associated.length !== 1) {
      throw new Error(
        `migration 46 preflight refused Open verification ${row.verification_id}: exact VerificationStarted association is not unique`,
      );
    }
    const work = database
      .prepare("SELECT project_id FROM works WHERE work_id = ?")
      .all(row.work_id) as Array<{ project_id: string }>;
    if (work.length !== 1 || work[0]?.project_id !== row.project_id) {
      throw new Error(
        `migration 46 preflight refused Open verification ${row.verification_id}: exact Work ownership is missing`,
      );
    }
    const eventRow = associated[0] as {
      event_id: string;
      payload_json: string;
    };
    let payload: unknown;
    try {
      payload = JSON.parse(eventRow.payload_json) as unknown;
    } catch {
      throw new Error(
        `migration 46 preflight refused Open verification ${row.verification_id}: VerificationStarted payload is malformed`,
      );
    }
    const eventPayload = payload as Record<string, unknown>;
    if (
      !exactKeys(payload, [
        "verificationId",
        "workId",
        "targetWorkRevision",
        "missionDigest",
      ]) ||
      typeof eventPayload.verificationId !== "string" ||
      typeof eventPayload.workId !== "string" ||
      typeof eventPayload.targetWorkRevision !== "number" ||
      !Number.isSafeInteger(eventPayload.targetWorkRevision) ||
      typeof eventPayload.missionDigest !== "string"
    ) {
      throw new Error(
        `migration 46 preflight refused Open verification ${row.verification_id}: VerificationStarted payload codec is invalid`,
      );
    }
    const mission = JSON.parse(row.mission_snapshot) as {
      goal: string;
      criteria: ReadonlyArray<{ readonly required: boolean }>;
    };
    const required = mission.criteria.filter(
      (criterion) => criterion.required,
    ).length;
    if (
      eventPayload.verificationId !== row.verification_id ||
      eventPayload.workId !== row.work_id ||
      eventPayload.targetWorkRevision !== row.target_work_revision ||
      eventPayload.missionDigest !==
        `${mission.goal} [criteria=${mission.criteria.length} required=${required}]`
    ) {
      throw new Error(
        `migration 46 preflight refused Open verification ${row.verification_id}: VerificationStarted payload does not bind the row snapshot`,
      );
    }
  }
};
