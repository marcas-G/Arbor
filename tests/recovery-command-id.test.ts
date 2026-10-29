import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  P8_MIGRATIONS,
  runMigrations,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  CommandGateway,
  newUuid7,
  semanticRequestFingerprint,
  type VerifiedRuntimeCommandAuthority,
} from "../packages/application/src/index.js";
import {
  CommandId,
  EventId,
  ExecutionId,
  Principal,
  parse,
} from "../packages/domain/dist/index.js";
import { runRecovery } from "../packages/execution-runtime/src/index.js";
import {
  makeP7App,
  p7Project,
  p7RootWorkspace,
  p7SeedCommandId,
  p7SeedProject,
  runP7,
} from "./support/p7-app.js";

const principal = parse(Principal)("user:gov");
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789d1",
);
const uuid = executionId.slice("exe_".length);

const insertExecution = (stopRequestedAt: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,NULL,?,0,'t')",
      [`ses_${uuid}`, "ExecutionScoped", executionId],
    );
    yield* sql.unsafe(
      "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?, 'execution_bound', ?, 'm', ?, 't', ?, NULL, NULL, NULL)",
      [executionId, p7Project, p7RootWorkspace, `ses_${uuid}`, stopRequestedAt],
    );
  });

const insertCompletionFact = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.unsafe(
    "INSERT INTO project_event_sequences (project_id, last_sequence) VALUES (?, 1) ON CONFLICT(project_id) DO UPDATE SET last_sequence = last_sequence + 1",
    [p7Project],
  );
  const rows = yield* sql.unsafe<{ last_sequence: number }>(
    "SELECT last_sequence FROM project_event_sequences WHERE project_id = ?",
    [p7Project],
  );
  const sequence = Number(rows[0]?.last_sequence);
  const settlement = {
    _tag: "Completed",
    result: {
      _tag: "CompletionClaimed",
      workRevision: 3,
      claimRef: "claim_recovery_command_id",
    },
  };
  yield* sql.unsafe(
    "INSERT INTO domain_events (event_id, project_id, sequence, event_type, event_version, occurred_at, aggregate_ref, actor, payload_json) VALUES (?,?,?,?,?,?,?,?,?)",
    [
      parse(EventId)(`evt_${uuid}`),
      p7Project,
      sequence,
      "ExecutionSettled",
      1,
      "t",
      executionId,
      "user:gov",
      JSON.stringify({ executionId, settlement }),
    ],
  );
  return settlement;
});

const commandRecord = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{
    command_id: string;
    semantic_request_fingerprint: string;
    resolution: string;
    result_json: string | null;
    terminal_error_json: string | null;
    created_at: string;
    settled_at: string;
  }>(
    "SELECT command_id, semantic_request_fingerprint, resolution, result_json, terminal_error_json, created_at, settled_at FROM commands WHERE project_id = ? AND command_id <> ? ORDER BY rowid DESC LIMIT 1",
    [p7Project, p7SeedCommandId],
  );
  return rows[0] ?? null;
});

const exerciseRecoveryBranch = (branch: "completion" | "stop") =>
  runP7(
    Effect.gen(function* () {
      yield* runMigrations(P8_MIGRATIONS);
      yield* p7SeedProject;
      const completion =
        branch === "completion" ? yield* insertCompletionFact : null;
      yield* insertExecution(branch === "stop" ? "t" : null);

      const first = yield* runRecovery(principal);
      const firstRecord = yield* commandRecord;
      expect(first.settled).toEqual([executionId]);
      expect(firstRecord).not.toBeNull();
      const commandId = parse(CommandId)(firstRecord?.command_id);
      const fingerprint = firstRecord?.semantic_request_fingerprint;
      const expectedCommandId = parse(CommandId)(
        `cmd_${newUuid7("recovery", `${executionId}:${branch}`)}`,
      );
      expect(commandId).toBe(expectedCommandId);
      expect(newUuid7("recovery", `${executionId}:${branch}`)).toBe(
        newUuid7("recovery", `${executionId}:${branch}`),
      );
      expect(commandId).toMatch(
        /^cmd_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);

      const payload = {
        executionId,
        settlement: completion ?? {
          _tag: "Interrupted" as const,
          result: { _tag: "StopRequested" as const },
        },
      };
      const authority: VerifiedRuntimeCommandAuthority = {
        _tag: "SettleExecutionAuthority",
        submissionOrigin: "RecoveryController",
        principal,
        commandId,
        semanticRequestFingerprint: semanticRequestFingerprint({
          commandType: "SettleExecution",
          projectId: p7Project,
          actor: principal as never,
          schemaVersion: "1",
          payload,
        }),
        projectId: p7Project,
        commandKind: "SettleExecution",
        executionId,
      };
      const gateway = yield* CommandGateway;
      const eventsBeforeReplay = yield* sqlEventCount;
      const replay = yield* gateway.execute(
        {
          commandType: "SettleExecution",
          commandId,
          projectId: p7Project,
          actor: principal as never,
          issuedAt: "replay",
          payload,
        },
        { _tag: "RecoveryController", principal, causationRef: "recovery" },
        authority,
      );
      expect(replay.resolution._tag).toBe("Committed");
      const receiptAfterReplay = yield* commandRecord;
      expect(receiptAfterReplay).toEqual(firstRecord);
      expect(yield* sqlEventCount).toBe(eventsBeforeReplay);

      const second = yield* runRecovery(principal);
      const secondRecord = yield* commandRecord;
      expect(second.settled).toEqual([]);
      expect(secondRecord).toEqual(firstRecord);
      if (completion !== null) {
        const events = yield* sqlEventCount;
        expect(events).toBe(2);
      }
      return { commandId, fingerprint };
    }),
    makeP7App(),
  );

const sqlEventCount = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{ count: number }>(
    "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'ExecutionSettled' AND aggregate_ref = ?",
    [executionId],
  );
  return Number(rows[0]?.count);
});

describe("P2 recovery command identity", () => {
  it("derives stable, valid UUIDv7 CommandIds for both deterministic recovery branches", async () => {
    const completion = await exerciseRecoveryBranch("completion");
    const stop = await exerciseRecoveryBranch("stop");

    expect(completion.commandId).not.toBe(stop.commandId);
    expect(completion.fingerprint).not.toBe(stop.fingerprint);
  });
});
