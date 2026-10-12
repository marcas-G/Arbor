import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Exit, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  P8_MIGRATIONS,
  P41_SUBMITTED_DECISION_BINDING_ATTENTION_DDL,
  runMigrations,
} from "../adapters/persistence-sqlite/src/index.js";
import type { ProjectId, WorkspaceId } from "../packages/domain/dist/index.js";
import { recordSubmittedDecisionBindingFailure } from "../packages/execution-runtime/src/submitted-decision-binding-failure.js";
import {
  RecoveryAttentionFactStore,
  TransactionPort,
} from "../packages/ports/src/index.js";
import {
  deriveProjectAttention,
  projectionReadError,
} from "../packages/projection-runtime/src/index.js";
import {
  insertExecutionRow,
  insertProjectRootRow,
  insertWorkspaceRow,
  makeP10App,
  makeP10Deps,
  runP10,
  seedCanonical,
} from "./support/p10-fixture.js";

describe("P41 P10 Attention rebuild after SQLite reopen", () => {
  it("rebuilds one row from the retained event and production P9 fact store", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arbor-p41-p10-rebuild-"));
    const filename = join(directory, "attention.sqlite");
    const projectId = "prj_01900000-0000-7000-8000-000000000010" as ProjectId;
    const workspaceId =
      "ws_01900000-0000-7000-8000-000000000010" as WorkspaceId;
    const executionId = "exe_01900000-0000-7000-8000-000000000010";
    const factInput = {
      projectId,
      executionId: executionId as never,
      workspaceId,
      logicalStepNo: 1,
      repairAttempt: 0,
      providerTurnId: "ptn_01900000-0000-7000-8000-000000000010" as never,
      logicalActionId: "lac_p41_restart",
      failureCode: "DecisionRequestWorkspaceMismatch" as const,
      firstDetectedAt: "2026-10-12T01:00:00.000Z",
      causedByCommandId: null,
    };
    try {
      await runP10(
        Effect.gen(function* () {
          yield* runMigrations(P8_MIGRATIONS);
          const sql = yield* SqlClient;
          yield* sql.unsafe(
            `CREATE UNIQUE INDEX p41_test_execution_binding
               ON executions(execution_id, project_id, workspace_id)`,
          );
          yield* seedCanonical(
            Effect.gen(function* () {
              yield* insertProjectRootRow(workspaceId, projectId);
              yield* insertWorkspaceRow(
                {
                  workspaceId,
                  parentWorkspaceId: null,
                  name: "P41 Attention root",
                },
                projectId,
              );
              yield* insertExecutionRow(
                { executionId, workspaceId },
                projectId,
              );
            }),
          );
        }),
        makeP10App(filename),
      );

      const database = new DatabaseSync(filename);
      try {
        const userVersionBefore = Number(
          (
            database.prepare("PRAGMA user_version").get() as {
              user_version: number;
            }
          ).user_version,
        );
        database.exec(P41_SUBMITTED_DECISION_BINDING_ATTENTION_DDL);
        const userVersionAfter = Number(
          (
            database.prepare("PRAGMA user_version").get() as {
              user_version: number;
            }
          ).user_version,
        );
        expect(userVersionAfter).toBe(userVersionBefore);
      } finally {
        database.close();
      }

      const first = await runP10(
        Effect.gen(function* () {
          yield* runMigrations(P8_MIGRATIONS);
          const tx = yield* TransactionPort;
          const facts = yield* RecoveryAttentionFactStore;
          const fact = yield* tx.transact(
            recordSubmittedDecisionBindingFailure(facts, factInput),
          );
          const deps = yield* makeP10Deps();
          const rows = yield* deriveProjectAttention(projectId, {
            ...deps.attention,
            findSubmittedDecisionBindingFailure: (attentionFactId) =>
              tx
                .transact(
                  facts.findSubmittedDecisionBindingFailure?.(
                    attentionFactId,
                  ) ?? Effect.succeed(Option.none()),
                )
                .pipe(Effect.mapError(projectionReadError)),
          });
          return { rows, fact };
        }),
        makeP10App(filename, { includeSubmittedDecisionFactStore: true }),
      );

      let originalEventPayload: string | undefined;
      let originalEventCorrelation: string | null | undefined;
      const corruptEvent = new DatabaseSync(filename);
      try {
        const eventRow = corruptEvent
          .prepare(
            "SELECT payload_json, correlation_ref FROM domain_events WHERE event_id = ?",
          )
          .get(first.fact.eventId) as
          | { payload_json: string; correlation_ref: string | null }
          | undefined;
        if (eventRow === undefined)
          throw new Error("P41 event was not retained");
        const payload = JSON.parse(eventRow.payload_json) as Record<
          string,
          unknown
        >;
        originalEventPayload = eventRow.payload_json;
        originalEventCorrelation = eventRow.correlation_ref;
        payload.attentionFactId = `att_${"f".repeat(64)}`;
        corruptEvent
          .prepare(
            `UPDATE domain_events SET payload_json = ?, correlation_ref = ?
              WHERE event_id = ?`,
          )
          .run(
            JSON.stringify(payload),
            "lac_p41_wrong_correlation",
            first.fact.eventId,
          );
      } finally {
        corruptEvent.close();
      }

      const integrityFailure = await runP10(
        Effect.gen(function* () {
          yield* runMigrations(P8_MIGRATIONS);
          const tx = yield* TransactionPort;
          const facts = yield* RecoveryAttentionFactStore;
          const deps = yield* makeP10Deps();
          return yield* Effect.exit(
            deriveProjectAttention(projectId, {
              ...deps.attention,
              findSubmittedDecisionBindingFailure: (attentionFactId) =>
                tx
                  .transact(
                    facts.findSubmittedDecisionBindingFailure?.(
                      attentionFactId,
                    ) ?? Effect.succeed(Option.none()),
                  )
                  .pipe(Effect.mapError(projectionReadError)),
            }),
          );
        }),
        makeP10App(filename, { includeSubmittedDecisionFactStore: true }),
      );
      expect(Exit.isFailure(integrityFailure)).toBe(true);

      if (originalEventPayload === undefined) {
        throw new Error("original P41 event payload was not captured");
      }
      const restoreEvent = new DatabaseSync(filename);
      try {
        restoreEvent
          .prepare(
            `UPDATE domain_events SET payload_json = ?, correlation_ref = ?
              WHERE event_id = ?`,
          )
          .run(
            originalEventPayload,
            originalEventCorrelation,
            first.fact.eventId,
          );
      } finally {
        restoreEvent.close();
      }

      const rebuiltRows = await runP10(
        Effect.gen(function* () {
          yield* runMigrations(P8_MIGRATIONS);
          const tx = yield* TransactionPort;
          const facts = yield* RecoveryAttentionFactStore;
          const deps = yield* makeP10Deps();
          return yield* deriveProjectAttention(projectId, {
            ...deps.attention,
            findSubmittedDecisionBindingFailure: (attentionFactId) =>
              tx
                .transact(
                  facts.findSubmittedDecisionBindingFailure?.(
                    attentionFactId,
                  ) ?? Effect.succeed(Option.none()),
                )
                .pipe(Effect.mapError(projectionReadError)),
          });
        }),
        makeP10App(filename, { includeSubmittedDecisionFactStore: true }),
      );

      const firstSubmittedRows = first.rows.filter(
        (row) => row.source === "SubmittedDecisionBindingFailure",
      );
      const rebuiltSubmittedRows = rebuiltRows.filter(
        (row) => row.source === "SubmittedDecisionBindingFailure",
      );
      expect(firstSubmittedRows).toHaveLength(1);
      expect(rebuiltSubmittedRows).toHaveLength(1);
      expect(rebuiltSubmittedRows[0]).toMatchObject({
        dedupKey: expect.stringMatching(/^att_[0-9a-f]{64}$/u),
        severity: "ActionRequired",
        targetWorkspaceId: workspaceId,
        occurredAt: factInput.firstDetectedAt,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
