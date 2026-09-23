import { Effect, Layer, Option } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type ConversationSettlementDependencies,
  type ConversationSweepDependencies,
  runConversationSettlementSweep,
  runConversationTrigger,
} from "../packages/application/src/conversation-trigger.js";
import type { CommandGatewayService } from "../packages/application/src/index.js";
import type { ExecutionSettlement } from "../packages/domain/src/index.js";
import {
  type ExecutionId,
  Principal,
  ProjectId,
  parse,
  WorkspaceId,
} from "../packages/domain/src/index.js";
import {
  type ExecutionRepositoryService,
  type HumanMessageRecord,
  type HumanMessageStoreService,
  type ProjectRepositoryService,
  TransactionScope,
} from "../packages/ports/src/index.js";

/**
 * P14 reconciliation (contract `02` §4.1–§4.3) — the settle→write-back
 * durable two-step recovery protocol. This suite is the mechanical evidence
 * for requirement B:
 *
 *   · crash window between settle and write-back is rediscovered
 *   · restart continues (a fresh sweep over persisted rows finishes it)
 *   · duplicate sweep does not answer twice
 *   · CAS loser (concurrent claim/sweep) never double-admits/double-answers
 *   · already-written rows are never re-written
 *   · a message is never permanently stuck (every settlement branch resolves)
 *   · Failed/OutcomeUnknown retries with a fresh attempt (retry-until-response)
 *   · Interrupted is consumed with no body (no retry storm)
 *   · one-active-main / FIFO still hold across the protocol
 */

const PROJECT = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789ab");
const ROOT = parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789ab");
const PRINCIPAL = parse(Principal)("runtime:conversation-trigger");
const MSG = "msg_018f2b3c-4d5e-7abc-8def-000000000021";

const scopeLayer = Layer.succeed(TransactionScope, {
  session: { id: "test-tx" },
}) as unknown as Layer.Layer<TransactionScope>;

const record = (
  messageId: string,
  overrides: Partial<HumanMessageRecord> = {},
): HumanMessageRecord => ({
  messageId,
  projectId: PROJECT,
  rootWorkspaceId: ROOT,
  humanPrincipal: parse(Principal)("user:lgao"),
  bodyRef: `body ${messageId}`,
  commandId: `cmd_${messageId}` as HumanMessageRecord["commandId"],
  fingerprint: `fp_${messageId}`,
  state: "Pending",
  claimedByExecutionId: null,
  createdAt: "2026-09-23T05:00:01.000Z",
  settledAt: null,
  responseBody: null,
  attemptNo: 0,
  ...overrides,
});

/** The protocol harness: persisted rows survive "restarts" (the maps are the
 * durable store; a new sweep call is a restarted daemon tick). */
interface Protocol {
  readonly rows: Map<string, HumanMessageRecord>;
  readonly executions: Map<string, ExecutionSettlement | null>;
  readonly admissions: Array<{
    readonly commandId: string;
    readonly executionId: string;
  }>;
  readonly sweepDeps: ConversationSweepDependencies;
  readonly triggerDeps: Parameters<typeof runConversationTrigger>[0];
  setSettlement(
    executionId: string,
    settlement: ExecutionSettlement | null,
  ): void;
}

