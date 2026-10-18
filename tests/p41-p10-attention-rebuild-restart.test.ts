import { DatabaseSync } from "node:sqlite";
import { Effect, Exit, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  CURRENT_SCHEMA_VERSION,
  makeProjectAttentionProjectionStore,
} from "../adapters/persistence-sqlite/src/index.js";
import type { ProjectId, WorkspaceId } from "../packages/domain/dist/index.js";
import { recordSubmittedDecisionBindingFailure } from "../packages/execution-runtime/src/submitted-decision-binding-failure.js";
import {
  AttentionProjectionStore,
  DomainEventJournal,
  RecoveryAttentionFactStore,
  TransactionPort,
} from "../packages/ports/src/index.js";
import {
  deriveProjectAttention,
  projectionReadError,
} from "../packages/projection-runtime/src/index.js";
import {
  insertProjectRootRow,
  insertSessionRow,
  insertWorkspaceRow,
  makeP10App,
  makeP10Deps,
  runP10,
  seedCanonical,
} from "./support/p10-fixture.js";
import { createSchema48TestDatabase } from "./support/schema44-database.js";

describe("P41 P10 Attention rebuild after SQLite reopen", () => {
  it("rebuilds one row from the retained event and production P9 fact store", async () => {
    const fixture = await createSchema48TestDatabase();
    const filename = fixture.databaseFilename;
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
          const sql = yield* SqlClient;
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
              const sessionId = `ses:${executionId}`;
              yield* insertSessionRow(sessionId, null, executionId);
              yield* sql.unsafe(
                `INSERT INTO executions (
                   execution_id, project_id, binding_kind, workspace_id,
                   episode_kind, episode_ref, episode_revision,
                   parent_execution_id, mission, session_id, admitted_at,
                   stop_requested_at, settlement_kind, settlement_json,
                   settled_at
                 ) VALUES (?, ?, 'workspace', ?, 'DecisionEpisode', ?, 0,
                           NULL, NULL, ?, 't0', NULL, NULL, NULL, NULL)`,
                [
                  executionId,
                  projectId,
                  workspaceId,
                  "dec_01900000-0000-7000-8000-000000000010",
                  sessionId,
                ],
              );
            }),
          );
        }),
        makeP10App(filename),
      );

      const database = new DatabaseSync(filename, { readOnly: true });
      try {
        const userVersion = Number(
          (
            database.prepare("PRAGMA user_version").get() as {
              user_version: number;
            }
          ).user_version,
        );
        const tables = database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('submitted_decision_binding_attention_facts', 'legacy_adoption_attention_facts', 'legacy_adoption_attention_rows') ORDER BY name",
          )
          .all() as Array<{ readonly name: string }>;
        expect(userVersion).toBe(CURRENT_SCHEMA_VERSION);
        expect(tables.map((table) => table.name)).toEqual([
          "legacy_adoption_attention_facts",
          "legacy_adoption_attention_rows",
          "submitted_decision_binding_attention_facts",
        ]);
      } finally {
        database.close();
      }

      const first = await runP10(
        Effect.gen(function* () {
          const tx = yield* TransactionPort;
          const facts = yield* RecoveryAttentionFactStore;
          const attentionRows = yield* AttentionProjectionStore;
          const journal = yield* DomainEventJournal;
          const fact = yield* tx.transact(
            recordSubmittedDecisionBindingFailure(facts, factInput),
          );
          const projection = makeProjectAttentionProjectionStore(
            projectId,
            facts,
            attentionRows,
          );
          const events = yield* tx.transact(
            journal.readAfter(projectId, 0, 100),
          );
          yield* tx.transact(projection.apply(events));
          const sourceEvent = events.find(
            (event) =>
              event.eventType === "SubmittedDecisionBindingEscalated" &&
              event.eventId === fact.eventId,
          );
          if (sourceEvent === undefined)
            throw new Error("P41 event was not appended");
          const eventPayload = sourceEvent.payload as Record<string, unknown>;
          const wrongWorkspaceEvent = {
            ...sourceEvent,
            payload: {
              ...eventPayload,
              workspaceId: "ws_01900000-0000-7000-8000-000000000099",
            },
          } as never;
          const wrongWorkspaceFailure = yield* tx.transact(
            Effect.exit(projection.apply([wrongWorkspaceEvent])),
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
            listProjectedSubmittedDecisionBindingFailures: (targetProjectId) =>
              tx
                .transact(
                  attentionRows.listSubmittedDecisionBindingFailures?.(
                    targetProjectId,
                  ) ?? Effect.succeed([]),
                )
                .pipe(Effect.mapError(projectionReadError)),
          });
          return { rows, fact, wrongWorkspaceFailure };
        }),
        makeP10App(filename, {
          includeSubmittedDecisionFactStore: true,
          includeSubmittedDecisionMarkerStore: true,
        }),
      );

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
        payload.workspaceId = "ws_01900000-0000-7000-8000-000000000099";
        corruptEvent
          .prepare(
            `UPDATE domain_events SET payload_json = ?, correlation_ref = ?
              WHERE event_id = ?`,
          )
          .run(
            JSON.stringify(payload),
            eventRow.correlation_ref,
            first.fact.eventId,
          );
      } finally {
        corruptEvent.close();
      }

      const integrityFailure = await runP10(
        Effect.gen(function* () {
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
        makeP10App(filename, {
          includeSubmittedDecisionFactStore: true,
          includeSubmittedDecisionMarkerStore: true,
        }),
      );
      expect(Exit.isFailure(integrityFailure)).toBe(true);

      const missingFactEvent = new DatabaseSync(filename);
      try {
        const eventRow = missingFactEvent
          .prepare("SELECT payload_json FROM domain_events WHERE event_id = ?")
          .get(first.fact.eventId) as { payload_json: string } | undefined;
        if (eventRow === undefined)
          throw new Error("P41 event was pruned early");
        const payload = JSON.parse(eventRow.payload_json) as Record<
          string,
          unknown
        >;
        payload.attentionFactId = `att_${"f".repeat(64)}`;
        missingFactEvent
          .prepare(
            "UPDATE domain_events SET payload_json = ? WHERE event_id = ?",
          )
          .run(JSON.stringify(payload), first.fact.eventId);
      } finally {
        missingFactEvent.close();
      }
      const missingFactFailure = await runP10(
        Effect.gen(function* () {
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
        makeP10App(filename, {
          includeSubmittedDecisionFactStore: true,
          includeSubmittedDecisionMarkerStore: true,
        }),
      );
      expect(Exit.isFailure(missingFactFailure)).toBe(true);

      const pruneEvent = new DatabaseSync(filename);
      try {
        pruneEvent
          .prepare("DELETE FROM domain_events WHERE event_id = ?")
          .run(first.fact.eventId);
      } finally {
        pruneEvent.close();
      }

      const rebuiltRows = await runP10(
        Effect.gen(function* () {
          const tx = yield* TransactionPort;
          const facts = yield* RecoveryAttentionFactStore;
          const attentionRows = yield* AttentionProjectionStore;
          const projection = makeProjectAttentionProjectionStore(
            projectId,
            facts,
            attentionRows,
          );
          yield* tx.transact(projection.reset());
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
            listProjectedSubmittedDecisionBindingFailures: (targetProjectId) =>
              tx
                .transact(
                  attentionRows.listSubmittedDecisionBindingFailures?.(
                    targetProjectId,
                  ) ?? Effect.succeed([]),
                )
                .pipe(Effect.mapError(projectionReadError)),
          });
        }),
        makeP10App(filename, {
          includeSubmittedDecisionFactStore: true,
          includeSubmittedDecisionMarkerStore: true,
        }),
      );

      const firstSubmittedRows = first.rows.filter(
        (row) => row.source === "SubmittedDecisionBindingFailure",
      );
      const rebuiltSubmittedRows = rebuiltRows.filter(
        (row) => row.source === "SubmittedDecisionBindingFailure",
      );
      expect(firstSubmittedRows).toHaveLength(1);
      expect(Exit.isFailure(first.wrongWorkspaceFailure)).toBe(true);
      expect(rebuiltSubmittedRows).toHaveLength(1);
      expect(rebuiltSubmittedRows[0]).toMatchObject({
        dedupKey: expect.stringMatching(/^att_[0-9a-f]{64}$/u),
        severity: "ActionRequired",
        targetWorkspaceId: workspaceId,
        occurredAt: factInput.firstDetectedAt,
      });
    } finally {
      fixture.cleanup();
    }
  });
});
