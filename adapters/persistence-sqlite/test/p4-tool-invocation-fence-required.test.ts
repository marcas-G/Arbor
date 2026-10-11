import {
  ExecutionId,
  parse,
  ToolInvocationId,
  WorkspaceId,
} from "@arbor/domain";
import { ToolInvocationStore, TransactionPort } from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  layer,
  P4_MIGRATIONS,
  runMigrations,
  ToolInvocationStoreLive,
  TransactionPortLive,
} from "../src/index.js";

const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const invocationId = parse(ToolInvocationId)(
  "tin_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const incompleteFence = { executionId } as never;

describe("P4 SQLite ToolInvocationStore fence requirement", () => {
  it("rejects every durable write before SQL when the holder tuple is incomplete", async () => {
    const base = layer({ filename: ":memory:" });
    const app = Layer.mergeAll(
      base,
      Layer.provide(TransactionPortLive, base),
      Layer.provide(ToolInvocationStoreLive, base),
    );
    const program = Effect.gen(function* () {
      yield* runMigrations(P4_MIGRATIONS);
      const store = yield* ToolInvocationStore;
      const tx = yield* TransactionPort;
      const capture = (effect: Parameters<typeof tx.transact>[0]) =>
        tx.transact(
          Effect.match(effect as never, {
            onFailure: (error) => ({ _tag: "Rejected" as const, error }),
            onSuccess: (value) => ({ _tag: "Applied" as const, value }),
          }),
        );
      const invocation = {
        invocationId,
        executionId,
        workspaceId,
        toolName: "shell",
        toolVersion: "1",
        sideEffectSemantics: "Idempotent" as const,
        argumentsJson: "{}",
        resolvedRegions: [],
        approvalId: null,
        intentAt: "2026-01-01T00:00:00.000Z",
      };
      const outcomes = yield* Effect.all([
        capture(store.recordIntent(invocation, incompleteFence)),
        capture(
          store.settle(
            invocationId,
            { _tag: "Success" },
            null,
            "2026-01-01T00:00:00.000Z",
            incompleteFence,
          ),
        ),
        capture(
          store.consumeApproval("approval-1", invocationId, incompleteFence),
        ),
        capture(
          store.recordNoEffectDenial(
            invocation,
            "InvocationAuthorityDenied",
            "2026-01-01T00:00:00.000Z",
            incompleteFence,
          ),
        ),
        capture(
          store.recordNoEffectInterruption(
            invocationId,
            "2026-01-01T00:00:00.000Z",
            incompleteFence,
          ),
        ),
        capture(
          store.admitEffect(
            invocationId,
            {
              principal: "worker:test" as never,
              workspaceId,
              executionId,
              toolName: "shell",
              toolVersion: "1",
              resourceSpaceIds: [],
              allowedCapabilities: [],
              controlBasisDigest: "digest",
              expiresAt: "2027-01-01T00:00:00.000Z",
              delegationDepth: 0,
            },
            "2026-01-01T00:00:00.000Z",
            incompleteFence,
          ),
        ),
      ]);
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<{ count: number }>(
        "SELECT COUNT(*) AS count FROM tool_invocations",
      );
      return { outcomes, count: Number(rows[0]?.count ?? 0) };
    });

    const result = await Effect.runPromise(
      Effect.provide(program, app) as Effect.Effect<unknown, unknown, never>,
    );
    const actual = result as {
      readonly outcomes: ReadonlyArray<{
        readonly _tag: string;
        readonly error?: { readonly _tag: string; readonly reason?: string };
      }>;
      readonly count: number;
    };
    expect(actual.outcomes).toHaveLength(6);
    for (const outcome of actual.outcomes) {
      expect(outcome._tag).toBe("Rejected");
      expect(outcome.error?._tag).toBe("PersistenceCorruption");
      expect(outcome.error?.reason).toContain("fence is missing or incomplete");
    }
    expect(actual.count).toBe(0);
  });
});