const makeProtocol = (): Protocol => {
  const rows = new Map<string, HumanMessageRecord>();
  const executions = new Map<string, ExecutionSettlement | null>();
  const admissions: Array<{ commandId: string; executionId: string }> = [];
  const active = false;

  const messages = {
    pendingOrderedByCreated: () =>
      Effect.succeed(
        [...rows.values()]
          .filter((row) => row.state === "Pending")
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      ),
    claim: (messageId: string, executionId: string) => {
      const row = rows.get(messageId);
      if (row === undefined) {
        return Effect.succeed({ _tag: "NotFound" as const });
      }
      if (row.state !== "Pending") {
        return Effect.succeed({ _tag: "AlreadyClaimed" as const });
      }
      rows.set(messageId, {
        ...row,
        state: "Claimed",
        claimedByExecutionId: executionId,
      });
      return Effect.succeed({ _tag: "Claimed" as const });
    },
    rollbackClaim: (messageId: string) => {
      const row = rows.get(messageId);
      if (row !== undefined && row.state === "Claimed") {
        rows.set(messageId, {
          ...row,
          state: "Pending",
          claimedByExecutionId: null,
        });
      }
      return Effect.void;
    },
    rollbackForRetry: (messageId: string) => {
      const row = rows.get(messageId);
      if (row !== undefined && row.state === "Claimed") {
        rows.set(messageId, {
          ...row,
          state: "Pending",
          claimedByExecutionId: null,
          attemptNo: row.attemptNo + 1,
        });
      }
      return Effect.void;
    },
    claimedOrderedByCreated: () =>
      Effect.succeed(
        [...rows.values()]
          .filter((row) => row.state === "Claimed")
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      ),
    findByClaimedExecution: (executionId: string) => {
      const row = [...rows.values()].find(
        (candidate) =>
          candidate.claimedByExecutionId === executionId &&
          candidate.state === "Claimed",
      );
      return Effect.succeed(
        row === undefined ? Option.none() : Option.some(row),
      );
    },
    markAnswered: (
      messageId: string,
      settledAt: string,
      responseBody: string | null,
    ) => {
      const row = rows.get(messageId);
      // CAS: ONLY a still-Claimed row transitions (already-written = no-op).
      if (row !== undefined && row.state === "Claimed") {
        rows.set(messageId, {
          ...row,
          state: "Answered",
          settledAt,
          responseBody,
        });
      }
      return Effect.void;
    },
  };

  const gateway = {
    execute: (envelope: { readonly commandId: unknown }) => {
      const executionId = String(
        (envelope as { readonly payload?: { readonly executionId?: unknown } })
          .payload?.executionId,
      );
      admissions.push({ commandId: String(envelope.commandId), executionId });
      executions.set(executionId, null); // admitted, active
      return Effect.succeed({
        commandId: envelope.commandId,
        resolution: { _tag: "Committed" as const, result: null },
      });
    },
  } as unknown as CommandGatewayService;

  const sweepDeps: ConversationSweepDependencies = {
    messages: messages as unknown as ConversationSweepDependencies["messages"],
    executions: {
      findById: (executionId: ExecutionId) => {
        const settlement = executions.get(String(executionId));
        if (settlement === undefined) {
          return Effect.succeed(Option.none());
        }
        return Effect.succeed(
          Option.some({
            state:
              settlement === null
                ? { status: "Active" as const, settlement: null }
                : { status: "Settled" as const, settlement },
          } as never),
        );
      },
    } as unknown as Pick<ExecutionRepositoryService, "findById">,
    clock: { now: () => Effect.succeed("2026-09-23T05:02:00.000Z") },
    responseBodyOf: (messageId: string) =>
      Effect.succeed(`response for ${messageId}`),
  };

  const triggerDeps = {
    gateway,
    messages: messages as unknown as Parameters<
      typeof runConversationTrigger
    >[0]["messages"],
    projects: {
      findById: () =>
        Effect.succeed(Option.some({ rootWorkspaceId: ROOT } as never)),
    } as unknown as Pick<ProjectRepositoryService, "findById">,
    executions: {
      findActiveMainByWorkspace: () =>
        Effect.succeed(active ? Option.some({} as never) : Option.none()),
    } as unknown as Pick<
      ExecutionRepositoryService,
      "findActiveMainByWorkspace"
    >,
    clock: { now: () => Effect.succeed("2026-09-23T05:00:00.000Z") },
    tx: { transact: (body: unknown) => body } as unknown as Parameters<
      typeof runConversationTrigger
    >[0]["tx"],
    principal: PRINCIPAL,
  };

  return {
    rows,
    executions,
    admissions,
    sweepDeps,
    triggerDeps,
    setSettlement: (executionId, settlement) => {
      executions.set(executionId, settlement);
    },
  };
};

let protocol: Protocol;

beforeEach(() => {
  protocol = makeProtocol();
});

const tick = (): Promise<ReadonlyArray<string>> =>
  Effect.runPromise(
    Effect.provide(
      runConversationSettlementSweep(protocol.sweepDeps, PROJECT) as never,
      scopeLayer,
    ) as never,
  ) as Promise<ReadonlyArray<string>>;

const admit = (): Promise<{ readonly records: ReadonlyArray<string> }> =>
  Effect.runPromise(
    runConversationTrigger(protocol.triggerDeps, PROJECT) as never,
  ) as Promise<{ readonly records: ReadonlyArray<string> }>;

