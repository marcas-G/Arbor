import { Effect, Layer, Option } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type ConversationSettlementDependencies,
  type ConversationTriggerDependencies,
  runConversationSettlement,
  runConversationTrigger,
} from "../packages/application/src/conversation-trigger.js";
import type {
  CommandAuthorityFact,
  CommandGatewayService,
} from "../packages/application/src/index.js";
import {
  type CommandSubmissionContext,
  ExecutionId,
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
 * P14-003 (contract `02`) — conversation trigger + settle write-back.
 * Seams: S5 (one-active-main queueing, FIFO claim), S6 (crash@claim
 * rollback, retry-until-response, exact-once Answered), S8 (admission is the
 * server-side Application path with a System context).
 */

const PROJECT = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789ab");
const ROOT = parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789ab");
const PRINCIPAL = parse(Principal)("runtime:conversation-trigger");

const MSG = {
  a: "msg_018f2b3c-4d5e-7abc-8def-00000000000a",
  b: "msg_018f2b3c-4d5e-7abc-8def-00000000000b",
  c: "msg_018f2b3c-4d5e-7abc-8def-00000000000c",
  d: "msg_018f2b3c-4d5e-7abc-8def-00000000000d",
  e: "msg_018f2b3c-4d5e-7abc-8def-00000000000e",
  f: "msg_018f2b3c-4d5e-7abc-8def-00000000000f",
  g: "msg_018f2b3c-4d5e-7abc-8def-000000000010",
} as const;

const scopeLayer = Layer.succeed(TransactionScope, {
  session: { id: "test-tx" },
}) as unknown as Layer.Layer<TransactionScope>;

const record = (
  messageId: string,
  createdAt: string,
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
  createdAt,
  settledAt: null,
  responseBody: null,
  attemptNo: 0,
  ...overrides,
});

interface Admission {
  readonly commandId: string;
  readonly payload: unknown;
  readonly context: CommandSubmissionContext;
  readonly authority: CommandAuthorityFact;
}

interface Harness {
  readonly rows: Map<string, HumanMessageRecord>;
  readonly admissions: Array<Admission>;
  readonly deps: ConversationTriggerDependencies;
  readonly settle: ConversationSettlementDependencies;
  put(
    messageId: string,
    createdAt: string,
    overrides?: Partial<HumanMessageRecord>,
  ): void;
  setActive(active: boolean): void;
  failNextAdmission(reason: string): void;
}

