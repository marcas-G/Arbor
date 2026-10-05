import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { assignWorkHandler } from "../../../apps/single-workspace/src/control-actions.js";
import type { AgentActionHandlerInput } from "../../../packages/agent-runtime/src/index.js";
import type {
  CommandGatewayService,
  GatewayEnvelope,
} from "../../../packages/application/src/index.js";
import {
  ExecutionId,
  type LeaseGeneration,
  Principal,
  ProjectId,
  parse,
  SessionId,
  WorkId,
  WorkspaceId,
} from "../../../packages/domain/src/index.js";
import type {
  ClockService,
  TransactionPortService,
  WorkspaceRepositoryService,
} from "../../../packages/ports/src/index.js";

const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");
const principal = parse(Principal)("worker:ah10");

const execution = {
  executionId,
  projectId,
  workspaceId,
  sessionId,
  binding: {
    _tag: "WorkspaceExecution" as const,
    workspaceId,
    episode: {
      _tag: "WorkEpisode" as const,
      workId: parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789a1"),
      targetWorkRevision: 0,
    },
  },
  admittedAt: "2026-10-05T00:00:00.000Z",
  stopRequestedAt: null,
  state: { status: "Active" as const, settlement: null },
} as never;

const action = {
  _tag: "AssignWork" as const,
  objective: "AH10 takeover target",
  why: "re-enter one pinned action under the current lease generation",
  constraints: [],
  completionExpectation: "one Work is committed by the current generation",
  verificationMission: {
    goal: "verify AH10 command takeover",
    criteria: [
      {
        criterionId: "ah10-work-created",
        requirement: "the current generation commits the Work",
        required: true,
      },
    ],
    riskRequirements: [],
  },
  reason: "AH10 receipt-first takeover test",
};

const invocation = {
  providerTurnId: "ptn_018f2b3c-4d5e-7abc-8def-0123456789a2" as never,
  outputPosition: 0,
  callRef: "call-ah10-same-pinned-action",
  toolName: "assign_work",
  argumentsJson: JSON.stringify(action),
};

const generationContext = (generation: number) =>
  ({
    _tag: "ExecutionOrigin" as const,
    principal,
    executionId,
    fencingGeneration: generation as LeaseGeneration,
  }) as never;

const runHandler = (
  handler: ReturnType<typeof assignWorkHandler>,
  generation: number,
) =>
  Effect.runPromise(
    Effect.match(
      handler.handle({
        action,
        invocation,
        execution,
        context: generationContext(generation),
      } as AgentActionHandlerInput),
      {
        onFailure: (cause) => ({ _tag: "Rejected" as const, cause }),
        onSuccess: (outcome) => ({ _tag: "Accepted" as const, outcome }),
      },
    ),
  );

const makeHandler = (gateway: CommandGatewayService) =>
  assignWorkHandler({
    gateway,
    workspaces: {
      findById: () =>
        Effect.succeed(
          Option.some({
            workspaceId,
            projectId,
            parentWorkspaceId: null,
            lifecycle: "Active",
            revision: 0,
          } as never),
        ),
    } as unknown as WorkspaceRepositoryService,
    clock: {
      now: () => Effect.succeed("2026-10-05T00:00:00.000Z"),
    } as ClockService,
    tx: {
      transact: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
    } as TransactionPortService,
  });

describe("AH10 receipt-first generation takeover for a pinned AssignWork", () => {
  it("uses a new CommandId after gen0 FencingRejected so gen1 can commit the same LogicalAction", async () => {
    const receipts = new Map<
      string,
      {
        readonly resolution: {
          readonly _tag: string;
          readonly error?: unknown;
        };
      }
    >();
    const calls: Array<{
      readonly commandId: string;
      readonly generation: number;
      readonly workId: string;
    }> = [];
    let committedWorkEffects = 0;

    const gateway = {
      execute: (envelope: GatewayEnvelope<unknown>, context: unknown) => {
        const commandId = String(envelope.commandId);
        const generation = Number(
          (context as { readonly fencingGeneration: number }).fencingGeneration,
        );
        const payload = envelope.payload as { readonly workId: string };
        calls.push({ commandId, generation, workId: payload.workId });
        const prior = receipts.get(commandId);
        if (prior !== undefined) return Effect.succeed(prior);

        if (generation === 0) {
          const rejected = {
            resolution: {
              _tag: "TerminalRejected" as const,
              error: { _tag: "FencingRejected" as const },
            },
          };
          receipts.set(commandId, rejected);
          return Effect.succeed(rejected);
        }

        committedWorkEffects += 1;
        const committed = {
          resolution: {
            _tag: "Committed" as const,
            result: {
              workId: parse(WorkId)(payload.workId),
              workspaceId,
            },
          },
        };
        receipts.set(commandId, committed);
        return Effect.succeed(committed);
      },
    } as unknown as CommandGatewayService;

    const handler = makeHandler(gateway);

    const oldOwner = await runHandler(handler, 0);
    expect(oldOwner._tag).toBe("Rejected");
    expect(receipts.size).toBe(1);
    expect([...receipts.values()][0]?.resolution).toMatchObject({
      _tag: "TerminalRejected",
      error: { _tag: "FencingRejected" },
    });

    const currentOwner = await runHandler(handler, 1);

    expect(currentOwner).toMatchObject({ _tag: "Accepted" });
    expect(calls.map((call) => call.generation)).toEqual([0, 1]);
    expect(calls[0]?.commandId).not.toBe(calls[1]?.commandId);
    expect(calls[0]?.workId).toBe(calls[1]?.workId);
    expect(receipts.size).toBe(2);
    expect(committedWorkEffects).toBe(1);
  });

  it("converges a prior Committed receipt before issuing a new-generation Command", async () => {
    const receipts = new Map<
      string,
      {
        readonly resolution: {
          readonly _tag: string;
          readonly result: {
            readonly workId: WorkId;
            readonly workspaceId: WorkspaceId;
          };
        };
      }
    >();
    const calls: Array<{
      readonly commandId: string;
      readonly generation: number;
    }> = [];
    let committedWorkEffects = 0;
    const gateway = {
      execute: (envelope: GatewayEnvelope<unknown>, context: unknown) => {
        const commandId = String(envelope.commandId);
        const generation = Number(
          (context as { readonly fencingGeneration: number }).fencingGeneration,
        );
        calls.push({ commandId, generation });
        const prior = receipts.get(commandId);
        if (prior !== undefined) return Effect.succeed(prior);
        committedWorkEffects += 1;
        const payload = envelope.payload as { readonly workId: WorkId };
        const committed = {
          resolution: {
            _tag: "Committed" as const,
            result: { workId: payload.workId, workspaceId },
          },
        };
        receipts.set(commandId, committed);
        return Effect.succeed(committed);
      },
    } as unknown as CommandGatewayService;
    const handler = makeHandler(gateway);

    expect(await runHandler(handler, 0)).toMatchObject({ _tag: "Accepted" });
    // The old owner crashed after the canonical Command committed but before
    // the AgentLoop action disposition was persisted; the action is Pending.
    expect(await runHandler(handler, 1)).toMatchObject({ _tag: "Accepted" });
    expect(calls.map((call) => call.generation)).toEqual([0]);
    expect(receipts.size).toBe(1);
    expect(committedWorkEffects).toBe(1);
  });
});
