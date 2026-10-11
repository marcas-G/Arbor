import type {
  ExecutableApprovalBinding,
  ExecutableApprovalRecord,
  ExecutableApprovalStoreService,
  TransactionOperationalFailure,
  TransactionPortService,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { issueExecutableApproval } from "../src/executable-approval-issuance.js";

const binding = (): ExecutableApprovalBinding => ({
  projectId: "prj_ea_test" as never,
  workspaceId: "ws_ea_test" as never,
  executionId: "exe_ea_test" as never,
  logicalStepNo: 3,
  repairAttempt: 1,
  actionIndex: 0,
  logicalActionId: "lac_ea_test" as never,
  subject: "human:trusted" as never,
  callRef: "provider-call-7",
  toolInvocationId: "tin_ea_test" as never,
  toolName: "write_file",
  toolVersion: "v2",
  sideEffectSemantics: "Idempotent",
  argumentsJson: '{"path":"src/a.ts","content":"x"}',
  actionDigest: "digest-a",
  targetResourceSpaceIds: ["rsp_project"],
  controlBasisDigest: "basis-a",
});

const authority = () => ({
  principal: "human:trusted" as never,
  workspaceId: "ws_ea_test" as never,
  executionId: "exe_ea_test" as never,
  toolName: "write_file",
  toolVersion: "v2",
  resourceSpaceIds: ["rsp_project"],
  allowedCapabilities: ["filesystem.write"],
  controlBasisDigest: "basis-a",
  expiresAt: "2026-10-11T00:30:00.000Z",
  delegationDepth: 0,
});

const transaction = (): TransactionPortService => ({
  transact: <A, E, R>(
    effect: Effect.Effect<A, E, R | TransactionScope>,
  ): Effect.Effect<
    A,
    E | TransactionOperationalFailure,
    Exclude<R, TransactionScope>
  > =>
    effect as unknown as Effect.Effect<
      A,
      E | TransactionOperationalFailure,
      Exclude<R, TransactionScope>
    >,
});

const recordFor = (
  request: ExecutableApprovalBinding & {
    readonly approvalId: string;
    readonly requestedAt: string;
    readonly expiresAt: string;
  },
): ExecutableApprovalRecord => ({
  ...request,
  routeKind: "Executable",
  revision: 0,
  state: "Pending",
  decidedAt: null,
  decidedBy: null,
  decisionReason: null,
  cancelledAt: null,
  cancelledBy: null,
  cancellationReason: null,
  consumedAt: null,
  consumedBy: null,
});

describe("Executable approval issuance", () => {
  it("passes the exact trusted binding and lease to the atomic Pending writer", async () => {
    let persisted:
      | Parameters<ExecutableApprovalStoreService["putPendingExact"]>[0]
      | undefined;
    const expected = recordFor({
      ...binding(),
      approvalId: "apr_first",
      requestedAt: "2026-10-11T00:00:00.000Z",
      expiresAt: "2026-10-11T00:15:00.000Z",
    });
    const store: ExecutableApprovalStoreService = {
      findByActionKey: () => Effect.succeed(Option.none()),
      findById: () => Effect.succeed(Option.none()),
      decide: () => Effect.succeed(Option.none()),
      consumeApproved: () => Effect.succeed(false),
      cancelForExecution: () => Effect.succeed([]),
      putPendingExact: (request) => {
        persisted = request;
        return Effect.succeed(expected);
      },
    };

    const result = await Effect.runPromise(
      issueExecutableApproval(
        {
          binding: binding(),
          authority: authority(),
          requestedAt: "2026-10-11T00:00:00.000Z",
          executionFence: {
            executionId: "exe_ea_test" as never,
            workerId: "worker-1",
            workerIncarnationId: "incarnation-1",
            fencingGeneration: 4 as never,
          },
        },
        {
          store,
          transaction: transaction(),
          resolveCandidate: () =>
            Effect.succeed({
              approvalId: "apr_first",
              expiresAt: "2026-10-11T00:15:00.000Z",
            }),
        },
      ),
    );

    expect(result).toMatchObject({
      approvalId: "apr_first",
      routeKind: "Executable",
      state: "Pending",
      revision: 0,
    });
    expect(persisted).toMatchObject({
      executionFence: {
        executionId: "exe_ea_test",
        workerId: "worker-1",
        workerIncarnationId: "incarnation-1",
        fencingGeneration: 4,
      },
      logicalStepNo: 3,
      repairAttempt: 1,
      actionIndex: 0,
      logicalActionId: "lac_ea_test",
      toolInvocationId: "tin_ea_test",
    });
  });

  it("reuses the committed binding and first TTL on same-action replay", async () => {
    const committed = recordFor({
      ...binding(),
      approvalId: "apr_existing",
      requestedAt: "2026-10-11T00:00:00.000Z",
      expiresAt: "2026-10-11T00:15:00.000Z",
    });
    let candidateResolutions = 0;
    let pendingWrites = 0;
    const store: ExecutableApprovalStoreService = {
      findByActionKey: () => Effect.succeed(Option.some(committed)),
      findById: () => Effect.succeed(Option.some(committed)),
      decide: () => Effect.succeed(Option.none()),
      consumeApproved: () => Effect.succeed(false),
      cancelForExecution: () => Effect.succeed([]),
      putPendingExact: () => {
        pendingWrites += 1;
        return Effect.succeed(committed);
      },
    };

    const result = await Effect.runPromise(
      issueExecutableApproval(
        {
          binding: binding(),
          authority: authority(),
          requestedAt: "2026-10-11T00:10:00.000Z",
          executionFence: {
            executionId: "exe_ea_test" as never,
            workerId: "worker-1",
            workerIncarnationId: "incarnation-1",
            fencingGeneration: 4 as never,
          },
        },
        {
          store,
          transaction: transaction(),
          resolveCandidate: () => {
            candidateResolutions += 1;
            return Effect.succeed({
              approvalId: "apr_new",
              expiresAt: "2026-10-11T00:25:00.000Z",
            });
          },
        },
      ),
    );

    expect(result).not.toBe("ExecutionStopping");
    if (result === "ExecutionStopping") throw new Error("unexpected Stop");
    expect(result.approvalId).toBe("apr_existing");
    expect(result.expiresAt).toBe("2026-10-11T00:15:00.000Z");
    expect(candidateResolutions).toBe(0);
    expect(pendingWrites).toBe(0);
  });

  it("fails closed when the logical-action key is reused with changed arguments", async () => {
    const changed = { ...binding(), argumentsJson: '{"path":"other"}' };
    const committed = recordFor({
      ...binding(),
      approvalId: "apr_existing",
      requestedAt: "2026-10-11T00:00:00.000Z",
      expiresAt: "2026-10-11T00:15:00.000Z",
    });
    const store: ExecutableApprovalStoreService = {
      findByActionKey: () => Effect.succeed(Option.some(committed)),
      findById: () => Effect.succeed(Option.some(committed)),
      decide: () => Effect.succeed(Option.none()),
      consumeApproved: () => Effect.succeed(false),
      cancelForExecution: () => Effect.succeed([]),
      putPendingExact: () => Effect.die("must not write on binding conflict"),
    };

    const failure = await Effect.runPromise(
      Effect.flip(
        issueExecutableApproval(
          {
            binding: changed,
            authority: authority(),
            requestedAt: "2026-10-11T00:10:00.000Z",
            executionFence: {
              executionId: "exe_ea_test" as never,
              workerId: "worker-1",
              workerIncarnationId: "incarnation-1",
              fencingGeneration: 4 as never,
            },
          },
          {
            store,
            transaction: transaction(),
            resolveCandidate: () => Effect.die("must not resolve a new ID"),
          },
        ),
      ),
    );

    expect(failure).toMatchObject({
      _tag: "ExecutableApprovalBindingConflict",
      key: {
        executionId: "exe_ea_test",
        logicalStepNo: 3,
        repairAttempt: 1,
        actionIndex: 0,
        logicalActionId: "lac_ea_test",
      },
    });
  });
});
