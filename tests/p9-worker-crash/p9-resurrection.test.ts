import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ProviderTurnStore,
  SessionRepository,
  ToolInvocationStore,
  TransactionPort,
} from "../../packages/ports/src/index.js";
import { labeled } from "../support/p9-harness-api.js";
import {
  acquireLease,
  boot,
  completed,
  eventsOf,
  executionId,
  executionState,
  expireInPlace,
  nextCommandId,
  openProviderTurn,
  providerTurnId,
  recordToolIntent,
  run,
  selectCurrentWorkViaGateway,
  sessionId,
  settleViaGateway,
  sqlCount,
  takeover,
  toolExecutionFence,
  toolInvocationId,
  withLeaseFence,
  workId,
  workOpen,
  workspaceId,
} from "./support.js";

/**
 * P9-006 — old-worker resurrection (R1–R6) injection rows (P9 `02` §2).
 * Stale-generation writes across the fencing surface after a takeover.
 * Every case is labeled crash-injected (GQ5).
 */

describe("p9-resurrection (R1–R6, 02 §2)", () => {
  it("R1 [crash-injected]: stale-generation Execution mutation (settle) — FencingRejected, zero durable Execution change", async () => {
    expect(labeled("R1-execution-mutation", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        const generations = yield* takeover;
        const receipt = yield* settleViaGateway(generations.old, completed);
        const exec = yield* executionState;
        const settledEvents = yield* eventsOf("ExecutionSettled");
        const work = yield* workOpen;
        return { generations, receipt, exec, settledEvents, work };
      }),
    );
    expect(Number(r.generations.current)).toBe(1);
    const resolution = (
      r.receipt as { resolution: { _tag: string; error?: { _tag: string } } }
    ).resolution;
    expect(resolution._tag).toBe("TerminalRejected");
    expect(resolution.error?._tag).toBe("FencingRejected");
    expect(r.exec?.settled_at).toBeNull();
    expect(r.settledEvents).toBe(0);
    expect(r.work).toBe(1);
  });

  it("R2 [crash-injected]: stale-generation Session append — LeaseFencingRejected, no entry visible", async () => {
    expect(labeled("R2-session-append", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        const generations = yield* takeover;
        const tx = yield* TransactionPort;
        const sessions = yield* SessionRepository;
        const late = yield* tx
          .transact(
            sessions.appendEntry(
              sessionId,
              { entryKind: "ModelOutput", payload: { text: "stale" } },
              { executionId, fencingGeneration: generations.old },
            ),
          )
          .pipe(Effect.flip);
        const entryCount = yield* sqlCount(
          "SELECT COUNT(*) AS count FROM session_entries WHERE session_id = ?",
          [sessionId],
        );
        const work = yield* workOpen;
        return { generations, late, entryCount, work };
      }),
    );
    expect((r.late as { _tag: string })._tag).toBe("LeaseFencingRejected");
    expect((r.late as { generation: number }).generation).toBe(
      Number(r.generations.old),
    );
    expect(r.entryCount).toBe(0);
    expect(r.work).toBe(1);
  });

  it("R3 [crash-injected]: stale-generation ProviderTurn settlement — LeaseFencingRejected, turn remains unsettled", async () => {
    expect(
      labeled("R3-provider-turn-settlement", "crash-injected").guarantee,
    ).toBe("crash-injected");
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        const first = yield* acquireLease("worker:a");
        yield* openProviderTurn(providerTurnId);
        yield* expireInPlace("worker:a", first.generation);
        const next = yield* acquireLease("worker:b");
        const tx = yield* TransactionPort;
        const turns = yield* ProviderTurnStore;
        const late = yield* tx
          .transact(
            withLeaseFence(
              first.generation,
              turns.settleTurn(providerTurnId, "Stop", "{}", "t"),
            ),
          )
          .pipe(Effect.flip);
        const unsettledTurns = yield* sqlCount(
          "SELECT COUNT(*) AS count FROM provider_turns WHERE provider_turn_id = ? AND settled_at IS NULL",
          [providerTurnId],
        );
        const work = yield* workOpen;
        return { first, next, late, unsettledTurns, work };
      }),
    );
    expect(Number(r.first.generation)).toBe(0);
    expect(Number(r.next.generation)).toBe(1);
    expect((r.late as { _tag: string })._tag).toBe("LeaseFencingRejected");
    expect(r.unsettledTurns).toBe(1);
    expect(r.work).toBe(1);
  });

  it("R4 [crash-injected]: stale-generation ToolInvocation settlement — LeaseFencingRejected, invocation remains unsettled", async () => {
    expect(
      labeled("R4-tool-invocation-settlement", "crash-injected").guarantee,
    ).toBe("crash-injected");
    const invocationId = toolInvocationId(1);
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        const first = yield* acquireLease("worker:a");
        yield* recordToolIntent(
          invocationId,
          toolExecutionFence("worker:a", first.generation),
        );
        yield* expireInPlace("worker:a", first.generation);
        const next = yield* acquireLease("worker:b");
        const tx = yield* TransactionPort;
        const tools = yield* ToolInvocationStore;
        const late = yield* tx
          .transact(
            withLeaseFence(
              first.generation,
              tools.settle(
                invocationId,
                { _tag: "Success" },
                null,
                "t",
                toolExecutionFence("worker:a", first.generation),
                "t",
              ),
            ),
          )
          .pipe(Effect.flip);
        const unsettled = yield* sqlCount(
          "SELECT COUNT(*) AS count FROM tool_invocations WHERE invocation_id = ? AND settled_at IS NULL",
          [invocationId],
        );
        const work = yield* workOpen;
        return { first, next, late, unsettled, work };
      }),
    );
    expect(Number(r.next.generation)).toBe(1);
    expect((r.late as { _tag: string })._tag).toBe("LeaseFencingRejected");
    expect(r.unsettled).toBe(1);
    expect(r.work).toBe(1);
  });

  it("R5 [crash-injected]: stale-generation canonical command (SelectCurrentWork) — terminal FencingRejected, no ordinary retry, Work lifecycle unchanged", async () => {
    expect(labeled("R5-canonical-command", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        const generations = yield* takeover;
        const staleCommandId = nextCommandId();
        const stale = yield* selectCurrentWorkViaGateway(
          staleCommandId,
          generations.old,
        );
        const retry = yield* selectCurrentWorkViaGateway(
          staleCommandId,
          generations.old,
        );
        const live = yield* selectCurrentWorkViaGateway(
          nextCommandId(),
          generations.current,
        );
        const work = yield* workOpen;
        const currentWorkChanged = yield* eventsOf("CurrentWorkChanged");
        const currentWorkId = yield* Effect.gen(function* () {
          const sql = yield* SqlClient;
          const rows = yield* sql.unsafe<{ current_work_id: string | null }>(
            "SELECT current_work_id FROM workspaces WHERE workspace_id = ?",
            [workspaceId],
          );
          return rows[0]?.current_work_id ?? null;
        });
        return {
          generations,
          stale,
          retry,
          live,
          work,
          currentWorkChanged,
          currentWorkId,
        };
      }),
    );
    const staleResolution = (
      r.stale as { resolution: { _tag: string; error?: { _tag: string } } }
    ).resolution;
    expect(staleResolution._tag).toBe("TerminalRejected");
    expect(staleResolution.error?._tag).toBe("FencingRejected");
    const retryResolution = (
      r.retry as { resolution: { _tag: string; error?: { _tag: string } } }
    ).resolution;
    expect(retryResolution._tag).toBe("TerminalRejected");
    expect(retryResolution.error?._tag).toBe("FencingRejected");
    expect((r.live as { resolution: { _tag: string } }).resolution._tag).toBe(
      "Committed",
    );
    expect(r.work).toBe(1);
    expect(r.currentWorkChanged).toBe(1);
    expect(r.currentWorkId).toBe(workId);
  });

  it("R6 [crash-injected]: resurrected worker's uncommitted local writes are invisible — nothing crossed a commit boundary", async () => {
    expect(labeled("R6-uncommitted-writes", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    const invocationId = toolInvocationId(9);
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        const generations = yield* takeover;
        const tx = yield* TransactionPort;
        const exit = yield* Effect.exit(
          tx.transact(
            Effect.gen(function* () {
              const sessions = yield* SessionRepository;
              yield* sessions.appendEntry(sessionId, {
                entryKind: "Observation",
                payload: { late: true },
              });
              yield* recordToolIntent(
                invocationId,
                toolExecutionFence("worker:b", generations.current),
              );
              yield* Effect.die(new Error("harness-kill:R6-pre-commit"));
            }),
          ),
        );
        const entryCount = yield* sqlCount(
          "SELECT COUNT(*) AS count FROM session_entries WHERE session_id = ?",
          [sessionId],
        );
        const invocationCount = yield* sqlCount(
          "SELECT COUNT(*) AS count FROM tool_invocations WHERE invocation_id = ?",
          [invocationId],
        );
        const exec = yield* executionState;
        const work = yield* workOpen;
        return { generations, exit, entryCount, invocationCount, exec, work };
      }),
    );
    expect(r.exit._tag).toBe("Failure");
    expect(Number(r.generations.current)).toBe(1);
    expect(r.entryCount).toBe(0);
    expect(r.invocationCount).toBe(0);
    expect(r.exec?.settled_at).toBeNull();
    expect(r.work).toBe(1);
  });
});
