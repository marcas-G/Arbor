import { Effect, type Exit } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { runRecovery } from "../../packages/execution-runtime/src/index.js";
import {
  ExecutionRepository,
  LeaseService,
  SessionRepository,
  ToolInvocationStore,
  TransactionPort,
} from "../../packages/ports/src/index.js";
import { labeled } from "../support/harness-api.js";
import {
  acquireLease,
  boot,
  clockNow,
  completed,
  defectOf,
  eventsOf,
  executionId,
  executionState,
  expireInPlace,
  leaseRow,
  principal,
  providerTurnId,
  run,
  sessionId,
  settleViaGateway,
  sqlCount,
  toolInvocationId,
  workerRun,
} from "./support.js";

/**
 * P9-006 — worker crash (W1–W5) injection rows (P9 `02` §1). Crash =
 * worker-level die at the named point (P9-001 harness convention: mechanism
 * empirical, the point and the assertion are contract). Every case is
 * labeled crash-injected (GQ5).
 */

describe("-worker-crash (W1–W5, 02 §1)", () => {
  it("W1 [crash-injected]: kill at dispatch-accepted-before-lease — no lease row, Execution unchanged, re-dispatch converges", async () => {
    expect(labeled("W1-pre-lease", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        const exit = yield* Effect.exit(
          workerRun("worker:a", "W1", providerTurnId, toolInvocationId(1)),
        );
        const lease = yield* leaseRow;
        const exec = yield* executionState;
        const redispatch = yield* acquireLease("worker:redisp");
        const receipt = yield* settleViaGateway(
          redispatch.generation,
          completed,
        );
        const execAfter = yield* executionState;
        return { exit, lease, exec, redispatch, receipt, execAfter };
      }),
    );
    expect(r.exit._tag).toBe("Failure");
    expect(
      (defectOf(r.exit as Exit.Exit<unknown, never>) as Error).message,
    ).toBe("harness-kill:W1");
    expect(r.lease).toBeNull();
    expect(r.exec?.settled_at).toBeNull();
    expect(r.exec?.settlement_kind).toBeNull();
    expect(Number(r.redispatch.generation)).toBe(0);
    expect(
      (r.receipt as { resolution: { _tag: string } }).resolution._tag,
    ).toBe("Committed");
    expect(r.execAfter?.settlement_kind).toBe("Completed");
  });

  it("W2 [crash-injected]: kill after lease acquire before drive — live lease until TTL, no Active→Settled, lazy invalidation enables takeover", async () => {
    expect(labeled("W2-post-lease-pre-drive", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        const exit = yield* Effect.exit(
          workerRun("worker:a", "W2", providerTurnId, toolInvocationId(1)),
        );
        const lease = yield* leaseRow;
        const now = yield* clockNow;
        const exec = yield* executionState;
        yield* expireInPlace("worker:a", 0 as never);
        const sweepNow = yield* clockNow;
        const tx = yield* TransactionPort;
        const leases = yield* LeaseService;
        const invalidated = yield* tx.transact(
          leases.invalidateExpired(sweepNow),
        );
        const takeoverLease = yield* acquireLease("worker:b");
        const execAfter = yield* executionState;
        return {
          exit,
          lease,
          now,
          exec,
          invalidated,
          takeoverLease,
          execAfter,
        };
      }),
    );
    expect(r.exit._tag).toBe("Failure");
    expect(
      (defectOf(r.exit as Exit.Exit<unknown, never>) as Error).message,
    ).toBe("harness-kill:W2");
    expect(r.lease?.worker_id).toBe("worker:a");
    expect(Number(r.lease?.generation)).toBe(0);
    expect(r.lease !== null && r.lease.expires_at > r.now).toBe(true);
    expect(r.exec?.settled_at).toBeNull();
    expect(r.invalidated).toBe(1);
    expect(Number(r.takeoverLease.generation)).toBe(1);
    expect(r.execAfter?.settled_at).toBeNull();
  });

  it("W3 [crash-injected]: kill mid-drive — dangling intents, lazy takeover at generation+1, single authoritative resolution", async () => {
    expect(labeled("W3-mid-drive-takeover", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        const exit = yield* Effect.exit(
          workerRun("worker:a", "W3", providerTurnId, toolInvocationId(1)),
        );
        const danglingTurns = yield* sqlCount(
          "SELECT COUNT(*) AS count FROM provider_turns WHERE execution_id = ? AND settled_at IS NULL",
          [executionId],
        );
        const tx = yield* TransactionPort;
        const tools = yield* ToolInvocationStore;
        const danglingInvocations = (yield* tx.transact(
          tools.findUnsettled(executionId),
        )).length;
        const exec = yield* executionState;
        yield* expireInPlace("worker:a", 0 as never);
        const takeoverLease = yield* acquireLease("worker:b");
        const sessions = yield* SessionRepository;
        const sameLogicalContent = {
          entryKind: "ModelOutput" as const,
          payload: { text: "turn-final" },
        };
        const takeoverAppend = yield* tx.transact(
          sessions.appendEntry(sessionId, sameLogicalContent, {
            executionId,
            fencingGeneration: takeoverLease.generation,
          }),
        );
        const lateAppend = yield* tx
          .transact(
            sessions.appendEntry(sessionId, sameLogicalContent, {
              executionId,
              fencingGeneration: 0 as never,
            }),
          )
          .pipe(Effect.flip);
        const entryCount = yield* sqlCount(
          "SELECT COUNT(*) AS count FROM session_entries WHERE session_id = ?",
          [sessionId],
        );
        const receipt = yield* settleViaGateway(
          takeoverLease.generation,
          completed,
        );
        const execAfter = yield* executionState;
        return {
          exit,
          danglingTurns,
          danglingInvocations,
          exec,
          takeoverLease,
          takeoverAppend,
          lateAppend,
          entryCount,
          receipt,
          execAfter,
        };
      }),
    );
    expect(r.exit._tag).toBe("Failure");
    expect(
      (defectOf(r.exit as Exit.Exit<unknown, never>) as Error).message,
    ).toBe("harness-kill:W3");
    expect(r.danglingTurns).toBe(1);
    expect(r.danglingInvocations).toBe(1);
    expect(r.exec?.settled_at).toBeNull();
    expect(Number(r.takeoverLease.generation)).toBe(1);
    expect(r.takeoverAppend.sequence).toBe(0);
    expect((r.lateAppend as { _tag: string })._tag).toBe(
      "LeaseFencingRejected",
    );
    expect(r.entryCount).toBe(1);
    expect(
      (r.receipt as { resolution: { _tag: string } }).resolution._tag,
    ).toBe("Committed");
    expect(r.execAfter?.settlement_kind).toBe("Completed");
  });

  it("W4 [crash-injected]: kill after settlement proposal, before canonical COMMIT — nothing durable, retry converges, no partial state", async () => {
    expect(labeled("W4-pre-canonical-commit", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        const exit = yield* Effect.exit(
          workerRun("worker:a", "W4", providerTurnId, toolInvocationId(1)),
        );
        const commandsAfterCrash = yield* sqlCount(
          "SELECT COUNT(*) AS count FROM commands",
        );
        const settledEvents = yield* eventsOf("ExecutionSettled");
        const workWaits = yield* sqlCount(
          "SELECT COUNT(*) AS count FROM work_waits",
        );
        const exec = yield* executionState;
        const receipt = yield* settleViaGateway(0 as never, completed);
        const commandsAfterRetry = yield* sqlCount(
          "SELECT COUNT(*) AS count FROM commands",
        );
        const settledEventsAfter = yield* eventsOf("ExecutionSettled");
        const execAfter = yield* executionState;
        return {
          exit,
          commandsAfterCrash,
          settledEvents,
          workWaits,
          exec,
          receipt,
          commandsAfterRetry,
          settledEventsAfter,
          execAfter,
        };
      }),
    );
    expect(r.exit._tag).toBe("Failure");
    expect(
      (defectOf(r.exit as Exit.Exit<unknown, never>) as Error).message,
    ).toBe("harness-kill:W4");
    expect(r.commandsAfterCrash).toBe(0);
    expect(r.settledEvents).toBe(0);
    expect(r.workWaits).toBe(0);
    expect(r.exec?.settled_at).toBeNull();
    expect(
      (r.receipt as { resolution: { _tag: string } }).resolution._tag,
    ).toBe("Committed");
    expect(r.commandsAfterRetry).toBe(1);
    expect(r.settledEventsAfter).toBe(1);
    expect(r.execAfter?.settlement_kind).toBe("Completed");
  });

  it("W5 [crash-injected]: kill after effectful work before SettleExecution — stays Active, unresolved side effects gate recovery settlement", async () => {
    expect(
      labeled("W5-pre-settle-effect-dangling", "crash-injected").guarantee,
    ).toBe("crash-injected");
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        const exit = yield* Effect.exit(
          workerRun("worker:a", "W5", providerTurnId, toolInvocationId(1)),
        );
        const exec = yield* executionState;
        const tx = yield* TransactionPort;
        const repo = yield* ExecutionRepository;
        const sql = yield* SqlClient;
        const now = yield* clockNow;
        yield* tx.transact(repo.requestStop(executionId, now));
        const recovery = yield* runRecovery(principal);
        const execAfter = yield* executionState;
        const escalationRows = yield* sql.unsafe<{
          readonly aggregate_ref: string;
          readonly payload_json: string;
        }>(
          "SELECT aggregate_ref, payload_json FROM domain_events WHERE event_type = 'ReconciliationEscalated'",
        );
        const escalations = escalationRows.map((row) => ({
          aggregateRef: row.aggregate_ref,
          payload: JSON.parse(row.payload_json) as {
            readonly executionId: string;
            readonly invocationRefsFingerprint: string;
            readonly refs: ReadonlyArray<string>;
          },
        }));
        return { exit, exec, recovery, execAfter, escalations };
      }),
    );
    expect(r.exit._tag).toBe("Failure");
    expect(
      (defectOf(r.exit as Exit.Exit<unknown, never>) as Error).message,
    ).toBe("harness-kill:W5");
    expect(r.exec?.settled_at).toBeNull();
    expect(r.recovery.settled).toEqual([]);
    expect(r.recovery.escalated).toEqual([executionId]);
    expect(r.execAfter?.settled_at).toBeNull();
    expect(r.execAfter?.settlement_kind).not.toBe("Interrupted");
    expect(r.escalations).toEqual([
      {
        aggregateRef: executionId,
        payload: {
          executionId,
          invocationRefsFingerprint: String(toolInvocationId(1)),
          refs: [String(toolInvocationId(1))],
        },
      },
    ]);
  });
});
