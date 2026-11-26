import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, Option } from "effect";
import { expect } from "vitest";
import {
  layer,
  runMigrations,
  SandboxPolicyDecisionStoreLive,
  TransactionPortLive,
} from "../../adapters/persistence-sqlite/src/index.js";
import { P57_WORKSPACE_SANDBOX_AUTHORIZATION_MIGRATION } from "../../adapters/persistence-sqlite/src/p57-workspace-sandbox-authorization-migration.js";
import {
  SandboxPolicyDecisionStore,
  TransactionPort,
} from "../../packages/ports/src/index.js";
import {
  app,
  execute,
  factory,
  parentExecution,
  payload,
  projectId,
  root,
  seed,
  seedLegacySandboxDecision,
} from "./support.js";

const migrate = (filename: string) =>
  Effect.runPromise(
    Effect.provide(
      runMigrations([P57_WORKSPACE_SANDBOX_AUTHORIZATION_MIGRATION], {
        allowOfflineOnly: true,
      }),
      layer({ filename }),
    ),
  );

export const preservesLegacyDecisions = async (): Promise<void> => {
  const fixture = factory.create();
  try {
    seed(fixture.databaseFilename);
    const legacy = seedLegacySandboxDecision(fixture.databaseFilename);
    const before = new DatabaseSync(fixture.databaseFilename);
    const originalRow = before
      .prepare("SELECT * FROM sandbox_policy_decisions")
      .get();
    const originalFact = before
      .prepare("SELECT * FROM sandbox_provider_unavailable_facts")
      .get();
    before.close();
    await migrate(fixture.databaseFilename);
    const db = new DatabaseSync(fixture.databaseFilename);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      expect(
        db.prepare("SELECT * FROM sandbox_policy_decisions").get(),
      ).toEqual({
        ...originalRow,
        authority_kind: "LegacyHumanGrant",
        workspace_authorization_revision: null,
      });
      expect(
        db.prepare("SELECT * FROM sandbox_provider_unavailable_facts").get(),
      ).toEqual(originalFact);
      expect(
        db
          .prepare("SELECT result_json FROM commands WHERE command_id = ?")
          .get(legacy.decisionCommand),
      ).toEqual({ result_json: legacy.bytes });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(() =>
        db.exec(
          "UPDATE sandbox_policy_decisions SET actor_principal = 'user:other'",
        ),
      ).toThrow(/immutable/);
      expect(() => db.exec("DELETE FROM sandbox_policy_decisions")).toThrow(
        /retained/,
      );
    } finally {
      db.close();
    }
    const base = layer({ filename: fixture.databaseFilename });
    const services = Layer.mergeAll(
      base,
      Layer.provide(TransactionPortLive, base),
      Layer.provide(SandboxPolicyDecisionStoreLive, base),
    );
    const read = () =>
      Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const tx = yield* TransactionPort;
            const store = yield* SandboxPolicyDecisionStore;
            return yield* tx.transact(
              store.findCurrentForExecution(projectId, root, parentExecution),
            );
          }),
          services,
        ),
      );
    expect(Option.getOrThrow(await read()).result).toEqual(legacy.result);
    // Reopening the adapter still reads the same exact committed bytes.
    expect(
      Option.getOrThrow(await read()).decision.authorityKind,
    ).toBeUndefined();
    await Effect.runPromise(
      Effect.provide(execute(906, payload()), app(fixture.databaseFilename)),
    );
    const constraints = new DatabaseSync(fixture.databaseFilename);
    try {
      constraints.exec("PRAGMA foreign_keys = ON");
      const insert = constraints.prepare(`INSERT INTO sandbox_policy_decisions (
      project_id,workspace_id,execution_id,episode_binding_json,policy_revision,expected_execution_revision,expected_policy_revision,
      profile_id,provider_id,network_policy_json,policy_digest,permission_grant_id,grant_permission_command_id,grant_issuer_principal,
      operator_config_revision,operator_config_digest,actor_principal,decision_command_id,issued_at,expires_at,
      authority_kind,workspace_authorization_revision)
      SELECT project_id,workspace_id,execution_id,episode_binding_json,2,expected_execution_revision,1,
        ?,provider_id,network_policy_json,policy_digest,?,NULL,NULL,
        operator_config_revision,operator_config_digest,'system:workspace-policy',?,issued_at,expires_at,?,?
      FROM sandbox_policy_decisions WHERE policy_revision = 1`);
      for (const values of [
        ["ReadOnly", null, legacy.grantCommand, "WorkspaceAuthorization", 99],
        ["FullAccess", null, legacy.grantCommand, "WorkspaceAuthorization", 1],
        [
          "ReadOnly",
          legacy.grantId,
          legacy.grantCommand,
          "WorkspaceAuthorization",
          1,
        ],
        ["ReadOnly", null, legacy.grantCommand, "LegacyHumanGrant", 1],
        ["ReadOnly", null, legacy.grantCommand, "Unknown", 1],
      ] as const)
        expect(() => insert.run(...values)).toThrow();
      // A real same-Workspace revision succeeds; rollback keeps this a
      // constraint qualification rather than manufacturing a usable receipt.
      constraints.exec("BEGIN");
      insert.run(
        "ReadOnly",
        null,
        legacy.grantCommand,
        "WorkspaceAuthorization",
        1,
      );
      expect(constraints.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      constraints.exec("ROLLBACK");
    } finally {
      constraints.close();
    }
  } finally {
    fixture.cleanup();
  }
};

export const rollsBackRebuildOnBrokenForeignKeys = async (): Promise<void> => {
  const fixture = factory.create();
  try {
    seed(fixture.databaseFilename);
    seedLegacySandboxDecision(fixture.databaseFilename);
    const corrupt = new DatabaseSync(fixture.databaseFilename);
    corrupt.exec("PRAGMA foreign_keys = OFF; DELETE FROM commands");
    corrupt.close();
    await expect(migrate(fixture.databaseFilename)).rejects.toBeDefined();
    const db = new DatabaseSync(fixture.databaseFilename);
    try {
      expect(db.prepare("PRAGMA user_version").get()).toEqual({
        user_version: 56,
      });
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name IN ('workspace_sandbox_authorizations', 'sandbox_policy_decisions_0057')",
          )
          .all(),
      ).toEqual([]);
      expect(
        (
          db.prepare("PRAGMA table_info(sandbox_policy_decisions)").all() as {
            name: string;
          }[]
        ).some((c) => c.name === "authority_kind"),
      ).toBe(false);
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM sandbox_policy_decisions").get(),
      ).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  } finally {
    fixture.cleanup();
  }
};
