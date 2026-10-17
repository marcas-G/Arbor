import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { splitStatements } from "../src/migrate.js";
import {
  P46_VERIFICATION_EVIDENCE_SNAPSHOT_MIGRATION,
  preflightVerificationEvidenceSnapshot,
} from "../src/p46-verification-evidence-snapshot-migration.js";

const mission = {
  goal: "verify",
  criteria: [{ criterionId: "c1", requirement: "r1", required: true }],
  riskRequirements: [],
};
const missionJson = JSON.stringify(mission);
const verificationId = "ver_00000000-0000-7000-8000-000000000001";
const workId = "wrk_00000000-0000-7000-8000-000000000001";
const projectId = "prj_00000000-0000-7000-8000-000000000001";

const legacyDatabase = () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE works (work_id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
    CREATE TABLE verifications (
      verification_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      work_id TEXT NOT NULL,
      target_work_revision INTEGER NOT NULL,
      mission_snapshot TEXT NOT NULL,
      state TEXT NOT NULL,
      verdict TEXT,
      conclusion_reason TEXT,
      summary_ref TEXT
    );
    CREATE TABLE domain_events (
      event_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_version INTEGER NOT NULL,
      aggregate_ref TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    INSERT INTO works VALUES ('${workId}', '${projectId}');
  `);
  return database;
};

const addOpenVerification = (
  database: DatabaseSync,
  snapshot = missionJson,
  payload = {
    verificationId,
    workId,
    targetWorkRevision: 4,
    missionDigest: "verify [criteria=1 required=1]",
  },
) => {
  database
    .prepare(
      `INSERT INTO verifications
       (verification_id, project_id, work_id, target_work_revision,
        mission_snapshot, state)
       VALUES (?, ?, ?, 4, ?, 'Open')`,
    )
    .run(verificationId, projectId, workId, snapshot);
  database
    .prepare(
      `INSERT INTO domain_events
       (event_id, project_id, event_type, event_version, aggregate_ref, payload_json)
       VALUES ('evt_start', ?, 'VerificationStarted', 1, ?, ?)`,
    )
    .run(projectId, verificationId, JSON.stringify(payload));
};

const applyMigration46 = (database: DatabaseSync) => {
  database.exec("BEGIN IMMEDIATE");
  try {
    preflightVerificationEvidenceSnapshot(database);
    for (const statement of splitStatements(
      P46_VERIFICATION_EVIDENCE_SNAPSHOT_MIGRATION.sql,
    )) {
      database.exec(statement);
    }
    database.exec("COMMIT");
  } catch (cause) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw cause;
  }
};

describe("migration 0046 verification evidence snapshots", () => {
  it("is pinned after schema 45 and passes a strict Open-row preflight before DDL", () => {
    expect(P46_VERIFICATION_EVIDENCE_SNAPSHOT_MIGRATION).toMatchObject({
      id: 46,
      requiresUserVersion: 45,
      name: "verification_evidence_snapshot",
    });
    const database = legacyDatabase();
    try {
      addOpenVerification(database);
      preflightVerificationEvidenceSnapshot(database);
      applyMigration46(database);
      const row = database
        .prepare(
          "SELECT mission_snapshot, criteria_results, snapshot_status FROM verifications WHERE verification_id = ?",
        )
        .get(verificationId) as {
        mission_snapshot: string;
        criteria_results: string | null;
        snapshot_status: string;
      };
      expect(row).toEqual({
        mission_snapshot: missionJson,
        criteria_results: null,
        snapshot_status: "Pending",
      });
    } finally {
      database.close();
    }
  });

  it.each([
    ["missing snapshot", null],
    ["malformed JSON", "{"],
    ["unknown mission field", JSON.stringify({ ...mission, extra: true })],
  ])("aborts before DDL for an Open row with a %s", (_name, snapshot) => {
    const database = legacyDatabase();
    try {
      addOpenVerification(database, snapshot ?? "");
      expect(() => applyMigration46(database)).toThrow(
        /migration 46 preflight refused Open verification/u,
      );
      const columns = database
        .prepare("PRAGMA table_info(verifications)")
        .all() as Array<{ name: string }>;
      expect(columns.some(({ name }) => name === "criteria_results")).toBe(
        false,
      );
      expect(
        (
          database
            .prepare("SELECT COUNT(*) AS count FROM verifications")
            .get() as { count: number }
        ).count,
      ).toBe(1);
    } finally {
      database.close();
    }
  });

  it("refuses wrong identity, Work revision, event type and duplicate event bindings", () => {
    for (const mutate of [
      (database: DatabaseSync) =>
        database.exec(
          "UPDATE domain_events SET payload_json = json_set(payload_json, '$.verificationId', 'ver_other')",
        ),
      (database: DatabaseSync) =>
        database.exec(
          "UPDATE domain_events SET payload_json = json_set(payload_json, '$.targetWorkRevision', 5)",
        ),
      (database: DatabaseSync) =>
        database.exec(
          "UPDATE domain_events SET event_type = 'VerificationConcluded'",
        ),
      (database: DatabaseSync) =>
        database.exec(
          `INSERT INTO domain_events
           SELECT 'evt_start_duplicate', project_id, event_type, event_version,
                  aggregate_ref, payload_json FROM domain_events`,
        ),
    ]) {
      const database = legacyDatabase();
      try {
        addOpenVerification(database);
        mutate(database);
        expect(() => applyMigration46(database)).toThrow(
          /migration 46 preflight refused Open verification/u,
        );
        expect(
          (
            database
              .prepare("PRAGMA table_info(verifications)")
              .all() as Array<{ name: string }>
          ).some(({ name }) => name === "snapshot_status"),
        ).toBe(false);
      } finally {
        database.close();
      }
    }
  });

  it("marks every prior conclusion UnavailableLegacy without rewriting canonical bytes", () => {
    const database = legacyDatabase();
    const summaryRef = "blob:legacy-summary";
    const missionBytes = missionJson;
    const eventBytes = '{"verdict":"Pass","summaryRef":"blob:legacy-summary"}';
    try {
      database
        .prepare(
          `INSERT INTO verifications
           (verification_id, project_id, work_id, target_work_revision,
            mission_snapshot, state, verdict, conclusion_reason, summary_ref)
           VALUES (?, ?, ?, 4, ?, 'Concluded', 'Pass', NULL, ?)`,
        )
        .run(verificationId, projectId, workId, missionBytes, summaryRef);
      database
        .prepare(
          `INSERT INTO domain_events
           (event_id, project_id, event_type, event_version, aggregate_ref, payload_json)
           VALUES ('evt_old', ?, 'VerificationConcluded', 1, ?, ?)`,
        )
        .run(projectId, verificationId, eventBytes);
      applyMigration46(database);
      const row = database
        .prepare(
          `SELECT mission_snapshot, criteria_results, snapshot_status, verdict,
                  conclusion_reason, summary_ref FROM verifications`,
        )
        .get() as Record<string, unknown>;
      expect(row).toEqual({
        mission_snapshot: missionBytes,
        criteria_results: null,
        snapshot_status: "UnavailableLegacy",
        verdict: "Pass",
        conclusion_reason: null,
        summary_ref: summaryRef,
      });
      expect(
        (
          database.prepare("SELECT payload_json FROM domain_events").get() as {
            payload_json: string;
          }
        ).payload_json,
      ).toBe(eventBytes);
    } finally {
      database.close();
    }
  });

  it("accepts the four allowed row shapes and rejects invalid status/value pairings", () => {
    const database = legacyDatabase();
    try {
      applyMigration46(database);
      const insert = database.prepare(
        `INSERT INTO verifications
         (verification_id, project_id, work_id, target_work_revision,
          mission_snapshot, state, verdict, conclusion_reason, summary_ref,
          criteria_results, snapshot_status)
         VALUES (?, ?, ?, 4, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const common = [projectId, workId, missionJson] as const;
      insert.run(
        "v_pending",
        ...common,
        "Open",
        null,
        null,
        null,
        null,
        "Pending",
      );
      insert.run(
        "v_available",
        ...common,
        "Concluded",
        "Pass",
        null,
        "blob:summary",
        JSON.stringify([
          {
            criterionId: "c1",
            requirement: "r1",
            required: true,
            verdict: "Pass",
            evidenceRefs: ["evd_1"],
          },
        ]),
        "Available",
      );
      insert.run(
        "v_orphan",
        ...common,
        "Concluded",
        "Unknown",
        "Orphaned",
        "blob:summary",
        "[]",
        "NotApplicableOrphaned",
      );
      insert.run(
        "v_legacy",
        ...common,
        "Concluded",
        "Fail",
        null,
        null,
        null,
        "UnavailableLegacy",
      );
      let invalidIndex = 0;
      for (const invalid of [
        ["Open", "Pass", null, "blob:summary", "[]", "Available"],
        ["Concluded", "Pass", null, "blob:summary", "[]", "Pending"],
        ["Concluded", "Unknown", "Orphaned", "blob:summary", "[]", "Available"],
        [
          "Concluded",
          "Pass",
          null,
          "blob:summary",
          "[]",
          "NotApplicableOrphaned",
        ],
        [
          "Concluded",
          "Unknown",
          "Orphaned",
          "blob:summary",
          "[1]",
          "NotApplicableOrphaned",
        ],
        ["Concluded", "Pass", null, "blob:summary", "not-json", "Available"],
      ]) {
        expect(() =>
          insert.run(`v_invalid_${invalidIndex++}`, ...common, ...invalid),
        ).toThrow();
      }
      expect(
        (
          database
            .prepare("SELECT COUNT(*) AS count FROM verifications")
            .get() as { count: number }
        ).count,
      ).toBe(4);
    } finally {
      database.close();
    }
  });
});
