import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  P8_MIGRATIONS,
  runMigrations,
} from "../adapters/persistence-sqlite/src/index.js";
import type { ProjectId, WorkspaceId } from "../packages/domain/dist/index.js";
import { deriveProjectAttention } from "../packages/projection-runtime/src/attention-loader.js";
import {
  DomainEventJournal,
  TransactionPort,
} from "../packages/ports/src/index.js";
import { makeP10App, makeP10Deps, runP10 } from "./support/p10-fixture.js";

describe("P41 P10 Attention rebuild after SQLite reopen", () => {
  it("rebuilds one row from the retained event and exact fact after process restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "arbor-p41-p10-rebuild-"));
    const filename = join(directory, "attention.sqlite");
    const projectId = "prj_01900000-0000-7000-8000-000000000010" as ProjectId;
    const workspaceId =
      "ws_01900000-0000-7000-8000-000000000010" as WorkspaceId;
    let fact:
      | {
          readonly attentionFactId: string;
          readonly eventId: string;
          readonly projectId: ProjectId;
          readonly executionId: string;
          readonly workspaceId: WorkspaceId;
          readonly logicalStepNo: number;
          readonly repairAttempt: number;
          readonly providerTurnId: string;
          readonly logicalActionId: string;
          readonly failureCode: "DecisionRequestWorkspaceMismatch";
          readonly firstDetectedAt: string;
        }
      | undefined;
    try {
      const firstRows = await runP10(
        Effect.gen(function* () {
          yield* runMigrations(P8_MIGRATIONS);
          const tx = yield* TransactionPort;
          const journal = yield* DomainEventJournal;
          const eventId = (yield* tx.transact(
            journal.appendReturningIds([
              {
                projectId,
                eventType: "SubmittedDecisionBindingEscalated",
                eventVersion: 1,
                occurredAt: "2026-10-12T01:00:00.000Z",
                aggregateRef: workspaceId,
                actor: "system:recovery" as never,
                correlationRef: "lac_p41_restart",
                payload: {
                  attentionFactId: `att_${"a".repeat(64)}`,
                  executionId: "exe_01900000-0000-7000-8000-000000000010",
                  workspaceId,
                  logicalStepNo: 1,
                  repairAttempt: 0,
                  providerTurnId: "ptn_01900000-0000-7000-8000-000000000010",
                  logicalActionId: "lac_p41_restart",
                  failureCode: "DecisionRequestWorkspaceMismatch",
                },
              },
            ]),
          ))[0];
          if (eventId === undefined)
            throw new Error("journal omitted event id");
          fact = {
            attentionFactId: `att_${"a".repeat(64)}`,
            eventId,
            projectId,
            executionId: "exe_01900000-0000-7000-8000-000000000010",
            workspaceId,
            logicalStepNo: 1,
            repairAttempt: 0,
            providerTurnId: "ptn_01900000-0000-7000-8000-000000000010",
            logicalActionId: "lac_p41_restart",
            failureCode: "DecisionRequestWorkspaceMismatch",
            firstDetectedAt: "2026-10-12T01:00:00.000Z",
          };
          const deps = yield* makeP10Deps();
          return yield* deriveProjectAttention(projectId, {
            ...deps.attention,
            findSubmittedDecisionBindingFailure: (attentionFactId) =>
              Effect.succeed(
                attentionFactId === fact?.attentionFactId
                  ? Option.some(fact as never)
                  : Option.none(),
              ),
          });
        }),
        makeP10App(filename),
      );

      const rebuiltRows = await runP10(
        Effect.gen(function* () {
          yield* runMigrations(P8_MIGRATIONS);
          const deps = yield* makeP10Deps();
          return yield* deriveProjectAttention(projectId, {
            ...deps.attention,
            findSubmittedDecisionBindingFailure: (attentionFactId) =>
              Effect.succeed(
                attentionFactId === fact?.attentionFactId
                  ? Option.some(fact as never)
                  : Option.none(),
              ),
          });
        }),
        makeP10App(filename),
      );
      const submittedRows = rebuiltRows.filter(
        (row) =>
          row.source === "SubmittedDecisionBindingFailure" &&
          row.dedupKey === fact?.attentionFactId,
      );
      expect(
        firstRows.filter(
          (row) => row.source === "SubmittedDecisionBindingFailure",
        ),
      ).toHaveLength(1);
      expect(submittedRows).toHaveLength(1);
      expect(submittedRows[0]).toMatchObject({
        severity: "ActionRequired",
        targetWorkspaceId: workspaceId,
        occurredAt: "2026-10-12T01:00:00.000Z",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
