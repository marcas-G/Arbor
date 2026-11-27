import { RecoveryAttentionFactStore, TransactionPort } from "@arbor/ports";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { sandboxProviderUnavailableFactIdV1 } from "../../src/index.js";
import {
  executionId,
  projectId,
  query,
  runDb,
  seed,
  seedTerminalProviderFailureChain,
  terminalSettlement,
  workId,
  workspaceId,
} from "./support.js";

describe("WorkReadmissionGateStore", () => {
  it("holds the exact Work revision after a persisted sandbox-provider-unavailable fact", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed();
        const sql = yield* SqlClient;
        const factId = sandboxProviderUnavailableFactIdV1(executionId, 1);
        // This test isolates the readmission gate from P50's write path. The
        // fact decoder and the gate's scope/episode checks are the subject
        // under test; the FK witness is covered by the P50 store tests.
        yield* sql.unsafe("PRAGMA foreign_keys = OFF");
        yield* sql.unsafe(
          `INSERT INTO sandbox_provider_unavailable_facts (
             attention_fact_id, event_id, project_id, execution_id,
             workspace_id, episode_binding_json, policy_revision,
             policy_digest, profile_id, provider_id, provider_version,
             probe_evidence_ref, failure_code, first_detected_at
           ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'ReadOnly', 'bwrap', '0.8.0',
                     NULL, 'ProviderUnavailable', '2026-10-19T10:00:00.000Z')`,
          [
            factId,
            "evt_readmission_sandbox_unavailable",
            projectId,
            executionId,
            workspaceId,
            JSON.stringify({
              _tag: "WorkEpisode",
              workId,
              targetWorkRevision: 0,
            }),
            "a".repeat(64),
          ],
        );
        yield* sql.unsafe("PRAGMA foreign_keys = ON");

        expect(yield* query()).toEqual(
          Option.some({
            sourceKind: "SandboxProviderUnavailableFact",
            executionId,
          }),
        );

        yield* sql.unsafe(
          "UPDATE works SET revision = 1, updated_at = 't2' WHERE work_id = ?",
          [workId],
        );
        expect(Option.isNone(yield* query(1))).toBe(true);
      }),
    ));

  it("maps SQLite query failures to the shared semantic persistence error", () =>
    runDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql.unsafe("DROP TABLE works");
        const exit = yield* Effect.exit(query());
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          const encoded = JSON.stringify(exit.cause);
          expect(encoded).toContain('"_tag":"PersistenceUnavailable"');
          expect(encoded).toContain('"repository":"WorkReadmissionGateStore"');
          expect(encoded).not.toContain("ReadmissionGateStoreFailure");
        }
      }),
    ));

  it("reads a durable RuntimeSafetyStop hold for the exact Work revision and releases only after revision advance", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed({
          _tag: "Interrupted",
          result: {
            _tag: "ControlledInterruption",
            reason: "RuntimeSafetyStop",
          },
        });
        const held = yield* query();
        expect(Option.isSome(held) && held.value).toEqual({
          sourceKind: "RuntimeSafetyStopSettlement",
          executionId,
        });

        const sql = yield* SqlClient;
        const tx = yield* TransactionPort;
        yield* tx.transact(
          sql.unsafe("UPDATE works SET revision = 1 WHERE work_id = ?", [
            workId,
          ]),
        );
        const afterSteer = yield* query(1);
        expect(Option.isNone(afterSteer)).toBe(true);
      }),
    ));

  it("derives a hold from the fact and its exact event witness without waiting for settlement", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed();
        const tx = yield* TransactionPort;
        const facts = yield* RecoveryAttentionFactStore;
        const fact = yield* tx.transact(
          facts.recordDeliverReplayFailure({
            projectId: projectId as never,
            executionId: executionId as never,
            targetWorkspaceId: workspaceId as never,
            logicalActionId: "act_readmission_deliver",
            messageId: "msg_readmission_deliver",
            failureCode: "LegacyMessageMissingEvent",
            firstDetectedAt: "t1",
          }),
        );
        const result = yield* query();
        expect(Option.isSome(result) && result.value).toEqual({
          sourceKind: "DeliverReplayFact",
          executionId,
        });
        const sql = yield* SqlClient;
        yield* tx.transact(
          sql.unsafe("DELETE FROM domain_events WHERE event_id = ?", [
            fact.eventId,
          ]),
        );
        const retainedFact = yield* query();
        expect(Option.isSome(retainedFact) && retainedFact.value).toEqual({
          sourceKind: "DeliverReplayFact",
          executionId,
        });
        yield* tx.transact(
          sql.unsafe(
            "DELETE FROM agent_execution_state WHERE execution_id = ?",
            [executionId],
          ),
        );
        const missingEpisode = yield* Effect.exit(query());
        expect(missingEpisode._tag).toBe("Failure");
        if (missingEpisode._tag === "Failure") {
          expect(JSON.stringify(missingEpisode.cause)).toContain(
            '"reasonCode":"SourceEpisodeStateMissing"',
          );
        }
      }),
    ));

  it("fails closed when a retained DeliverReplayFact has a present conflicting event witness", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed();
        const tx = yield* TransactionPort;
        const facts = yield* RecoveryAttentionFactStore;
        const fact = yield* tx.transact(
          facts.recordDeliverReplayFailure({
            projectId: projectId as never,
            executionId: executionId as never,
            targetWorkspaceId: workspaceId as never,
            logicalActionId: "act_readmission_deliver_mismatch",
            messageId: "msg_readmission_deliver_mismatch",
            failureCode: "LegacyMessageMissingEvent",
            firstDetectedAt: "t1",
          }),
        );
        const sql = yield* SqlClient;
        yield* tx.transact(
          sql.unsafe(
            "UPDATE domain_events SET payload_json = '{}' WHERE event_id = ?",
            [fact.eventId],
          ),
        );
        const exit = yield* Effect.exit(query());
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(JSON.stringify(exit.cause)).toContain(
            '"reasonCode":"SourceFactEventMismatch"',
          );
        }
      }),
    ));

  it("fails closed on malformed durable episode binding with bounded integrity details", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed({
          _tag: "Interrupted",
          result: {
            _tag: "ControlledInterruption",
            reason: "RuntimeSafetyStop",
          },
        });
        const sql = yield* SqlClient;
        const tx = yield* TransactionPort;
        yield* tx.transact(
          sql.unsafe(
            "UPDATE agent_execution_state SET episode_json = ? WHERE execution_id = ?",
            ["not-json", executionId],
          ),
        );
        const exit = yield* Effect.exit(query());
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          const encoded = JSON.stringify(exit.cause);
          expect(encoded).toContain('"_tag":"ReadmissionGateIntegrityFailure"');
          expect(encoded).toContain(`"executionId":"${executionId}"`);
          expect(encoded).toContain('"reasonCode":"EpisodeMalformed"');
          expect(encoded).not.toContain("not-json");
        }
      }),
    ));

  it("holds exact Work on the canonical OutcomeUnknown reconciliation settlement", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed({
          _tag: "OutcomeUnknown",
          reconciliation: {
            _tag: "ReconciliationRequired",
            invocationRefs: ["invocation-ref"],
          },
        });
        const held = yield* query();
        expect(Option.isSome(held) && held.value).toEqual({
          sourceKind: "OutcomeUnknownSettlement",
          executionId,
        });
      }),
    ));

  it.each([
    null,
    { _tag: "UnexpectedInterruption" },
    { _tag: "ControlledInterruption", reason: 42 },
  ])("fails closed for malformed Interrupted settlement result %j", (result) =>
    runDb(
      Effect.gen(function* () {
        yield* seed({ _tag: "Interrupted", result });
        const exit = yield* Effect.exit(query());
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(JSON.stringify(exit.cause)).toContain(
            '"reasonCode":"SettlementMalformed"',
          );
        }
      }),
    ),
  );

  it("blocks same-revision admission when ProcessLost recovery has no durable provider failure kind", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed(terminalSettlement("UnknownProviderFailure"));
        yield* seedTerminalProviderFailureChain("UnknownProviderFailure", {
          providerErrorKind: null,
        });
        const exit = yield* Effect.exit(query());
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(JSON.stringify(exit.cause)).toContain(
            '"reasonCode":"SourceProviderAttemptMismatch"',
          );
        }
      }),
    ));

  it("keeps StopRequested settlement outside the gate even without Episode state", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed({ _tag: "Interrupted", result: { _tag: "StopRequested" } });
        const sql = yield* SqlClient;
        const tx = yield* TransactionPort;
        yield* tx.transact(
          sql.unsafe(
            "DELETE FROM agent_execution_state WHERE execution_id = ?",
            [executionId],
          ),
        );
        expect(Option.isNone(yield* query())).toBe(true);
      }),
    ));

  it("fails closed when StopRequested settlement has no stop request fact", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed(
          { _tag: "Interrupted", result: { _tag: "StopRequested" } },
          null,
        );
        const exit = yield* Effect.exit(query());
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(JSON.stringify(exit.cause)).toContain(
            '"reasonCode":"SettlementMalformed"',
          );
        }
      }),
    ));

  it("fails closed when a RuntimeSafetyStop source has no Episode state", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed({
          _tag: "Interrupted",
          result: {
            _tag: "ControlledInterruption",
            reason: "RuntimeSafetyStop",
          },
        });
        const sql = yield* SqlClient;
        const tx = yield* TransactionPort;
        yield* tx.transact(
          sql.unsafe(
            "DELETE FROM agent_execution_state WHERE execution_id = ?",
            [executionId],
          ),
        );
        const exit = yield* Effect.exit(query());
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(JSON.stringify(exit.cause)).toContain(
            '"reasonCode":"SourceEpisodeStateMissing"',
          );
        }
      }),
    ));
});