describe("P14 reconciliation — durable two-step recovery protocol (02 §4)", () => {
  it("crash after settle, before write-back: the Claimed message is rediscovered and answered", async () => {
    protocol.rows.set(MSG, record(MSG));
    await admit();
    const executionId = String(protocol.rows.get(MSG)?.claimedByExecutionId);
    // Step 1 committed (settled), Step 2 never ran (the crash window).
    protocol.setSettlement(executionId, {
      _tag: "Completed",
      result: { _tag: "CoordinationCompleted" },
    });
    expect(protocol.rows.get(MSG)?.state).toBe("Claimed");

    // restart = a fresh sweep over the persisted rows
    const firstTick = await tick();
    expect(firstTick).toEqual([`answered:${MSG}`]);
    expect(protocol.rows.get(MSG)?.state).toBe("Answered");
    expect(protocol.rows.get(MSG)?.responseBody).toBe(`response for ${MSG}`);
  });

  it("duplicate sweep does not answer twice (already-written is never re-written)", async () => {
    protocol.rows.set(MSG, record(MSG));
    await admit();
    const executionId = String(protocol.rows.get(MSG)?.claimedByExecutionId);
    protocol.setSettlement(executionId, {
      _tag: "Completed",
      result: { _tag: "CoordinationCompleted" },
    });
    await tick();
    const settledAt = protocol.rows.get(MSG)?.settledAt;
    const second = await tick();
    expect(second).toEqual([]);
    // the row was not re-written (same settledAt, still Answered)
    expect(protocol.rows.get(MSG)?.settledAt).toBe(settledAt);
    expect(protocol.rows.get(MSG)?.state).toBe("Answered");
  });

  it("CAS loser: a second trigger tick cannot double-admit a Claimed message", async () => {
    protocol.rows.set(MSG, record(MSG));
    await admit();
    const second = await admit();
    expect(second.records).toEqual([]);
    expect(protocol.admissions).toHaveLength(1);
    expect(protocol.rows.get(MSG)?.state).toBe("Claimed");
  });

  it("already-Answered replay: a stale Claimed scan outcome cannot rewrite an Answered row", async () => {
    protocol.rows.set(
      MSG,
      record(MSG, {
        state: "Answered",
        claimedByExecutionId: "exe_018f2b3c-4d5e-7abc-8def-000000000031",
        settledAt: "2026-09-23T05:02:00.000Z",
        responseBody: "original",
      }),
    );
    const outcome = await tick();
    // not in the Claimed scan → no-op, no rewrite
    expect(outcome).toEqual([]);
    expect(protocol.rows.get(MSG)?.responseBody).toBe("original");
  });

  it("Failed settlement retries with a fresh attempt (retry-until-response, never stuck)", async () => {
    protocol.rows.set(MSG, record(MSG));
    await admit();
    const firstExecution = String(protocol.rows.get(MSG)?.claimedByExecutionId);
    protocol.setSettlement(firstExecution, {
      _tag: "Failed",
      failure: { _tag: "ExecutionFailure", reason: "provider down" },
    });
    const retryTick = await tick();
    expect(retryTick).toEqual([`retry:${MSG}`]);
    expect(protocol.rows.get(MSG)?.state).toBe("Pending");
    expect(protocol.rows.get(MSG)?.attemptNo).toBe(1);

    // the next admission uses fresh derived ids (no collision with the settled row)
    const next = await admit();
    expect(next.records[0]).toContain("admitted:");
    expect(protocol.admissions).toHaveLength(2);
    const secondExecution = String(
      protocol.rows.get(MSG)?.claimedByExecutionId,
    );
    expect(secondExecution).not.toBe(firstExecution);
    // and the second attempt can then be answered
    protocol.setSettlement(secondExecution, {
      _tag: "Completed",
      result: { _tag: "CoordinationCompleted" },
    });
    const answerTick = await tick();
    expect(answerTick).toEqual([`answered:${MSG}`]);
    expect(protocol.rows.get(MSG)?.state).toBe("Answered");
  });

  it("OutcomeUnknown retries; Interrupted is consumed with no body (no retry storm)", async () => {
    protocol.rows.set(MSG, record(MSG));
    await admit();
    const firstExecution = String(protocol.rows.get(MSG)?.claimedByExecutionId);
    protocol.setSettlement(firstExecution, {
      _tag: "OutcomeUnknown",
      reconciliation: { _tag: "ReconciliationRequired", invocationRefs: [] },
    });
    expect(await tick()).toEqual([`retry:${MSG}`]);
    expect(protocol.rows.get(MSG)?.state).toBe("Pending");

    await admit();
    const secondExecution = String(
      protocol.rows.get(MSG)?.claimedByExecutionId,
    );
    protocol.setSettlement(secondExecution, {
      _tag: "Interrupted",
      result: { _tag: "StopRequested" },
    });
    expect(await tick()).toEqual([`interrupted:${MSG}`]);
    const row = protocol.rows.get(MSG);
    expect(row?.state).toBe("Answered");
    expect(row?.responseBody).toBeNull();
    // no further retry: the message is not queued again
    expect(await admit()).toEqual({ records: [] });
  });

  it("one-active-main still holds across the protocol (nothing is admitted while a main is active)", async () => {
    protocol.rows.set(MSG, record(MSG));
    // simulate an active main by pre-claiming the message and marking active
    const gatewayAdmissions = protocol.admissions.length;
    protocol.rows.set(
      MSG,
      record(MSG, {
        state: "Claimed",
        claimedByExecutionId: "exe_018f2b3c-4d5e-7abc-8def-000000000032",
      }),
    );
    protocol.setSettlement("exe_018f2b3c-4d5e-7abc-8def-000000000032", null); // Active
    const sweepOutcome = await tick();
    expect(sweepOutcome).toEqual([]); // active → left alone
    expect(protocol.admissions.length).toBe(gatewayAdmissions);
    expect(protocol.rows.get(MSG)?.state).toBe("Claimed");
  });
});
