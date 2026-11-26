import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { Cause, Effect, Exit, type Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterAll, afterEach } from "vitest";
import type {
  ToolInvocationId,
  VerificationMission,
} from "../../packages/domain/dist/index.js";
import {
  Clock,
  type ToolExecutionContext,
  ToolInvocationStore,
  TransactionPort,
} from "../../packages/ports/src/index.js";
import { p7Project } from "../support/p7-app.js";

/** P9-013 — the seven deterministic acceptance stories (P9 `06` §A–§G)
 * + the mechanical assertion checklist. Every story reuses the
 * construction patterns of the owning p9-* task suite but its assertions
 * stand alone; injections are real process/transaction/fiber level
 * (GQ5), deterministic, each story on its own durable DB file. */

const ROOT_WS = "ws_018f2b3c-4d5e-7abc-8def-0123456789c1";

export const P9_DURABLE_TEMP_PREFIX = "arbor-p9-accept-";
export const runOwnedDurableRoots = new Set<string>();
const cleanupFailures: unknown[] = [];
export const expectedThrowCleanupRoots = new Set<string>();

export const isSafeP9TempRootPath = (
  realRoot: string,
  canonicalTempRoot: string,
) => {
  const relativeRoot = relative(canonicalTempRoot, realRoot);
  const rootName = basename(realRoot);
  return (
    relativeRoot !== "" &&
    relativeRoot !== ".." &&
    !relativeRoot.startsWith(`..${sep}`) &&
    !isAbsolute(relativeRoot) &&
    rootName.startsWith(P9_DURABLE_TEMP_PREFIX) &&
    rootName.length > P9_DURABLE_TEMP_PREFIX.length
  );
};

export const validateRunOwnedDurableRoot = (path: string) => {
  if (!runOwnedDurableRoots.has(path)) {
    throw new Error(`refusing to remove an unregistered P9 temp root: ${path}`);
  }
  const realRoot = realpathSync(path);
  if (realRoot !== path) {
    throw new Error(`refusing to remove a redirected P9 temp root: ${path}`);
  }
  const realTempRoot = realpathSync(tmpdir());
  if (!isSafeP9TempRootPath(realRoot, realTempRoot)) {
    const relativeRoot = relative(realTempRoot, realRoot);
    if (
      relativeRoot === "" ||
      relativeRoot === ".." ||
      relativeRoot.startsWith(`..${sep}`) ||
      isAbsolute(relativeRoot)
    ) {
      throw new Error(
        `refusing to remove a P9 temp root outside system Temp: ${path}`,
      );
    }
    throw new Error(
      `refusing to remove a P9 temp root with an unexpected name: ${path}`,
    );
  }
  return realRoot;
};

export const cleanupRunOwnedDurableRoots = () => {
  const failures: unknown[] = [];
  for (const registeredRoot of [...runOwnedDurableRoots]) {
    try {
      const realRoot = validateRunOwnedDurableRoot(registeredRoot);
      rmSync(realRoot, { recursive: true, force: false });
      if (existsSync(realRoot))
        throw new Error(`P9 temp root still exists after cleanup: ${realRoot}`);
      runOwnedDurableRoots.delete(registeredRoot);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "Failed to clean P9-owned SQLite temp roots",
    );
  }
};

afterEach(() => {
  try {
    cleanupRunOwnedDurableRoots();
  } catch (error) {
    cleanupFailures.push(error);
    throw error;
  }
  for (const root of expectedThrowCleanupRoots) {
    if (existsSync(root)) {
      const error = new Error(
        `P9 temp root leaked after a throwing test: ${root}`,
      );
      cleanupFailures.push(error);
      throw error;
    }
  }
  expectedThrowCleanupRoots.clear();
});

afterAll(() => {
  try {
    cleanupRunOwnedDurableRoots();
  } catch (error) {
    cleanupFailures.push(error);
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      cleanupFailures,
      "P9 durable temp-root cleanup failed during the test file",
    );
  }
  if (expectedThrowCleanupRoots.size > 0)
    throw new Error("P9 throw-cleanup assertions were not completed");
});

export const durableFile = (label: string): string => {
  const createdRoot = mkdtempSync(
    join(tmpdir(), `${P9_DURABLE_TEMP_PREFIX}${label}-`),
  );
  const realRoot = realpathSync(createdRoot);
  runOwnedDurableRoots.add(realRoot);
  validateRunOwnedDurableRoot(realRoot);
  return join(realRoot, `${label}.db`);
};

