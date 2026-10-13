import {
  ToolReconciliationFactStore,
  type ToolReconciliationRequest,
  type ToolReconciliationResult,
  TransactionPort,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSchema42TestDatabaseFactory,
  type Schema42TestDatabaseFactory,
  withSchema42TestDatabase,
} from "../../../tests/support/schema42-database.js";
import {
  layer,
  ToolReconciliationFactStoreLive,
  TransactionPortLive,
} from "../src/index.js";

const makeApp = (filename: string) => {
  const sqlite = layer({ filename });
  return Layer.mergeAll(
    sqlite,
    Layer.provide(TransactionPortLive, sqlite),
    Layer.provide(ToolReconciliationFactStoreLive, sqlite),
  );
};

const runDb = <A>(
  filename: string,
  program: Effect.Effect<
    A,
    unknown,
    SqlClient | ToolReconciliationFactStore | TransactionPort
  >,
) =>
  Effect.runPromise(Effect.scoped(Effect.provide(program, makeApp(filename))));

let schema42Factory: Schema42TestDatabaseFactory | undefined;

beforeAll(async () => {
  schema42Factory = await createSchema42TestDatabaseFactory({
    prefix: ".p39-tool-reconciliation-template-",
  });
}, 120_000);

afterAll(() => schema42Factory?.cleanup());

const requireSchema42Factory = () => {
  if (schema42Factory === undefined) {
    throw new Error("Schema-42 test database factory was not prepared.");
  }
  return schema42Factory;
};

describe("P39 ToolReconciliationFactStore", () => {
  it("stores exact bound proof facts idempotently and never invents Success", async () => {
    await withSchema42TestDatabase(
      requireSchema42Factory(),
      async (database) => {
        const result = await runDb(
          database.databaseFilename,
          Effect.gen(function* () {
            const sql = yield* SqlClient;
            yield* sql.unsafe("PRAGMA foreign_keys = OFF");
            const invocationId = "tin_p39_fact_store";
            const bindingSha256 = "a".repeat(64);
            const profileHash = "b".repeat(64);
            const visibilityScopeSha256 = "c".repeat(64);
            const evidenceSha256 = "d".repeat(64);
            yield* sql.unsafe(
              `INSERT INTO tool_invocations (
            invocation_id, execution_id, workspace_id, tool_name, tool_version,
            side_effect_semantics, arguments_json, resolved_regions_json,
            approval_id, effect_admission_state, recovery_binding_state,
            recovery_binding_sha256, settlement_provenance, selected_attempt_no,
            selected_fact_id, intent_at, settled_at, settlement_kind,
            settlement_json, result_ref
          ) VALUES (?,?,?,?,?,?,?,?,?,'MayHaveStarted','Bound',?,NULL,NULL,NULL,
                    't0',NULL,NULL,NULL,NULL)`,
              [
                invocationId,
                "exe_fake",
                "ws_fake",
                "shell",
                "3",
                "Reconcilable",
                "{}",
                "[]",
                null,
                bindingSha256,
              ],
            );
            yield* sql.unsafe(
              `INSERT INTO tool_invocation_recovery_bindings
            (invocation_id,binding_version,canonical_binding_json,binding_sha256,created_at)
           VALUES (?,1,?,?,?)`,
              [invocationId, '{"bindingVersion":1}', bindingSha256, "t0"],
            );
            yield* sql.unsafe(
              `INSERT INTO tool_invocation_effect_attempts (
            invocation_id,attempt_no,admission_state,tool_definition_hash,
            side_effect_semantics,profile_id,profile_version,profile_hash,
            profile_protocol,effect_key,binding_sha256,admitted_at,
            admission_source,admission_time_precision
          ) VALUES (?,0,'MayHaveStarted',?,'Reconcilable','profile','1',?,'v1',?,?,'t1',
                    'P39Admission','TransactionTimestamp')`,
              [
                invocationId,
                "e".repeat(64),
                profileHash,
                "effect-1",
                bindingSha256,
              ],
            );
            yield* sql.unsafe(
              `INSERT INTO artifacts (artifact_id,kind,blob_ref,byte_size,content_hash,
                                  invocation_id,execution_id,created_at)
           VALUES ('art_p39_proof','Proof','blob:proof',10,?,NULL,NULL,'t1')`,
              [evidenceSha256],
            );
            yield* sql.unsafe("PRAGMA foreign_keys = ON");

            const request: ToolReconciliationRequest = {
              invocationId: invocationId as never,
              attemptNo: 0,
              bindingSha256,
              profileHash,
              effectKey: "effect-1",
              visibilityScopeSha256,
            };
            const reconciliation: ToolReconciliationResult = {
              _tag: "NotOccurred",
              proof: {
                invocationId: request.invocationId,
                attemptNo: 0,
                bindingSha256,
                profileHash,
                effectKey: "effect-1",
                sourceRevision: "rev-17",
                sourceWatermark: "wm-44",
                observedAt: "t2",
                visibilityScopeSha256,
                evidenceRef: "art_p39_proof",
                evidenceSha256,
                finality: {
                  _tag: "ExternallyFenced",
                  confirmationRef: "fence-44",
                  confirmedAt: "t2",
                },
              },
            };
            const store = yield* ToolReconciliationFactStore;
            const tx = yield* TransactionPort;
            const first = yield* tx.transact(
              store.record(request, reconciliation, "t2"),
            );
            const duplicate = yield* tx.transact(
              store.record(request, reconciliation, "t3"),
            );
            const facts = yield* sql.unsafe<{
              readonly fact_id: string;
              readonly outcome: string;
              readonly fact_disposition: string;
              readonly result_ref: string | null;
            }>(
              `SELECT fact_id,outcome,fact_disposition,result_ref
             FROM tool_reconciliation_facts WHERE invocation_id = ?`,
              [invocationId],
            );
            return { first, duplicate, facts };
          }),
        );

        expect(result.first.factId).toBe(result.duplicate.factId);
        expect(result.facts).toEqual([
          {
            fact_id: result.first.factId,
            outcome: "NotOccurred",
            fact_disposition: "RecoveryInput",
            result_ref: null,
          },
        ]);
      },
    );
  }, 30_000);
});
