import type { ToolInvocationId } from "@arbor/domain";
import {
  type InvocationApproval,
  SandboxPort,
  ToolInvocationStore,
  ToolRuntimePort,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  actionDigestOf,
  type ToolExecutor,
  ToolRuntimeLive,
} from "../src/index.js";
import {
  approvalContext,
  approvalId,
  approvalIntent,
  approvalInvocationId,
  approvalPipelineDeps,
} from "./approval-support.js";

const intent = approvalIntent();
const context = approvalContext;
const invocationId = approvalInvocationId;

describe("exact approval reentry before the tool effect", () => {
  it("reuses the consumed approval and recorded intent after a pre-effect interruption", async () => {
    let approval: InvocationApproval = {
      approvalId,
      toolName: intent.toolName,
      toolVersion: intent.toolVersion,
      actionDigest: actionDigestOf(intent),
      targetResourceSpaceIds: [],
      controlBasisDigest: context.controlBasisDigest,
      expiresAt: "2999-01-01T00:00:00.000Z",
      consumedBy: null,
    };
    let invocation: import("@arbor/ports").ToolInvocationRecord | undefined;
    let sandboxOpenCalls = 0;
    let executorCalls = 0;
    let intentWrites = 0;
    let approvalConsumeWrites = 0;
    let settlementWrites = 0;
    let effectAdmissionWrites = 0;
    const claimTransactions: Array<string> = [];

    const executor: ToolExecutor = {
      name: "read",
      write: false,
      requiresApproval: () => true,
      execute: () => {
        executorCalls += 1;
        return Effect.succeed({
          settlement: { _tag: "Success" },
          observation: { text: "resumed exact invocation", truncated: false },
          resultRef: null,
        });
      },
    };
    const dependencies = Layer.mergeAll(
      approvalPipelineDeps({
        sandboxHandleId: "ah7-sandbox",
        environmentRevision: "ah7-env",
        now: "2026-10-06T00:00:00.000Z",
        sandboxPort: Layer.succeed(SandboxPort, {
          open: () => {
            sandboxOpenCalls += 1;
            return sandboxOpenCalls === 1
              ? Effect.fail({
                  _tag: "SandboxError" as const,
                  cause: "injected interruption before executor attempt",
                })
              : Effect.succeed({
                  handleId: "ah7-sandbox",
                  rootPath: "/repo",
                  writableRegions: [],
                });
          },
          close: () => Effect.void,
        }),
      }),
      Layer.succeed(ToolInvocationStore, {
        recordIntent: (record: import("@arbor/ports").ToolInvocationIntent) =>
          Effect.gen(function* () {
            const transaction = yield* TransactionScope;
            claimTransactions.push(transaction.session.id);
            intentWrites += 1;
            invocation = {
              ...record,
              effectAdmissionState: "NotAdmitted",
              settledAt: null,
              settlement: null,
              resultRef: null,
            };
            return "Recorded" as const;
          }),
        settle: (
          id: ToolInvocationId,
          settledAt: string,
          settlement: NonNullable<
            import("@arbor/ports").ToolInvocationRecord["settlement"]
          >,
          resultRef: string | null,
        ) => {
          expect(id).toBe(invocationId);
          settlementWrites += 1;
          if (invocation === undefined) {
            return Effect.die(new Error("settlement without recorded intent"));
          }
          invocation = {
            ...invocation,
            settledAt,
            settlement,
            resultRef,
          };
          return Effect.succeed(true);
        },
        consumeApproval: (id: string, consumer: ToolInvocationId) =>
          Effect.gen(function* () {
            const transaction = yield* TransactionScope;
            claimTransactions.push(transaction.session.id);
            expect(id).toBe(approvalId);
            if (approval.consumedBy !== null) return false;
            approvalConsumeWrites += 1;
            approval = { ...approval, consumedBy: consumer };
            return true;
          }),
        admitEffect: () =>
          Effect.sync(() => {
            effectAdmissionWrites += 1;
            return { _tag: "Admitted" as const };
          }),
        recordNoEffectDenial: () => Effect.die(new Error("unexpected denial")),
        recordNoEffectInterruption: () => Effect.succeed(false),
        findApproval: () => Effect.succeed(Option.some(approval)),
        findById: (id: ToolInvocationId) => {
          expect(id).toBe(invocationId);
          return Effect.succeed(
            invocation === undefined ? Option.none() : Option.some(invocation),
          );
        },
        findUnsettled: () =>
          Effect.succeed(invocation?.settlement === null ? [invocation] : []),
      } as never),
    );
    const app = Layer.mergeAll(
      dependencies,
      Layer.provide(ToolRuntimeLive([executor]), dependencies),
    );
    const invoke = () =>
      Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const runtime = yield* ToolRuntimePort;
            return yield* runtime.invoke(intent, context);
          }),
          app,
        ) as Effect.Effect<unknown, unknown, never>,
      );

    await expect(invoke()).rejects.toMatchObject({
      _tag: "ToolRuntimeOperationalFailure",
      stage: "SandboxOpen",
    });
    expect(approval.consumedBy).toBe(invocationId);
    expect(invocation?.settlement).toBeNull();
    expect(executorCalls).toBe(0);

    const resumed = await invoke();

    expect(resumed).toMatchObject({
      _tag: "Success",
      observation: { text: "resumed exact invocation", truncated: false },
    });
    expect(approval.consumedBy).toBe(invocationId);
    expect(intentWrites).toBe(1);
    expect(approvalConsumeWrites).toBe(1);
    expect(executorCalls).toBe(1);
    expect(settlementWrites).toBe(1);
    expect(effectAdmissionWrites).toBe(2);
    expect(claimTransactions).toHaveLength(2);
    expect(claimTransactions[0]).toBe(claimTransactions[1]);
  });
});
