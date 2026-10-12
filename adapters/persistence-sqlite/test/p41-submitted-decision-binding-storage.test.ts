import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecoveryAttentionFactStore, TransactionPort } from "@arbor/ports";
import { Effect, Exit, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  CURRENT_MIGRATIONS,
  DomainEventJournalLive,
  IdGeneratorLive,
  layer,
  makeRecoveryAttentionFactStoreLive,
  P36_MIGRATIONS,
  P41_SUBMITTED_DECISION_BINDING_ATTENTION_DDL,
  P41_SUBMITTED_DECISION_BINDING_ATTENTION_FINGERPRINT,
  P41_SUBMITTED_DECISION_BINDING_ATTENTION_MIGRATION,
  splitStatements,
  TransactionPortLive,
} from "../src/index.js";

const executionId = "exe_p41_storage";
const projectId = "prj_p41_storage";
const workspaceId = "ws_p41_storage";
const eventId = "evt_p41_storage_valid";
const attentionFactId = `att_${"a".repeat(64)}`;

const expectP41Unavailable = <A, E>(exit: Exit.Exit<A, E>) => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(JSON.stringify(exit.cause)).toContain("P41MigrationNotRegistered");
  }
};

const applyEquivalentP41Schema = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.unsafe(`
    CREATE TABLE executions (
      execution_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL
    )
  `);
  yield* sql.unsafe(
    `CREATE UNIQUE INDEX executions_id_project_workspace
       ON executions(execution_id, project_id, workspace_id)`,
  );
  yield* sql.unsafe("INSERT INTO executions VALUES (?, ?, ?)", [
    executionId,
    projectId,
    workspaceId,
  ]);
  for (const statement of splitStatements(
    P41_SUBMITTED_DECISION_BINDING_ATTENTION_DDL,
  )) {
    yield* sql.unsafe(statement);
  }
  return sql;
});

