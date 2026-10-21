import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { createSchema48TestDatabase } from "../../../tests/support/schema44-database.js";
import {
  CURRENT_MIGRATIONS,
  CURRENT_SCHEMA_VERSION,
  layer,
  P49_SANDBOX_POLICY_AND_GRANT_PROVENANCE_FINGERPRINT,
  P49_SANDBOX_POLICY_AND_GRANT_PROVENANCE_MIGRATION,
  P50_SANDBOX_PROVIDER_UNAVAILABLE_FACT_FINGERPRINT,
  P50_SANDBOX_PROVIDER_UNAVAILABLE_FACT_MIGRATION,
  P51_VERIFICATION_V2_CONSUMER_RECONCILIATION_FINGERPRINT,
  P51_VERIFICATION_V2_CONSUMER_RECONCILIATION_MIGRATION,
  runMigrations,
} from "../src/index.js";

const run = (
  filename: string,
  migrations: Parameters<typeof runMigrations>[0] = CURRENT_MIGRATIONS,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        runMigrations(migrations, { allowOfflineOnly: true }),
        layer({ filename }),
      ),
    ),
  );

const tableColumns = (db: DatabaseSync, table: string) =>
  (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map(({ name }) => name);

describe("Native OS Sandbox schema 0049/0050 storage", () => {
  it("registers the exact offline-only 48→49→50 suffix", () => {
    expect(P49_SANDBOX_POLICY_AND_GRANT_PROVENANCE_MIGRATION).toMatchObject({
      id: 49,
      name: "sandbox_policy_and_grant_provenance",
      requiresUserVersion: 48,
      offlineOnly: true,
    });
    expect(P50_SANDBOX_PROVIDER_UNAVAILABLE_FACT_MIGRATION).toMatchObject({
      id: 50,
      name: "sandbox_provider_unavailable_fact",
      requiresUserVersion: 49,
      offlineOnly: true,
    });
    expect(P51_VERIFICATION_V2_CONSUMER_RECONCILIATION_MIGRATION).toMatchObject(
      {
        id: 51,
        name: "verification_v2_consumer_reconciliation",
        requiresUserVersion: 50,
        offlineOnly: true,
      },
    );
    expect(CURRENT_SCHEMA_VERSION).toBe(51);
    expect(CURRENT_MIGRATIONS.map(({ id }) => id).slice(-6)).toEqual([
      46, 47, 48, 49, 50, 51,
    ]);
    const fingerprint = (requires: number, name: string, sql: string) =>
      createHash("sha256")
        .update(
          `${requires}\n${name}\n${createHash("sha256").update(sql).digest("hex")}`,
          "utf8",
        )
        .digest("hex");
    expect(P49_SANDBOX_POLICY_AND_GRANT_PROVENANCE_FINGERPRINT).toBe(
      fingerprint(
        48,
        P49_SANDBOX_POLICY_AND_GRANT_PROVENANCE_MIGRATION.name,
        P49_SANDBOX_POLICY_AND_GRANT_PROVENANCE_MIGRATION.sql,
      ),
    );
    expect(P50_SANDBOX_PROVIDER_UNAVAILABLE_FACT_FINGERPRINT).toBe(
      fingerprint(
        49,
        P50_SANDBOX_PROVIDER_UNAVAILABLE_FACT_MIGRATION.name,
        P50_SANDBOX_PROVIDER_UNAVAILABLE_FACT_MIGRATION.sql,
      ),
    );
    expect(P51_VERIFICATION_V2_CONSUMER_RECONCILIATION_FINGERPRINT).toBe(
      fingerprint(
        50,
        P51_VERIFICATION_V2_CONSUMER_RECONCILIATION_MIGRATION.name,
        P51_VERIFICATION_V2_CONSUMER_RECONCILIATION_MIGRATION.sql,
      ),
    );
  });

  it("normalizes only revoked P29-unbound NULL revisions and creates empty immutable ledgers", async () => {
    const fixture = await createSchema48TestDatabase();
    try {
      const seed = new DatabaseSync(fixture.databaseFilename);
      try {
        seed.exec("PRAGMA foreign_keys = ON");
        seed
          .prepare(
            `INSERT INTO permission_grants (
             permission_grant_id, project_id, scope, issuer, lifetime,
             state, subject_kind, subject_ref, capability, revision
           ) VALUES (?, 'prj_sandbox_storage', 'SandboxPolicy', 'user:test',
                     'PT1H', ?, ?, ?, ?, ?)`,
          )
          .run("pgr_revoked_unbound_null", "Revoked", null, null, null, null);
        seed
          .prepare(
            `INSERT INTO permission_grants (
             permission_grant_id, project_id, scope, issuer, lifetime,
             state, subject_kind, subject_ref, capability, revision
           ) VALUES (?, 'prj_sandbox_storage', 'SandboxPolicy', 'user:test',
                     'PT1H', ?, ?, ?, ?, ?)`,
          )
          .run("pgr_revoked_unbound_zero", "Revoked", null, null, null, 0);
      } finally {
        seed.close();
      }

      expect(
        await run(fixture.databaseFilename, [
          P49_SANDBOX_POLICY_AND_GRANT_PROVENANCE_MIGRATION,
        ]),
      ).toBe(1);
      expect(
        await run(fixture.databaseFilename, [
          P50_SANDBOX_PROVIDER_UNAVAILABLE_FACT_MIGRATION,
        ]),
      ).toBe(1);
      expect(await run(fixture.databaseFilename)).toBe(1);
      const db = new DatabaseSync(fixture.databaseFilename, { readOnly: true });
      try {
        expect(
          (
            db.prepare("PRAGMA user_version").get() as {
              user_version: number;
            }
          ).user_version,
        ).toBe(51);
        expect(
          db
            .prepare(
              `SELECT permission_grant_id, revision FROM permission_grants
               WHERE permission_grant_id LIKE 'pgr_revoked_unbound_%'
               ORDER BY permission_grant_id`,
            )
            .all(),
        ).toEqual([
          { permission_grant_id: "pgr_revoked_unbound_null", revision: 0 },
          { permission_grant_id: "pgr_revoked_unbound_zero", revision: 0 },
        ]);
        expect(
          tableColumns(db, "sandbox_policy_grant_issuer_provenance"),
        ).toEqual([
          "permission_grant_id",
          "grant_permission_command_id",
          "issuer_principal",
          "operator_config_revision",
          "operator_config_digest",
        ]);
        expect(tableColumns(db, "sandbox_policy_decisions")).toEqual([
          "project_id",
          "workspace_id",
          "execution_id",
          "episode_binding_json",
          "policy_revision",
          "expected_execution_revision",
          "expected_policy_revision",
          "profile_id",
          "provider_id",
          "network_policy_json",
          "policy_digest",
          "permission_grant_id",
          "grant_permission_command_id",
          "grant_issuer_principal",
          "operator_config_revision",
          "operator_config_digest",
          "actor_principal",
          "decision_command_id",
          "issued_at",
          "expires_at",
        ]);
        expect(tableColumns(db, "sandbox_provider_unavailable_facts")).toEqual([
          "attention_fact_id",
          "event_id",
          "project_id",
          "execution_id",
          "workspace_id",
          "episode_binding_json",
          "policy_revision",
          "policy_digest",
          "profile_id",
          "provider_id",
          "provider_version",
          "probe_evidence_ref",
          "failure_code",
          "first_detected_at",
        ]);
        expect(
          tableColumns(db, "sandbox_provider_unavailable_attention_rows"),
        ).toEqual(["project_id", "attention_fact_id", "workspace_id"]);
        expect(
          tableColumns(db, "sandbox_provider_unavailable_attention_queue"),
        ).toEqual([
          "project_id",
          "attention_fact_id",
          "workspace_id",
          "state",
          "claim_id",
          "claim_expires_at",
          "attempt_count",
          "enqueued_at",
          "consumed_at",
        ]);
        expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(
          db
            .prepare(
              `SELECT name FROM sqlite_schema
               WHERE name LIKE 'sandbox_policy_%' OR name LIKE 'sandbox_provider_unavailable_%'
               ORDER BY name`,
            )
            .all(),
        ).toHaveLength(16);
        expect(
          db
            .prepare("SELECT COUNT(*) AS count FROM sandbox_policy_decisions")
            .get(),
        ).toEqual({ count: 0 });
        expect(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM sandbox_provider_unavailable_facts",
            )
            .get(),
        ).toEqual({ count: 0 });
        const foreignKeyTables = (table: string) =>
          Array.from(
            new Set(
              (
                db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
                  table: string;
                }>
              ).map(({ table: parent }) => parent),
            ),
          );
        expect(
          foreignKeyTables("sandbox_policy_grant_issuer_provenance").sort(),
        ).toEqual(["commands", "permission_grants"]);
        expect(foreignKeyTables("sandbox_policy_decisions").sort()).toEqual([
          "commands",
          "executions",
          "sandbox_policy_grant_issuer_provenance",
        ]);
        expect(
          foreignKeyTables("sandbox_provider_unavailable_facts").sort(),
        ).toEqual(["executions", "sandbox_policy_decisions"]);
        expect(
          foreignKeyTables("sandbox_provider_unavailable_attention_rows"),
        ).toEqual(["sandbox_provider_unavailable_facts"]);
        expect(
          foreignKeyTables("sandbox_provider_unavailable_attention_queue"),
        ).toEqual(["sandbox_provider_unavailable_facts"]);
        expect(
          db
            .prepare(
              `SELECT name FROM sqlite_schema WHERE type = 'index'
               AND name LIKE 'sandbox_%' ORDER BY name`,
            )
            .all(),
        ).toEqual([
          { name: "sandbox_policy_grant_provenance_exact_binding" },
          { name: "sandbox_provider_unavailable_fact_project_time" },
          { name: "sandbox_provider_unavailable_queue_due" },
        ]);
        expect(
          db
            .prepare(
              `SELECT name FROM sqlite_schema WHERE type = 'trigger'
               AND name LIKE 'sandbox_%' ORDER BY name`,
            )
            .all(),
        ).toHaveLength(8);
      } finally {
        db.close();
      }
    } finally {
      fixture.cleanup();
    }
  }, 120_000);

  it.each([
    ["Revoked", "WorkspaceAgent", "ws_bound", "SandboxPolicy"],
    ["Active", null, null, null],
  ])(
    "fails closed before any 0049 write for disallowed NULL revision (%s)",
    async (state, kind, ref, capability) => {
      const fixture = await createSchema48TestDatabase();
      try {
        const seed = new DatabaseSync(fixture.databaseFilename);
        try {
          seed
            .prepare(
              `INSERT INTO permission_grants (
             permission_grant_id, project_id, scope, issuer, lifetime,
             state, subject_kind, subject_ref, capability, revision
           ) VALUES ('pgr_invalid_null', 'prj_sandbox_storage', 'SandboxPolicy',
                     'user:test', 'PT1H', ?, ?, ?, ?, NULL)`,
            )
            .run(state, kind, ref, capability);
        } finally {
          seed.close();
        }

        await expect(run(fixture.databaseFilename)).rejects.toThrow();
        const db = new DatabaseSync(fixture.databaseFilename, {
          readOnly: true,
        });
        try {
          expect(
            (
              db.prepare("PRAGMA user_version").get() as {
                user_version: number;
              }
            ).user_version,
          ).toBe(48);
          expect(
            db
              .prepare(
                "SELECT name FROM sqlite_schema WHERE name = 'sandbox_policy_decisions'",
              )
              .all(),
          ).toEqual([]);
          expect(
            db
              .prepare(
                "SELECT revision FROM permission_grants WHERE permission_grant_id = 'pgr_invalid_null'",
              )
              .get(),
          ).toEqual({ revision: null });
        } finally {
          db.close();
        }
      } finally {
        fixture.cleanup();
      }
    },
    120_000,
  );

  it("enforces immutable and retained fact/decision/provenance/queue storage in SQLite", async () => {
    const fixture = await createSchema48TestDatabase();
    try {
      await run(fixture.databaseFilename);
      const db = new DatabaseSync(fixture.databaseFilename);
      try {
        db.exec("PRAGMA foreign_keys = OFF");
        db.prepare(
          `INSERT INTO sandbox_policy_grant_issuer_provenance (
             permission_grant_id, grant_permission_command_id, issuer_principal,
             operator_config_revision, operator_config_digest
           ) VALUES ('pgr_trigger', 'cmd_trigger_grant', 'user:test', 1, ?)`,
        ).run("a".repeat(64));
        db.prepare(
          `INSERT INTO sandbox_policy_decisions (
             project_id, workspace_id, execution_id, episode_binding_json,
             policy_revision, expected_execution_revision, expected_policy_revision,
             profile_id, provider_id, network_policy_json, policy_digest,
             permission_grant_id, grant_permission_command_id, grant_issuer_principal,
             operator_config_revision, operator_config_digest, actor_principal,
             decision_command_id, issued_at, expires_at
           ) VALUES ('prj_trigger', 'ws_trigger', 'exe_trigger', '{}',
             1, 0, 0, 'ReadOnly', 'provider', '{}', ?, 'pgr_trigger',
             'cmd_trigger_grant', 'user:test', 1, ?, 'user:test',
             'cmd_trigger_decision', 't0', 't1')`,
        ).run("b".repeat(64), "a".repeat(64));
        db.prepare(
          `INSERT INTO sandbox_provider_unavailable_facts (
             attention_fact_id, event_id, project_id, execution_id, workspace_id,
             episode_binding_json, policy_revision, policy_digest, profile_id,
             provider_id, provider_version, probe_evidence_ref, failure_code,
             first_detected_at
           ) VALUES ('att_trigger', 'evt_trigger', 'prj_trigger', 'exe_trigger',
             'ws_trigger', '{}', 1, ?, 'ReadOnly', 'provider', 'v1', NULL,
             'Unavailable', 't0')`,
        ).run("b".repeat(64));
        db.prepare(
          `INSERT INTO sandbox_provider_unavailable_attention_queue (
             project_id, attention_fact_id, workspace_id, state, claim_id,
             claim_expires_at, attempt_count, enqueued_at, consumed_at
           ) VALUES ('prj_trigger', 'att_trigger', 'ws_trigger', 'Pending',
             NULL, NULL, 0, 't0', NULL)`,
        ).run();
        expect(() =>
          db.exec("UPDATE sandbox_policy_decisions SET policy_revision = 2"),
        ).toThrow();
        expect(() => db.exec("DELETE FROM sandbox_policy_decisions")).toThrow();
        expect(() =>
          db.exec(
            "UPDATE sandbox_policy_grant_issuer_provenance SET issuer_principal = 'user:other'",
          ),
        ).toThrow();
        expect(() =>
          db.exec("DELETE FROM sandbox_policy_grant_issuer_provenance"),
        ).toThrow();
        expect(() =>
          db.exec(
            "UPDATE sandbox_provider_unavailable_facts SET failure_code = 'changed'",
          ),
        ).toThrow();
        expect(() =>
          db.exec("DELETE FROM sandbox_provider_unavailable_facts"),
        ).toThrow();
        expect(() =>
          db.exec("DELETE FROM sandbox_provider_unavailable_attention_queue"),
        ).toThrow();
        expect(() =>
          db.exec(
            `UPDATE sandbox_provider_unavailable_attention_queue
             SET attention_fact_id = 'att_rekeyed'`,
          ),
        ).toThrow();
        expect(() =>
          db
            .prepare(
              `INSERT INTO sandbox_provider_unavailable_facts (
               attention_fact_id, event_id, project_id, execution_id,
               workspace_id, episode_binding_json, policy_revision,
               policy_digest, profile_id, provider_id, provider_version,
               probe_evidence_ref, failure_code, first_detected_at
             ) VALUES ('att_bad_json', 'evt_bad_json', 'prj_trigger',
               'exe_trigger', 'ws_trigger', 'not-json', 1, ?, 'ReadOnly',
               'provider', 'v1', NULL, 'Unavailable', 't0')`,
            )
            .run("b".repeat(64)),
        ).toThrow();
        expect(() =>
          db
            .prepare(
              `INSERT INTO sandbox_provider_unavailable_facts (
               attention_fact_id, event_id, project_id, execution_id,
               workspace_id, episode_binding_json, policy_revision,
               policy_digest, profile_id, provider_id, provider_version,
               probe_evidence_ref, failure_code, first_detected_at
             ) VALUES ('att_bad_reason', 'evt_bad_reason', 'prj_trigger',
               'exe_trigger', 'ws_trigger', '{}', 2, ?, 'ReadOnly',
               'provider', 'v1', NULL, ?, 't0')`,
            )
            .run("b".repeat(64), `x${"é".repeat(64)}`),
        ).toThrow();
      } finally {
        db.close();
      }
    } finally {
      fixture.cleanup();
    }
  }, 120_000);
});