export const defectOf = <A, E>(exit: Exit.Exit<A, E>): unknown =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : null;

export const runOn = <A>(
  // biome-ignore lint/suspicious/noExplicitAny: test helper erases framework types
  program: Effect.Effect<A, any, any>,
  // biome-ignore lint/suspicious/noExplicitAny: test helper erases framework types
  app: Layer.Layer<any, any, any>,
): Promise<A> =>
  Effect.runPromise(
    // biome-ignore lint/suspicious/noExplicitAny: test helper erases framework types
    Effect.scoped(Effect.provide(program, app) as Effect.Effect<A, any, never>),
  );

export const sqlCount = (text: string, params: ReadonlyArray<unknown> = []) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ count: number }>(text, params);
    return Number(rows[0]?.count ?? 0);
  });

export const executionRowOf = (executionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{
      settlement_kind: string | null;
      settlement_json: string | null;
      settled_at: string | null;
      stop_requested_at: string | null;
    }>(
      "SELECT settlement_kind, settlement_json, settled_at, stop_requested_at FROM executions WHERE execution_id = ?",
      [executionId],
    );
    return rows[0] ?? null;
  });

export const countEventsFor = (executionId: string, eventType: string) =>
  sqlCount(
    "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = ? AND aggregate_ref = ?",
    [eventType, executionId],
  );

export const attentionFacts = (executionId: string) =>
  countEventsFor(executionId, "ReconciliationEscalated");

/** P9-002 raw fixture face: stopped/active execution bound to the seeded
 * root workspace (p9-recovery-visibility precedent). */
export const INSERT_EXECUTION = (
  executionId: string,
  stopRequested: string | null,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const sesId = `ses_${executionId.slice(4)}`;
    yield* sql.unsafe(
      "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,NULL,?,0,'t')",
      [sesId, "ExecutionScoped", executionId],
    );
    yield* sql.unsafe(
      "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?, 'execution_bound', ?, 'm', ?, 't', ?, NULL, NULL, NULL)",
      [executionId, p7Project, ROOT_WS, sesId, stopRequested],
    );
  });

export const INSERT_INVOCATION = (
  invocationId: string,
  executionId: string,
  semantics: string,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "INSERT INTO tool_invocations (invocation_id, execution_id, workspace_id, tool_name, tool_version, side_effect_semantics, arguments_json, resolved_regions_json, intent_at) VALUES (?,?,?,?,?,?,?,?,'t')",
      [invocationId, executionId, ROOT_WS, "shell", "1", semantics, "{}", "[]"],
    );
  });

export const invocationRowOf = (invocationId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{
      settled_at: string | null;
      settlement_kind: string | null;
      side_effect_semantics: string;
    }>(
      "SELECT settled_at, settlement_kind, side_effect_semantics FROM tool_invocations WHERE invocation_id = ?",
      [invocationId],
    );
    return rows[0] ?? null;
  });

export const settleInvocation = (
  invocationId: string,
  executionFence: NonNullable<ToolExecutionContext["executionFence"]>,
) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const tools = yield* ToolInvocationStore;
    const clock = yield* Clock;
    const now = yield* clock.now();
    yield* tx.transact(
      tools.settle(
        invocationId as never as ToolInvocationId,
        {
          _tag: "Success",
        },
        null,
        now,
        executionFence,
        now,
      ),
    );
  });

// Shared cross-story constants (mechanically moved from the former
// single-file acceptance suite: G_MISSION sat in the Story B wiring
// block; the EXE_* execution ids sat in the Story C wiring block).

export const G_MISSION: VerificationMission = {
  goal: "verify the completed outcome",
  criteria: [{ criterionId: "c1", requirement: "tests pass", required: true }],
  riskRequirements: [],
};

export const EXE_SA_DIRTY = "exe_00000000-0000-7000-8000-00000000a101";
export const EXE_SA_CLEAN = "exe_00000000-0000-7000-8000-00000000a102";
export const EXE_SB_CLEAN = "exe_00000000-0000-7000-8000-00000000b201";
export const EXE_SB_FACT = "exe_00000000-0000-7000-8000-00000000b202";
export const EXE_SB_PENDING = "exe_00000000-0000-7000-8000-00000000b203";
export const EXE_SG_DF1 = "exe_00000000-0000-7000-8000-00000000c001";