const insertFact = (
  sql: SqlClient,
  values: {
    attentionFactId: string | null;
    eventId: string;
    logicalActionId: string;
    workspaceId?: string;
  },
) =>
  sql.unsafe(
    `INSERT INTO submitted_decision_binding_attention_facts (
      attention_fact_id, event_id, project_id, execution_id, workspace_id,
      logical_step_no, repair_attempt, provider_turn_id, logical_action_id,
      failure_code, first_detected_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      values.attentionFactId,
      values.eventId,
      projectId,
      executionId,
      values.workspaceId ?? workspaceId,
      0,
      0,
      "ptn_p41_storage",
      values.logicalActionId,
      "StepManifestMismatch",
      "2026-10-12T00:00:00.000Z",
    ],
  );

const makeStoreApp = (filename: string) => {
  const sqlite = layer({ filename });
  const infra = Layer.mergeAll(sqlite, IdGeneratorLive);
  const journal = Layer.provide(DomainEventJournalLive, infra);
  const facts = Layer.provide(
    makeRecoveryAttentionFactStoreLive(),
    Layer.mergeAll(infra, journal),
  );
  return Layer.mergeAll(
    infra,
    journal,
    facts,
    Layer.provide(TransactionPortLive, sqlite),
  );
};

const requireStoreMethod = <A>(method: A | undefined): A => {
  if (method === undefined) throw new Error("P41 store method is unavailable");
  return method;
};

const runStoreDb = <A>(
  filename: string,
  program: Effect.Effect<
    A,
    unknown,
    SqlClient | RecoveryAttentionFactStore | TransactionPort
  >,
) =>
  Effect.runPromise(
    Effect.scoped(Effect.provide(program, makeStoreApp(filename))),
  );

describe("P41 / 0041 submitted DecisionEpisode storage", () => {
  it("keeps the exact descriptor standalone and fingerprints the corrected DDL", () => {
    expect(P41_SUBMITTED_DECISION_BINDING_ATTENTION_MIGRATION).toEqual({
      id: 41,
      name: "p41_submitted_decision_binding_attention",
      sql: P41_SUBMITTED_DECISION_BINDING_ATTENTION_DDL,
    });
    expect(P36_MIGRATIONS.some(({ id }) => id === 41)).toBe(false);
    expect(CURRENT_MIGRATIONS.some(({ id }) => id === 41)).toBe(false);

    const sha256Hex = (value: string) =>
      createHash("sha256").update(value, "utf8").digest("hex");
    const ddlSha256 = sha256Hex(
      P41_SUBMITTED_DECISION_BINDING_ATTENTION_DDL.trim(),
    );
    expect(ddlSha256).toBe(
      "8b5908a58cbc9f75b8188df4fa6d22481f60b028581a603b022f1d883373846a",
    );
    expect(
      sha256Hex(
        ["41", "p41_submitted_decision_binding_attention", ddlSha256].join(
          "\n",
        ),
      ),
    ).toBe(P41_SUBMITTED_DECISION_BINDING_ATTENTION_FINGERPRINT);
  });

  it("rejects a NULL fact key when every parent and other fact constraint is valid", async () => {
    const program = Effect.gen(function* () {
      const sql = yield* applyEquivalentP41Schema;
      const versionBefore = yield* sql.unsafe<{ user_version: number }>(
        "PRAGMA user_version",
      );
      const nullKey = yield* Effect.exit(
        insertFact(sql, {
          attentionFactId: null,
          eventId: "evt_null_id",
          logicalActionId: "lac_p41_null",
        }),
      );
      const count = yield* sql.unsafe<{ count: number }>(
        "SELECT COUNT(*) AS count FROM submitted_decision_binding_attention_facts",
      );
      return {
        versionBefore: Number(versionBefore[0]?.user_version),
        nullKey,
        nullKeyCause: Exit.isFailure(nullKey)
          ? JSON.stringify(nullKey.cause)
          : "",
        factCount: Number(count[0]?.count),
      };
    });

    const result = await Effect.runPromise(
      Effect.provide(program, layer({ filename: ":memory:" })),
    );
    expect(result.versionBefore).toBe(0);
    expect(Exit.isFailure(result.nullKey)).toBe(true);
    expect(result.nullKeyCause).toContain('"errcode":1299');
    expect(result.factCount).toBe(0);
  });

  it("keeps positive insertion, exact tuple/event uniqueness, composite marker FK, and fact immutability", async () => {
    const program = Effect.gen(function* () {
      const sql = yield* applyEquivalentP41Schema;
      yield* insertFact(sql, {
        attentionFactId,
        eventId,
        logicalActionId: "lac_p41_storage",
      });
      const duplicateTuple = yield* Effect.exit(
        insertFact(sql, {
          attentionFactId: `att_${"b".repeat(64)}`,
          eventId: "evt_duplicate_tuple",
          logicalActionId: "lac_p41_storage",
        }),
      );
      const duplicateEvent = yield* Effect.exit(
        insertFact(sql, {
          attentionFactId: `att_${"c".repeat(64)}`,
          eventId,
          logicalActionId: "lac_duplicate_event",
        }),
      );
      const marker = yield* Effect.exit(
        sql.unsafe(
          `INSERT INTO submitted_decision_binding_attention_rows
             (project_id, attention_fact_id, workspace_id) VALUES (?, ?, ?)`,
          [projectId, attentionFactId, workspaceId],
        ),
      );
      const mismatchedMarker = yield* Effect.exit(
        sql.unsafe(
          `INSERT INTO submitted_decision_binding_attention_rows
             (project_id, attention_fact_id, workspace_id) VALUES (?, ?, ?)`,
          [projectId, attentionFactId, "ws_wrong_target"],
        ),
      );
      const missingParent = yield* Effect.exit(
        insertFact(sql, {
          attentionFactId: `att_${"d".repeat(64)}`,
          eventId: "evt_missing_parent",
          logicalActionId: "lac_missing_parent",
          workspaceId: "ws_missing_parent",
        }),
      );
      const update = yield* Effect.exit(
        sql.unsafe(
          `UPDATE submitted_decision_binding_attention_facts
              SET failure_code = 'StepManifestMismatch'
            WHERE attention_fact_id = ?`,
          [attentionFactId],
        ),
      );
      const remove = yield* Effect.exit(
        sql.unsafe(
          `DELETE FROM submitted_decision_binding_attention_facts
            WHERE attention_fact_id = ?`,
          [attentionFactId],
        ),
      );
      const count = yield* sql.unsafe<{ count: number }>(
        `SELECT COUNT(*) AS count
           FROM submitted_decision_binding_attention_facts
          WHERE attention_fact_id = ?`,
        [attentionFactId],
      );
      const markerCount = yield* sql.unsafe<{ count: number }>(
        `SELECT COUNT(*) AS count FROM submitted_decision_binding_attention_rows
          WHERE project_id = ? AND attention_fact_id = ?`,
        [projectId, attentionFactId],
      );
      const foreignKeyViolations = yield* sql.unsafe(
        "PRAGMA foreign_key_check",
      );
      return {
        duplicateTuple,
        duplicateEvent,
        marker,
        mismatchedMarker,
        missingParent,
        update,
        remove,
        count: Number(count[0]?.count),
        markerCount: Number(markerCount[0]?.count),
        foreignKeyViolations,
      };
    });

    const result = await Effect.runPromise(
      Effect.provide(program, layer({ filename: ":memory:" })),
    );
    expect(Exit.isFailure(result.duplicateTuple)).toBe(true);
    expect(Exit.isFailure(result.duplicateEvent)).toBe(true);
    expect(Exit.isSuccess(result.marker)).toBe(true);
    expect(Exit.isFailure(result.mismatchedMarker)).toBe(true);
    expect(Exit.isFailure(result.missingParent)).toBe(true);
    expect(Exit.isFailure(result.update)).toBe(true);
    expect(Exit.isFailure(result.remove)).toBe(true);
    expect(result.count).toBe(1);
    expect(result.markerCount).toBe(1);
    expect(result.foreignKeyViolations).toEqual([]);
  });

  it("persists caller-bound facts idempotently and reads them after SQLite reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arbor-p41-storage-"));
    const filename = join(directory, "equivalent.sqlite");
    const fact = {
      attentionFactId: `att_${"e".repeat(64)}`,
      eventId: "evt_store_persisted",
      projectId: projectId as never,
      executionId: executionId as never,
      workspaceId: workspaceId as never,
      logicalStepNo: 2,
      repairAttempt: 1,
      providerTurnId: "ptn_store_persisted" as never,
      logicalActionId: "lac_store_persisted",
      failureCode: "DecisionRequestWorkspaceMismatch" as const,
      firstDetectedAt: "2026-10-12T00:00:00.000Z",
    };
    try {
      const first = await runStoreDb(
        filename,
        Effect.gen(function* () {
          const tx = yield* TransactionPort;
          const facts = yield* RecoveryAttentionFactStore;
          const sql = yield* SqlClient;
          yield* tx.transact(applyEquivalentP41Schema.pipe(Effect.asVoid));
          const stored = yield* tx.transact(
            requireStoreMethod(facts.recordSubmittedDecisionBindingFailure)(
              fact,
            ),
          );
          const replay = yield* tx.transact(
            requireStoreMethod(facts.recordSubmittedDecisionBindingFailure)(
              fact,
            ),
          );
          const conflict = yield* tx.transact(
            Effect.exit(
              requireStoreMethod(facts.recordSubmittedDecisionBindingFailure)({
                ...fact,
                eventId: "evt_store_conflict",
              }),
            ),
          );
          const read = yield* tx.transact(
            requireStoreMethod(facts.findSubmittedDecisionBindingFailure)(
              fact.attentionFactId,
            ),
          );
          const listed = yield* tx.transact(
            requireStoreMethod(facts.listSubmittedDecisionBindingFailures)(
              projectId as never,
            ),
          );
          const foreignKeyViolations = yield* sql.unsafe(
            "PRAGMA foreign_key_check",
          );
          return {
            stored,
            replay,
            conflict,
            read: Option.getOrUndefined(read),
            listed,
            foreignKeyViolations,
          };
        }),
      );

      const reopened = await runStoreDb(
        filename,
        Effect.gen(function* () {
          const tx = yield* TransactionPort;
          const facts = yield* RecoveryAttentionFactStore;
          const read = yield* tx.transact(
            requireStoreMethod(facts.findSubmittedDecisionBindingFailure)(
              fact.attentionFactId,
            ),
          );
          const listed = yield* tx.transact(
            requireStoreMethod(facts.listSubmittedDecisionBindingFailures)(
              projectId as never,
            ),
          );
          return {
            read: Option.getOrUndefined(read),
            listed,
          };
        }),
      );
      expect(first.stored).toEqual(fact);
      expect(first.replay).toEqual(fact);
      expect(Exit.isFailure(first.conflict)).toBe(true);
      expect(first.read).toEqual(fact);
      expect(first.listed).toEqual([fact]);
      expect(first.foreignKeyViolations).toEqual([]);
      expect(reopened.read).toEqual(fact);
      expect(reopened.listed).toEqual([fact]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports standalone-store absence as unavailable and fails reads closed", async () => {
    const result = await runStoreDb(
      ":memory:",
      Effect.gen(function* () {
        const tx = yield* TransactionPort;
        const facts = yield* RecoveryAttentionFactStore;
        const available = yield* tx.transact(
          requireStoreMethod(facts.isSubmittedDecisionBindingAvailable)(),
        );
        const absent = yield* tx.transact(
          Effect.exit(
            requireStoreMethod(facts.findSubmittedDecisionBindingFailure)(
              attentionFactId,
            ),
          ),
        );
        const absentRecord = yield* tx.transact(
          Effect.exit(
            requireStoreMethod(facts.recordSubmittedDecisionBindingFailure)({
              attentionFactId,
              eventId,
              projectId: projectId as never,
              executionId: executionId as never,
              workspaceId: workspaceId as never,
              logicalStepNo: 1,
              repairAttempt: 0,
              providerTurnId: "ptn_p41_absent" as never,
              logicalActionId: "lac_p41_absent",
              failureCode: "DecisionRequestWorkspaceMismatch" as const,
              firstDetectedAt: "2026-10-12T00:00:00.000Z",
            }),
          ),
        );
        const absentList = yield* tx.transact(
          Effect.exit(
            requireStoreMethod(facts.listSubmittedDecisionBindingFailures)(
              projectId as never,
            ),
          ),
        );
        return { available, absent, absentRecord, absentList };
      }),
    );
    expect(result.available).toBe(false);
    expectP41Unavailable(result.absent);
    expectP41Unavailable(result.absentRecord);
    expectP41Unavailable(result.absentList);
  });
});
