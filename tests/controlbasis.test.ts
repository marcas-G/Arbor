import { readFileSync } from "node:fs";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
// P12 `05` §5.1 (TR-1): advancement only via the internal capability —
// deliberately not re-exported from the persistence adapter index, so the
// harness cannot own this edge; the test binds it on top of `harness.app`.
import {
  EnvironmentRevisionAdvancement,
  EnvironmentRevisionAdvancementLive,
} from "../adapters/persistence-sqlite/src/environment-advancement.js";
import {
  P16_MIGRATIONS,
  runMigrations,
} from "../adapters/persistence-sqlite/src/index.js";
import { WorkspaceKnowledgePortLive } from "../apps/single-workspace/src/workspace-knowledge.js";
import { WorkspacePlacementPortLive } from "../apps/single-workspace/src/workspace-placement.js";
import { checkFreshness } from "../packages/agent-runtime/src/index.js";
import type { ControlBasis } from "../packages/model-context/src/index.js";
import {
  EnvironmentRevisionStore,
  ExecutionDriverPort,
  TransactionPort,
} from "../packages/ports/src/index.js";
import { makeModelDecisionHarness } from "../packages/testkit/src/index.js";
import {
  allowGate,
  contextOf,
  executionOf,
  projectId,
  seed,
  sendHandler,
  sendMessageTurn,
  stateOf,
} from "./support/model-decision-fixtures.js";

const makeApp = () =>
  makeModelDecisionHarness({
    turns: [sendMessageTurn("first"), sendMessageTurn("second")],
    controlHandlers: [sendHandler],
    workspaceKnowledge: WorkspaceKnowledgePortLive,
    workspacePlacement: WorkspacePlacementPortLive,
  });

const drive = (index: 0 | 1) =>
  Effect.gen(function* () {
    const driver = yield* ExecutionDriverPort;
    return yield* driver.drive({
      execution: executionOf(index),
      agentExecutionState: stateOf(index),
      wakeReason: { _tag: "WorkSelected" },
      context: contextOf(index),
      safetyGate: allowGate,
    });
  });

const run = <A>(
  // biome-ignore lint/suspicious/noExplicitAny: test helper erases framework types
  program: Effect.Effect<A, any, any>,
  // biome-ignore lint/suspicious/noExplicitAny: test helper erases framework types
  app: Layer.Layer<any, any, any>,
): Promise<A> =>
  Effect.runPromise(
    // biome-ignore lint/suspicious/noExplicitAny: test helper erases framework types
    Effect.scoped(Effect.provide(program, app) as Effect.Effect<A, any, never>),
  );

describe("GQ4b ControlBasis environmentRevision service-internal read", () => {
  it("binds the preset anchor revision '7' into ControlBasis", async () => {
    const { app, recorded } = makeApp();
    const settlement = await run(
      Effect.gen(function* () {
        yield* runMigrations(P16_MIGRATIONS);
        yield* seed;
        const store = yield* EnvironmentRevisionStore;
        const tx = yield* TransactionPort;
        yield* tx.transact(store.record(projectId, "7"));
        return yield* drive(0);
      }),
      app,
    );
    expect(settlement._tag).toBe("Completed");
    expect(recorded[0]?.environmentRevision).toBe("7");
  });

  it("observes '0' when no anchor exists yet (anchor-uninitialized semantics)", async () => {
    const { app, recorded } = makeApp();
    const settlement = await run(
      Effect.gen(function* () {
        yield* runMigrations(P16_MIGRATIONS);
        yield* seed;
        return yield* drive(0);
      }),
      app,
    );
    expect(settlement._tag).toBe("Completed");
    expect(recorded[0]?.environmentRevision).toBe("0");
  });

  it("carries the advanced revision on the next turn and trips the existing weak freshness gate", async () => {
    const { app, recorded } = makeApp();
    const settlement = await run(
      Effect.gen(function* () {
        yield* runMigrations(P16_MIGRATIONS);
        yield* seed;
        const store = yield* EnvironmentRevisionStore;
        const advancement = yield* EnvironmentRevisionAdvancement;
        const tx = yield* TransactionPort;
        yield* tx.transact(store.record(projectId, "7"));
        const first = yield* drive(0);
        const advanced = yield* tx.transact(
          advancement.advanceAnchor(projectId, "7"),
        );
        expect(advanced).toEqual({ _tag: "Advanced", to: "8" });
        const second = yield* drive(1);
        return [first, second];
      }),
      Layer.provideMerge(EnvironmentRevisionAdvancementLive, app),
    );
    expect(settlement.map((s) => s._tag)).toEqual(["Completed", "Completed"]);
    expect(recorded[0]?.environmentRevision).toBe("7");
    expect(recorded[1]?.environmentRevision).toBe("8");
    const stale = checkFreshness(
      recorded[0] as ControlBasis,
      recorded[1] as ControlBasis,
      "Weak",
    );
    expect(stale?._tag).toBe("DecisionStale");
    expect(stale?.changed).toContain("environmentRevision");
  });

  it("hardcode removal: agent-loop-driver.ts contains no '\"env\"' literal", () => {
    const source = readFileSync(
      "packages/agent-runtime/src/agent-loop-driver.ts",
      "utf8",
    );
    expect(source.includes('"env"')).toBe(false);
  });
});