const makeHarness = (): Harness => {
  const rows = new Map<string, HumanMessageRecord>();
  const admissions: Array<Admission> = [];
  let active = false;
  let admissionRejection: string | null = null;

  const messages = {
    pendingOrderedByCreated: () =>
      Effect.succeed(
        [...rows.values()]
          .filter((row) => row.state === "Pending")
          .sort((x, y) => x.createdAt.localeCompare(y.createdAt)),
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
  } as unknown as ConversationTriggerDependencies["messages"] &
    ConversationSettlementDependencies["messages"];

  const gateway = {
    execute: (
      envelope: { readonly commandId: unknown; readonly payload?: unknown },
      context: CommandSubmissionContext,
      authority: CommandAuthorityFact,
    ) => {
      admissions.push({
        commandId: String(envelope.commandId),
        payload: envelope.payload,
        context,
        authority,
      });
      if (admissionRejection !== null) {
        const reason = admissionRejection;
        admissionRejection = null;
        return Effect.succeed({
          commandId: envelope.commandId,
          resolution: {
            _tag: "TerminalRejected" as const,
            error: { _tag: reason },
          },
        });
      }
      return Effect.succeed({
        commandId: envelope.commandId,
        resolution: { _tag: "Committed" as const, result: null },
      });
    },
  } as unknown as CommandGatewayService;

  const deps: ConversationTriggerDependencies = {
    gateway,
    messages,
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
    tx: {
      transact: (body: unknown) => body,
    } as unknown as ConversationTriggerDependencies["tx"],
    principal: PRINCIPAL,
  };

  const settle: ConversationSettlementDependencies = {
    messages,
    clock: { now: () => Effect.succeed("2026-09-23T05:02:00.000Z") },
    responseBodyOf: () => Effect.succeed("assistant reply"),
  };

  return {
    rows,
    admissions,
    deps,
    settle,
    put: (messageId, createdAt, overrides) => {
      rows.set(messageId, record(messageId, createdAt, overrides));
    },
    setActive: (next) => {
      active = next;
    },
    failNextAdmission: (reason) => {
      admissionRejection = reason;
    },
  };
};

let harness: Harness;

beforeEach(() => {
  harness = makeHarness();
});

const runTrigger = (): Promise<{ readonly records: ReadonlyArray<string> }> =>
  Effect.runPromise(
    Effect.provide(
      runConversationTrigger(harness.deps, PROJECT) as never,
      scopeLayer,
    ) as never,
  ) as Promise<{ readonly records: ReadonlyArray<string> }>;

const runSettle = (executionId: string): Promise<ReadonlyArray<string>> =>
  Effect.runPromise(
    Effect.provide(
      runConversationSettlement(harness.settle, executionId) as never,
      scopeLayer,
    ) as never,
  ) as Promise<ReadonlyArray<string>>;

describe("P14-003 conversation trigger", () => {
  it("S5: no pending message → no admission", async () => {
    const outcome = await runTrigger();
    expect(outcome.records).toEqual([]);
    expect(harness.admissions).toHaveLength(0);
  });

  it("S5: one-active-main keeps the message durable Pending (no second main)", async () => {
    harness.put(MSG.a, "2026-09-23T05:00:01.000Z");
    harness.setActive(true);
    const outcome = await runTrigger();
    expect(outcome.records).toEqual([`queued:${MSG.a}`]);
    expect(harness.admissions).toHaveLength(0);
    expect(harness.rows.get(MSG.a)?.state).toBe("Pending");
  });

  it("S5: admits the FIFO-oldest message as Coordination and claims it", async () => {
    harness.put(MSG.b, "2026-09-23T05:00:02.000Z");
    harness.put(MSG.a, "2026-09-23T05:00:01.000Z");
    const outcome = await runTrigger();
    expect(outcome.records[0]).toContain("admitted:exe_");
    const admission = harness.admissions[0];
    const payload = admission?.payload as {
      _tag: string;
      focus: { _tag: string };
      executionId: string;
    };
    expect(payload._tag).toBe("WorkspaceMain");
    expect(payload.focus._tag).toBe("Coordination");
    expect(admission?.context._tag).toBe("System");
    expect(admission?.authority._tag).toBe("AdmitExecutionAuthority");
    expect(harness.rows.get(MSG.a)?.state).toBe("Claimed");
    // FIFO: the newer message stays untouched while the older is in flight
    expect(harness.rows.get(MSG.b)?.state).toBe("Pending");
  });

  it("S5: a message already Claimed by another execution is not admitted twice (CAS)", async () => {
    harness.put(MSG.c, "2026-09-23T05:00:01.000Z", {
      state: "Claimed",
      claimedByExecutionId: "exe_other",
    });
    const outcome = await runTrigger();
    // not pending → nothing to admit at all
    expect(outcome.records).toEqual([]);
    expect(harness.admissions).toHaveLength(0);
  });

  it("S5: a stale Claimed row (crash@claim) blocks admission until rolled back", async () => {
    harness.put(MSG.g, "2026-09-23T05:00:01.000Z", {
      state: "Claimed",
      claimedByExecutionId: String(
        parse(ExecutionId)("exe_999f2b3c-4d5e-7abc-8def-0123456789ab"),
      ),
    });
    const blocked = await runTrigger();
    expect(blocked.records).toEqual([]);
    // recovery sweep rolls the stale claim back → retry-until-response
    await Effect.runPromise(
      Effect.provide(
        harness.deps.messages.rollbackClaim(MSG.g) as never,
        scopeLayer,
      ) as never,
    );
    const recovered = await runTrigger();
    expect(recovered.records[0]).toContain("admitted:");
    expect(harness.rows.get(MSG.g)?.state).toBe("Claimed");
  });

  it("S6: a rejected admission rolls the claim back (retry-until-response)", async () => {
    harness.put(MSG.d, "2026-09-23T05:00:01.000Z");
    harness.failNextAdmission("ActiveExecutionConflict");
    const first = await runTrigger();
    expect(first.records[0]).toContain("skipped:ActiveExecutionConflict");
    expect(harness.rows.get(MSG.d)?.state).toBe("Pending");
    const second = await runTrigger();
    expect(second.records[0]).toContain("admitted:");
    expect(harness.rows.get(MSG.d)?.state).toBe("Claimed");
  });

  it("S6: deterministic execution + command ids derive from the messageId (replay converges)", async () => {
    harness.put(MSG.e, "2026-09-23T05:00:01.000Z");
    harness.failNextAdmission("ActiveExecutionConflict");
    await runTrigger();
    await runTrigger();
    const ids = harness.admissions.map((admission) => admission.commandId);
    expect(new Set(ids).size).toBe(1);
    const executionIds = harness.admissions.map(
      (admission) => (admission.payload as { executionId: string }).executionId,
    );
    expect(new Set(executionIds).size).toBe(1);
    expect(executionIds[0]).toMatch(/^exe_[0-9a-f-]{36}$/);
  });

  it("S6: settle write-back marks the claimed message Answered exactly once", async () => {
    harness.put(MSG.f, "2026-09-23T05:00:01.000Z");
    await runTrigger();
    const executionId = String(harness.rows.get(MSG.f)?.claimedByExecutionId);
    const first = await runSettle(executionId);
    const second = await runSettle(executionId);
    expect(first).toEqual([`answered:${MSG.f}`]);
    expect(second).toEqual(["noop:no-claimed-message"]);
    expect(harness.rows.get(MSG.f)?.state).toBe("Answered");
  });
});
