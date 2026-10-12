import { parse, ToolInvocationId } from "@arbor/domain";
import { P39RecoveryEvidenceStore, TransactionScope } from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  layer,
  P36_MIGRATIONS,
  P39_RECONCILIATION_MIGRATION,
  P39RecoveryEvidenceStoreLive,
  runMigrations,
} from "../src/index.js";

const invocationId = parse(ToolInvocationId)(
  "tin_018f2b3c-4d5e-7abc-8def-0123456789b1",
);

const sqlite = layer({ filename: ":memory:" });
const app = Layer.mergeAll(
  sqlite,
  Layer.provide(P39RecoveryEvidenceStoreLive, sqlite),
);

describe("P39 RecoveryBinding store DeniedUnbound projection", () => {
  it("returns the terminal P4 denial projection but never binding or selected evidence", async () => {
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* runMigrations([
            ...P36_MIGRATIONS,
            P39_RECONCILIATION_MIGRATION,
          ]);
          const sql = yield* SqlClient;
          yield* sql.unsafe("PRAGMA foreign_keys = OFF");
          yield* sql.unsafe(
            `INSERT INTO tool_invocations (
               invocation_id, execution_id, workspace_id, tool_name, tool_version,
               side_effect_semantics, arguments_json, resolved_regions_json,
               approval_id, effect_admission_state, recovery_binding_state,
               recovery_binding_sha256, settlement_provenance,
               selected_attempt_no, selected_fact_id, intent_at, settled_at,
               settlement_kind, settlement_json, result_ref
             ) VALUES (?, 'exe_test', 'ws_test', 'read', '1', 'ReadOnly',
                       '{}', '[]', NULL, 'NotAdmitted', 'DeniedUnbound',
                       NULL, 'Ordinary', NULL, NULL, 't1', 't2', 'Denied',
                       '{"_tag":"Denied","reasonCode":"ResourceAdmissionDenied","projectionVersion":1}',
                       NULL)`,
            [invocationId],
          );
          const store = yield* P39RecoveryEvidenceStore;
          const withScope = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Effect.provideService(effect, TransactionScope, {
              session: { id: "p39-denied-query" },
            } as never);
          const denied = yield* withScope(
            store.findTerminalUnboundDenial(invocationId),
          );
          const binding = yield* withScope(store.findBinding(invocationId));
          const selected = yield* withScope(store.findSelected(invocationId));
          return { denied, binding, selected };
        }),
        app,
      ),
    );
    expect(result.denied).toEqual(
      Option.some({
        invocationId,
        recoveryBindingState: "DeniedUnbound",
      }),
    );
    expect(result.binding).toEqual(Option.none());
    expect(result.selected).toEqual(Option.none());
  });
});
