import {
  type AssignWorkBindingFailureCode,
  type DeliverReplayFailureCode,
  RecoveryAttentionFactStore,
  TransactionPort,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  executionId,
  projectId,
  query,
  runDb,
  seed,
  workspaceId,
} from "./support.js";

describe("P2 WorkReadmissionGateStore", () => {
  it("recognizes every closed DeliverReplay and AssignWork binding failure code", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed();
        const sql = yield* SqlClient;
        const tx = yield* TransactionPort;
        const facts = yield* RecoveryAttentionFactStore;
        const committedCommandId = "cmd_readmission_inventory";
        yield* tx.transact(
          sql.unsafe(
            `INSERT INTO commands (
              command_id, project_id, semantic_request_fingerprint,
              schema_version, fingerprint_algorithm_version, resolution,
              result_json, terminal_error_json, created_at, settled_at
            ) VALUES (?, ?, 'fingerprint', '1', 1, 'Committed', '{}', NULL, 't0', 't0')`,
            [committedCommandId, projectId],
          ),
        );
        const deliverCodes = [
          "LegacyMessageMissingEvent",
          "LegacyEventMissingMessage",
          "LegacyMessageBindingMismatch",
          "LegacyInboxConflict",
          "PriorReceiptDecodeMismatch",
          "PriorReceiptResultMismatch",
          "RejectedReceiptEffectConflict",
          "PriorReceiptEffectConflict",
        ] as const satisfies ReadonlyArray<DeliverReplayFailureCode>;
        const assignCodes = [
          "LegacyUnbound",
          "MissingBinding",
          "DuplicateBinding",
          "MalformedBinding",
          "RefMismatch",
          "AuthorityMismatch",
          "ForeignTarget",
          "PlacementMismatch",
          "SourceActionMismatch",
          "ReceiptMismatch",
          "WorkMismatch",
          "ProvenanceMismatch",
          "EventMismatch",
          "CommitLifecycleMismatch",
        ] as const satisfies ReadonlyArray<AssignWorkBindingFailureCode>;
        yield* tx.transact(
          Effect.gen(function* () {
            for (const [index, failureCode] of deliverCodes.entries()) {
              yield* facts.recordDeliverReplayFailure({
                projectId: projectId as never,
                executionId: executionId as never,
                targetWorkspaceId: workspaceId as never,
                logicalActionId: `act_deliver_inventory_${index}`,
                messageId: `msg_deliver_inventory_${index}`,
                failureCode,
                firstDetectedAt: `t${index + 1}`,
              });
            }
            for (const [index, failureCode] of assignCodes.entries()) {
              yield* facts.recordAssignWorkBindingFailure({
                projectId: projectId as never,
                executionId: executionId as never,
                targetWorkspaceId: workspaceId as never,
                logicalActionId: `act_assign_inventory_${index}`,
                committedCommandId: committedCommandId as never,
                failureCode,
                firstDetectedAt: `t${index + 20}`,
              });
            }
          }),
        );
        expect(Option.isSome(yield* query())).toBe(true);
      }),
    ));
});
