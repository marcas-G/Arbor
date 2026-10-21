import {
  AttentionProjectionStore,
  TransactionPort,
  VerificationSignalReconciliationStore,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { createSchema50TestDatabase } from "../../../tests/support/schema44-database.js";
import {
  AttentionProjectionStoreLive,
  layer,
  P51_VERIFICATION_V2_CONSUMER_RECONCILIATION_MIGRATION,
  runMigrations,
  TransactionPortLive,
  VerificationSignalReconciliationStoreLive,
} from "../src/index.js";

describe("VerificationSignalReconciliationStoreLive", () => {
  it("generation-fences phase advancement and projects the retained Attention queue atomically", async () => {
    const fixture = await createSchema50TestDatabase();
    const base = layer({ filename: fixture.databaseFilename });
    const app = Layer.mergeAll(
      base,
      Layer.provide(TransactionPortLive, base),
      Layer.provide(VerificationSignalReconciliationStoreLive, base),
      Layer.provide(AttentionProjectionStoreLive, base),
    );
    try {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.gen(function* () {
              yield* runMigrations(
                [P51_VERIFICATION_V2_CONSUMER_RECONCILIATION_MIGRATION],
                { allowOfflineOnly: true },
              );
              const sql = yield* SqlClient;
              yield* sql.withTransaction(
                Effect.gen(function* () {
                  yield* sql.unsafe(
                    `INSERT INTO projects (project_id,name,root_workspace_id,
                    project_policy,project_policy_revision,default_configuration,
                    environment_ref,lifecycle,revision,created_at,updated_at)
                   VALUES ('prj_f18_store','F18','ws_f18_store','{}',0,'{}',
                    'local','Open',0,'2026-10-21T00:00:00.000Z','2026-10-21T00:00:00.000Z')`,
                  );
                  yield* sql.unsafe(
                    `INSERT INTO sessions (session_id,binding_kind,workspace_id,
                    execution_id,context_epoch,created_at)
                   VALUES ('ses_f18_store','WorkspacePrimary','ws_f18_store',NULL,0,
                    '2026-10-21T00:00:00.000Z')`,
                  );
                  yield* sql.unsafe(
                    `INSERT INTO workspaces (workspace_id,project_id,parent_workspace_id,
                    name,responsibility_definition,responsibility_revision,
                    resource_boundary,resource_boundary_revision,agent_binding,
                    primary_session_id,current_work_id,workspace_policy,
                    workspace_policy_revision,revision,lifecycle,created_at,updated_at)
                   VALUES ('ws_f18_store','prj_f18_store',NULL,'F18','{}',0,'{}',0,
                    '{}','ses_f18_store',NULL,'{}',0,0,'Active',
                    '2026-10-21T00:00:00.000Z','2026-10-21T00:00:00.000Z')`,
                  );
                }),
              );
              const tx = yield* TransactionPort;
              const store = yield* VerificationSignalReconciliationStore;
              const attentionProjection = yield* AttentionProjectionStore;
              const identity = {
                consumerId: "workflow-signals" as const,
                projectId: "prj_f18_store" as never,
                eventSequence: 17,
              };
              const source = {
                identity,
                eventId: "evt_f18_store" as never,
                sourceCommandId: "cmd_f18_store",
                verificationId: "ver_f18_store",
                workId: "wrk_f18_store",
                workRevision: 0,
                verdict: "Pass" as const,
                ownerWorkspaceId: "ws_f18_store" as never,
                parentWorkspaceId: null,
                sourceDigest: "a".repeat(64),
                effectPlanDigest: "b".repeat(64),
              };
              const first = yield* tx.transact(
                store.insertPending(
                  source,
                  "daemon-a",
                  "2026-10-21T00:00:30.000Z",
                  "2026-10-21T00:00:00.000Z",
                ),
              );
              const takenOver = yield* tx.transact(
                store.claimBatch({
                  projectId: identity.projectId,
                  leaseOwner: "daemon-b",
                  now: "2026-10-21T00:00:31.000Z",
                  leaseTtlMs: 30_000,
                  limit: 10,
                }),
              );
              const staleAdvance = yield* tx.transact(
                store.advance({
                  identity,
                  expectedPhase: "Pending",
                  nextPhase: "VerificationWakeDelivered",
                  leaseOwner: "daemon-a",
                  leaseGeneration: first.leaseGeneration,
                  now: "2026-10-21T00:00:32.000Z",
                }),
              );
              yield* tx.transact(
                store.recordAttention({
                  identity: { ...identity, eventSequence: 18 },
                  eventId: null,
                  failureCode: "EventEnvelopeMalformed",
                  evidenceDigest: "c".repeat(64),
                  targetWorkspaceId: "ws_f18_store" as never,
                  firstDetectedAt: "2026-10-21T00:00:33.000Z",
                  sourceIdentity: "workflow-signals:prj_f18_store:18",
                  attentionFactId: "d".repeat(64),
                }),
              );
              const queue = yield* tx.transact(
                store.claimAttentionQueue({
                  projectId: identity.projectId,
                  leaseOwner: "p10-a",
                  now: "2026-10-21T00:00:34.000Z",
                  leaseTtlMs: 30_000,
                  limit: 8,
                }),
              );
              const claim = queue[0];
              if (claim === undefined)
                throw new Error("Attention queue claim missing");
              const projected = yield* tx.transact(
                store.projectAttentionClaim(claim, "2026-10-21T00:00:35.000Z"),
              );
              const rows = yield* tx.transact(
                attentionProjection.listVerificationSignalReconciliationFailures?.(
                  identity.projectId,
                ) ?? Effect.succeed([]),
              );
              yield* tx.transact(
                attentionProjection.resetProject(identity.projectId),
              );
              const rebuiltRows = yield* tx.transact(
                attentionProjection.listVerificationSignalReconciliationFailures?.(
                  identity.projectId,
                ) ?? Effect.succeed([]),
              );
              return { takenOver, staleAdvance, projected, rows, rebuiltRows };
            }),
            app,
          ),
        ),
      );
      expect(result.takenOver).toHaveLength(1);
      expect(result.takenOver[0]?.leaseOwner).toBe("daemon-b");
      expect(result.takenOver[0]?.leaseGeneration).toBe(2);
      expect(result.staleAdvance).toBe(false);
      expect(result.projected).toBe(true);
      expect(result.rows).toEqual([
        expect.objectContaining({
          source: "F18VerificationSignalReconciliation",
          severity: "ActionRequired",
          targetWorkspaceId: "ws_f18_store",
          dedupKey: "f18-verification-v2-reconciliation:prj_f18_store:18",
          failureCode: "EventEnvelopeMalformed",
          sourceEventId: null,
        }),
      ]);
      expect(result.rebuiltRows).toEqual(result.rows);
    } finally {
      fixture.cleanup();
    }
  });
});
