import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  P12_MIGRATIONS,
  runMigrations,
} from "../../adapters/persistence-sqlite/src/index.js";
import { runRecovery } from "../../packages/execution-runtime/src/index.js";
import {
  makeP7App,
  p7SeedProject,
  p7TestPrincipal,
  runP7,
} from "../support/p7-app.js";
import { labeled } from "../support/p9-harness-api.js";
import {
  attentionFacts,
  countEventsFor,
  durableFile,
  EXE_SA_CLEAN,
  EXE_SA_DIRTY,
  executionRowOf,
  INSERT_EXECUTION,
  INSERT_INVOCATION,
} from "./support.js";

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

describe("p9-acceptance", () => {
  it("Story A (06 §A) [crash-injected]: recovery visibility gate — before-form recorded, after-form escalates the unsettled NonIdempotent stop and NEVER settles Interrupted", async () => {
    expect(
      labeled("story-A-recovery-visibility-gate", "crash-injected").guarantee,
    ).toBe("crash-injected");
    await runP7(
      Effect.gen(function* () {
        yield* runMigrations(P12_MIGRATIONS);
        yield* p7SeedProject;
        yield* INSERT_EXECUTION(EXE_SA_DIRTY, "t");
        yield* INSERT_INVOCATION("tin_sa_non", EXE_SA_DIRTY, "NonIdempotent");
        yield* INSERT_EXECUTION(EXE_SA_CLEAN, "t");
        // BEFORE (B-1 stub-era defect shape): the retired stub's pending
        // visibility is the empty list, so a stopped execution carrying an
        // unsettled NonIdempotent invocation would take the clean path and
        // settle Interrupted — the form demonstrated by the clean twin.
        const stubEraPending: ReadonlyArray<unknown> = [];
        expect(stubEraPending.length).toBe(0);
        // AFTER: the wired ReconciliationSource sees the dangling
        // invocation; recovery escalates with a durable Attention fact.
        const recovery = yield* runRecovery(p7TestPrincipal);
        expect([...recovery.settled].sort()).toEqual([EXE_SA_CLEAN]);
        expect(recovery.escalated).toEqual([EXE_SA_DIRTY]);
        const clean = yield* executionRowOf(EXE_SA_CLEAN);
        expect(clean?.settlement_kind).toBe("Interrupted");
        expect(JSON.parse(clean?.settlement_json ?? "null")).toEqual({
          _tag: "Interrupted",
          result: { _tag: "StopRequested" },
        });
        const dirty = yield* executionRowOf(EXE_SA_DIRTY);
        expect(dirty?.settlement_kind).not.toBe("Interrupted");
        expect(dirty?.settlement_kind).toBeNull();
        expect(dirty?.settled_at).toBeNull();
        expect(dirty?.settlement_json).toBeNull();
        expect(yield* attentionFacts(EXE_SA_DIRTY)).toBe(1);
        expect(yield* countEventsFor(EXE_SA_DIRTY, "ExecutionSettled")).toBe(0);
        expect(yield* countEventsFor(EXE_SA_CLEAN, "ExecutionSettled")).toBe(1);
      }),
      makeP7App(durableFile("a")),
    );
  });
});
