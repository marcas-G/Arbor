import type {
  AgentActionHandler,
  AgentActionHandlerInput,
} from "@arbor/agent-runtime";
import type {
  CommandGatewayService,
  GatewayEnvelope,
} from "@arbor/application";
import { newUuid7 } from "@arbor/application";
import {
  CommandId,
  DecisionId,
  ExecutionId,
  type LeaseGeneration,
  MessageId,
  Principal,
  ProjectId,
  parse,
  SessionId,
  VerificationId,
  WorkId,
  WorkRevision,
  WorkspaceId,
} from "@arbor/domain";
import type {
  ClockService,
  CommandStoreService,
  DecisionRequestStoreService,
  TransactionPortService,
  WorkspaceRepositoryService,
} from "@arbor/ports";
import { sha256Hex } from "@arbor/ports";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  assignWorkHandler,
  makeSingleWorkspaceControlActionHandlers,
  produceDeliverableHandler,
  selectCurrentWorkHandler,
} from "../src/control-actions.js";

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

const decisionId = parse(DecisionId)(
  "dec_018f2b3c-4d5e-7abc-8def-0123456789a7",
);
const decisionWorkId = parse(WorkId)(
  "wrk_018f2b3c-4d5e-7abc-8def-0123456789a8",
);
const decisionExecution = {
  executionId,
  projectId,
  workspaceId,
  sessionId,
  admittedAt: "2026-10-05T00:00:00.000Z",
  stopRequestedAt: null,
  state: { status: "Active", settlement: null },
  binding: {
    _tag: "WorkspaceExecution" as const,
    workspaceId,
    episode: {
      _tag: "DecisionEpisode" as const,
      decisionId,
      decisionKind: "SelectCurrentWork" as const,
      requestRevision: 0,
    },
  },
} as never;
const decisionAction = {
  _tag: "SelectCurrentWork" as const,
  workId: decisionWorkId,
};
const decisionInvocation = {
  providerTurnId: "ptn_018f2b3c-4d5e-7abc-8def-0123456789b1" as never,
  outputPosition: 0,
  callRef: "call-ah10-select-current-work",
  toolName: "select_current_work",
  argumentsJson: JSON.stringify(decisionAction),
};
const legacySelectCommandId = parse(CommandId)(
  `cmd_${String(decisionId).slice("dec_".length)}`,
);

interface DecisionHarnessState {
  request: {
    readonly decisionId: typeof decisionId;
    readonly workspaceId: typeof workspaceId;
    readonly candidateWorkIds: ReadonlyArray<WorkId>;
    readonly workspaceRevision: number;
    readonly state:
      | { readonly _tag: "Pending" }
      | { readonly _tag: "Submitted"; readonly selectedWorkId: WorkId };
    readonly revision: number;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  currentWorkId: WorkId | null;
  workspaceRevision: number;
  submitCalls: number;
}

const makeDecisionHarnessState = (
  state: DecisionHarnessState["request"]["state"] = { _tag: "Pending" },
  workspaceRevision = 5,
): DecisionHarnessState => ({
  request: {
    decisionId,
    workspaceId,
    candidateWorkIds: [decisionWorkId],
    workspaceRevision,
    state,
    revision: state._tag === "Submitted" ? 1 : 0,
    createdAt: "2026-10-05T00:00:00.000Z",
    updatedAt: "2026-10-05T00:00:00.000Z",
  },
  currentWorkId: null,
  workspaceRevision,
  submitCalls: 0,
});

const makeSelectCurrentWorkHandler = (
  gateway: CommandGatewayService,
  receipts: ReadonlyMap<string, unknown>,
  state: DecisionHarnessState,
) =>
  selectCurrentWorkHandler({
    gateway,
    commandReceipts: receiptLookup(receipts),
    decisions: {
      findById: () => Effect.succeed(Option.some(state.request)),
      submit: (input: Parameters<DecisionRequestStoreService["submit"]>[0]) => {
        state.submitCalls += 1;
        if (
          state.request.state._tag === "Pending" &&
          state.request.revision === input.expectedRevision
        ) {
          state.request = {
            ...state.request,
            state: { _tag: "Submitted", selectedWorkId: input.selectedWorkId },
            revision: state.request.revision + 1,
            updatedAt: input.updatedAt,
          };
        }
        return Effect.void;
      },
    } as unknown as DecisionRequestStoreService,
    workspaces: {
      findById: () =>
        Effect.succeed(
          Option.some({
            workspaceId,
            projectId,
            currentWorkId: state.currentWorkId,
            revision: state.workspaceRevision,
            lifecycle: "Active",
          } as never),
        ),
    } as unknown as WorkspaceRepositoryService,
    tx: transaction,
    clock: {
      now: () => Effect.succeed("2026-10-05T00:00:00.000Z"),
    } as ClockService,
  } as never);

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

const transaction = {
  transact: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
} as TransactionPortService;

const receiptLookup = (receipts: ReadonlyMap<string, unknown>) =>
  ({
    findResolution: (commandId: string) => {
      const receipt = receipts.get(String(commandId));
      return Effect.succeed(
        receipt === undefined
          ? Option.none()
          : Option.some({
              commandId,
              projectId,
              ...(receipt as object),
            } as never),
      );
    },
  }) as Pick<CommandStoreService, "findResolution">;

const runControlHandler = (
  handler: AgentActionHandler,
  handlerAction: unknown,
  generation: number,
  handlerInvocation = invocation,
  handlerExecution: unknown = execution,
) =>
  Effect.runPromise(
    Effect.match(
      handler.handle({
        action: handlerAction,
        invocation: handlerInvocation,
        execution: handlerExecution,
        context: generationContext(generation),
      } as AgentActionHandlerInput),
      {
        onFailure: (cause) => ({ _tag: "Rejected" as const, cause }),
        onSuccess: (outcome) => ({ _tag: "Accepted" as const, outcome }),
      },
    ),
  );

const consumerWork = {
  workId: parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789a3"),
  projectId,
  workspaceId,
  lifecycle: "Open",
  revision: parse(WorkRevision)(0),
} as {
  readonly workId: WorkId;
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly lifecycle: "Open";
  readonly revision: WorkRevision;
};

const dependencyAction = {
  _tag: "DeclareDependency" as const,
  producerBinding: { _tag: "AnyProducer" as const },
  expectedDeliverable: { kind: "report", requiredArtifactRoles: [] },
};

const dependencyInvocation = {
  ...invocation,
  toolName: "declare_dependency",
  argumentsJson: JSON.stringify(dependencyAction),
};

const childWorkspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a2",
);
const sendAction = {
  _tag: "SendMessage" as const,
  kind: "Query" as const,
  body: "AH10 pinned message body",
  recipientWorkspaceId: childWorkspaceId,
};
const sendInvocation = {
  ...invocation,
  toolName: "send_message",
  argumentsJson: JSON.stringify(sendAction),
};
const queryMessageId = parse(MessageId)(
  "msg_018f2b3c-4d5e-7abc-8def-0123456789a5",
);
const replyCorrelationId = "cor_018f2b3c-4d5e-7abc-8def-0123456789a6";
const replyAction = {
  _tag: "SendMessage" as const,
  kind: "Reply" as const,
  body: "AH10 reply to the pinned query",
  queryMessageId,
};
const replyInvocation = {
  ...invocation,
  toolName: "send_message",
  argumentsJson: JSON.stringify(replyAction),
};
const acceptanceWork = {
  workId: parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789a4"),
  projectId,
  workspaceId: childWorkspaceId,
  lifecycle: "Open",
  revision: parse(WorkRevision)(0),
} as {
  readonly workId: WorkId;
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly lifecycle: "Open";
  readonly revision: WorkRevision;
};
const acceptanceWorkId = acceptanceWork.workId as WorkId;
const verificationId = parse(VerificationId)(
  "ver_018f2b3c-4d5e-7abc-8def-0123456789a3",
);
const acceptAction = {
  _tag: "AcceptResult" as const,
  resultRef: `rref_${sha256Hex(
    JSON.stringify({
      parentWorkspaceId: workspaceId,
      childWorkspaceId,
      workId: acceptanceWorkId,
      workRevision: 0,
      verificationId,
    }),
  )}`,
};
const acceptInvocation = {
  ...invocation,
  toolName: "accept_result",
  argumentsJson: JSON.stringify(acceptAction),
};

const actionHandlerFromRegistry = (
  action: "AcceptResult" | "DeclareDependency" | "SendMessage",
  gateway: CommandGatewayService,
  receipts: ReadonlyMap<string, unknown>,
  dependencyRows: ReadonlyMap<string, unknown> = new Map(),
  resolveResult: () => Option.Option<{
    readonly childWorkspaceId: WorkspaceId;
    readonly workId: WorkId;
    readonly workRevision: WorkRevision;
    readonly verificationId: VerificationId;
  }> = () =>
    Option.some({
      childWorkspaceId,
      workId: acceptanceWorkId,
      workRevision: parse(WorkRevision)(0),
      verificationId,
    }),
  acceptanceRows: ReadonlyMap<string, unknown> = new Map(),
  messageRows: ReadonlyMap<string, unknown> = new Map(),
  closedCorrelations: ReadonlySet<string> = new Set(),
) => {
  const blobBytes = new Map<string, Uint8Array>();
  const handlers = makeSingleWorkspaceControlActionHandlers({
    gateway,
    commandReceipts: receiptLookup(receipts),
    tx: transaction,
    clock: {
      now: () => Effect.succeed("2026-10-05T00:00:00.000Z"),
    },
    works: {
      findById: (workId: WorkId) =>
        Effect.succeed(
          Option.some(
            workId === acceptanceWorkId ? acceptanceWork : consumerWork,
          ),
        ),
    },
    dependencyRecords: {
      findById: (dependencyId: string) =>
        Effect.succeed(
          Option.fromNullishOr(dependencyRows.get(String(dependencyId))),
        ),
    },
    acceptances: {
      findByWorkRevision: (workId: WorkId, workRevision: number) =>
        Effect.succeed(
          Option.fromNullishOr(acceptanceRows.get(`${workId}:${workRevision}`)),
        ),
    },
    messages: {
      findById: (messageId: MessageId) =>
        Effect.succeed(
          Option.fromNullishOr(messageRows.get(String(messageId))),
        ),
      listByRecipient: (recipientWorkspaceId: WorkspaceId) =>
        Effect.succeed(
          [...messageRows.values()].filter(
            (record) =>
              (
                record as {
                  readonly message?: { readonly recipientWorkspaceId?: string };
                }
              ).message?.recipientWorkspaceId === recipientWorkspaceId,
          ) as never,
        ),
      isCorrelationClosed: (correlationId: string) =>
        Effect.succeed(closedCorrelations.has(correlationId)),
    },
    blobs: {
      put: (bytes: Uint8Array) => {
        const ref = `blob_${sha256Hex(new TextDecoder().decode(bytes))}`;
        blobBytes.set(ref, bytes);
        return Effect.succeed(ref as never);
      },
      get: (ref: string) =>
        Effect.succeed(blobBytes.get(String(ref)) ?? new Uint8Array()),
    },
    proposals: {},
    inbox: {},
    decisions: undefined,
    plans: undefined,
    waits: undefined,
    deliverables: undefined,
    journal: undefined,
    ids: undefined,
    placement: {
      resolveResultRef: () => Effect.succeed(resolveResult()),
      resolveChildRef: () => Effect.succeed(Option.some(childWorkspaceId)),
      list: () => Effect.succeed({} as never),
      read: () => Effect.succeed(Option.none()),
    },
    workspaces: {
      findById: (workspaceId: WorkspaceId) =>
        Effect.succeed(
          Option.some({
            workspaceId,
            projectId,
            parentWorkspaceId:
              workspaceId === childWorkspaceId ? workspaceId : null,
            lifecycle: "Active",
          } as never),
        ),
      listActiveChildren: () => Effect.succeed([]),
    },
  } as never);
  const handler = handlers.find((candidate) => candidate.action === action);
  if (handler === undefined) throw new Error(`missing ${action} handler`);
  return handler;
};

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

const makeHandler = (
  gateway: CommandGatewayService,
  receipts: ReadonlyMap<string, unknown>,
) =>
  assignWorkHandler({
    gateway,
    commandReceipts: {
      findResolution: (commandId) => {
        const receipt = receipts.get(String(commandId));
        return Effect.succeed(
          receipt === undefined
            ? Option.none()
            : Option.some({
                commandId,
                projectId,
                ...(receipt as object),
              } as never),
        );
      },
    } as Pick<CommandStoreService, "findResolution">,
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
    tx: transaction,
  });

describe("AH10 receipt-first generation takeover for a pinned AssignWork", () => {
  it("rejects a model-authored raw direct-child WorkspaceId instead of committing without a P33 binding", async () => {
    const child = childWorkspaceId;
    const gatewayCalls: Array<GatewayEnvelope<unknown>> = [];
    const gateway = {
      execute: (envelope: GatewayEnvelope<unknown>) => {
        gatewayCalls.push(envelope);
        const payload = envelope.payload as {
          readonly workId: string;
          readonly workspaceId: string;
        };
        return Effect.succeed({
          resolution: {
            _tag: "Committed" as const,
            result: {
              workId: parse(WorkId)(payload.workId),
              workspaceId: parse(WorkspaceId)(payload.workspaceId),
            },
          },
        });
      },
    } as unknown as CommandGatewayService;
    const handler = assignWorkHandler({
      gateway,
      workspaces: {
        findById: (id: WorkspaceId) =>
          Effect.succeed(
            Option.some({
              workspaceId: id,
              projectId,
              parentWorkspaceId: id === child ? workspaceId : null,
              lifecycle: "Active",
              revision: 3,
            } as never),
          ),
      } as unknown as WorkspaceRepositoryService,
      clock: {
        now: () => Effect.succeed("2026-10-05T00:00:00.000Z"),
      } as ClockService,
      tx: transaction,
    });
    const result = await runControlHandler(
      handler,
      { ...action, targetWorkspaceId: child },
      0,
      {
        ...invocation,
        providerTurnId: "ptn_018f2b3c-4d5e-7abc-8def-0123456789b5" as never,
      },
    );
    expect(result._tag).toBe("Rejected");
    expect(gatewayCalls).toHaveLength(0);
    const currentWorkspaceResult = await runControlHandler(
      handler,
      { ...action, targetWorkspaceId: workspaceId },
      0,
      {
        ...invocation,
        providerTurnId: "ptn_018f2b3c-4d5e-7abc-8def-0123456789b6" as never,
      },
    );
    expect(currentWorkspaceResult._tag).toBe("Accepted");
    expect(gatewayCalls).toHaveLength(1);
  });

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

    const handler = makeHandler(gateway, receipts);

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
    const handler = makeHandler(gateway, receipts);

    expect(await runHandler(handler, 0)).toMatchObject({ _tag: "Accepted" });
    // The old owner crashed after the canonical Command committed but before
    // the AgentLoop action disposition was persisted; the action is Pending.
    expect(await runHandler(handler, 1)).toMatchObject({ _tag: "Accepted" });
    expect(calls.map((call) => call.generation)).toEqual([0]);
    expect(receipts.size).toBe(1);
    expect(committedWorkEffects).toBe(1);
  });

  it("fails closed when a prior Committed receipt points to another Workspace", async () => {
    const occurrence = `${invocation.providerTurnId}:${invocation.outputPosition}`;
    const priorCommandId = parse(CommandId)(
      `cmd_${newUuid7("assign-work-command", occurrence)}`,
    );
    const workId = parse(WorkId)(`wrk_${newUuid7("assign-work", occurrence)}`);
    const wrongWorkspaceId = parse(WorkspaceId)(
      "ws_018f2b3c-4d5e-7abc-8def-0123456789a9",
    );
    const receipts = new Map<string, unknown>([
      [
        String(priorCommandId),
        {
          resolution: {
            _tag: "Committed",
            result: { workId, workspaceId: wrongWorkspaceId },
          },
        },
      ],
    ]);
    let gatewayCalls = 0;
    const gateway = {
      execute: () => {
        gatewayCalls += 1;
        return Effect.die("receipt mismatch must not submit another command");
      },
    } as unknown as CommandGatewayService;

    const result = await runHandler(makeHandler(gateway, receipts), 1);

    expect(result).toMatchObject({
      _tag: "Rejected",
      cause: { _tag: "AgentActionOperationalFailure" },
    });
    expect(gatewayCalls).toBe(0);
  });

  it("does not treat an older domain rejection as takeover eligibility", async () => {
    const receipts = new Map<string, unknown>();
    const calls: string[] = [];
    const gateway = {
      execute: (envelope: GatewayEnvelope<unknown>) => {
        const commandId = String(envelope.commandId);
        calls.push(commandId);
        const rejected = {
          resolution: {
            _tag: "TerminalRejected" as const,
            error: { _tag: "WorkspaceNotFound" as const },
          },
        };
        receipts.set(commandId, rejected);
        return Effect.succeed(rejected);
      },
    } as unknown as CommandGatewayService;
    const handler = makeHandler(gateway, receipts);

    expect(await runHandler(handler, 0)).toMatchObject({ _tag: "Rejected" });
    expect(await runHandler(handler, 1)).toMatchObject({ _tag: "Rejected" });
    expect(calls).toHaveLength(1);
  });
});

describe("AH10 takeover for another canonical control action", () => {
  it("uses a new generation CommandId after a prior ProduceDeliverable fence rejection", async () => {
    const receipts = new Map<string, unknown>();
    const calls: Array<{
      readonly commandId: string;
      readonly generation: number;
    }> = [];
    const gateway = {
      execute: (envelope: GatewayEnvelope<unknown>, context: unknown) => {
        const commandId = String(envelope.commandId);
        const generation = Number(
          (context as { readonly fencingGeneration: number }).fencingGeneration,
        );
        calls.push({ commandId, generation });
        const prior = receipts.get(commandId);
        if (prior !== undefined) return Effect.succeed(prior);
        const resolution =
          generation === 0
            ? {
                _tag: "TerminalRejected" as const,
                error: { _tag: "FencingRejected" as const },
              }
            : {
                _tag: "Committed" as const,
                result: {
                  deliverableId: (
                    envelope.payload as { readonly deliverableId: string }
                  ).deliverableId,
                  sourceWorkId: (
                    envelope.payload as { readonly sourceWorkId: string }
                  ).sourceWorkId,
                  sourceWorkRevision: (
                    envelope.payload as {
                      readonly observedSourceWorkRevision: number;
                    }
                  ).observedSourceWorkRevision,
                  kind: (envelope.payload as { readonly kind: string }).kind,
                  artifactRoles: [],
                },
              };
        const rejected = {
          resolution: {
            ...resolution,
          },
        };
        receipts.set(commandId, rejected);
        return Effect.succeed(rejected);
      },
    } as unknown as CommandGatewayService;
    const handler = produceDeliverableHandler({
      gateway,
      tx: transaction,
      commandReceipts: {
        findResolution: (commandId) => {
          const receipt = receipts.get(String(commandId));
          return Effect.succeed(
            receipt === undefined
              ? Option.none()
              : Option.some({
                  commandId,
                  projectId,
                  ...(receipt as object),
                } as never),
          );
        },
      } as Pick<CommandStoreService, "findResolution">,
      clock: {
        now: () => Effect.succeed("2026-10-05T00:00:00.000Z"),
      } as ClockService,
    });
    const produceAction = {
      _tag: "ProduceDeliverable" as const,
      kind: "Report",
      artifacts: [],
    };
    const run = (generation: number) =>
      Effect.runPromise(
        Effect.match(
          handler.handle({
            action: produceAction,
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

    expect((await run(0))._tag).toBe("Rejected");
    expect((await run(1))._tag).toBe("Accepted");
    expect(calls.map((call) => call.generation)).toEqual([0, 1]);
    expect(calls[0]?.commandId).not.toBe(calls[1]?.commandId);
  });

  it("converges an older committed ProduceDeliverable receipt without another command", async () => {
    const receipts = new Map<string, unknown>();
    const calls: string[] = [];
    const gateway = {
      execute: (envelope: GatewayEnvelope<unknown>) => {
        const commandId = String(envelope.commandId);
        calls.push(commandId);
        const payload = envelope.payload as {
          readonly deliverableId: string;
          readonly sourceWorkId: string;
          readonly observedSourceWorkRevision: number;
          readonly kind: string;
        };
        const committed = {
          resolution: {
            _tag: "Committed" as const,
            result: {
              deliverableId: payload.deliverableId,
              sourceWorkId: payload.sourceWorkId,
              sourceWorkRevision: payload.observedSourceWorkRevision,
              kind: payload.kind,
              artifactRoles: [],
            },
          },
        };
        receipts.set(commandId, committed);
        return Effect.succeed(committed);
      },
    } as unknown as CommandGatewayService;
    const handler = produceDeliverableHandler({
      gateway,
      tx: transaction,
      commandReceipts: {
        findResolution: (commandId) => {
          const receipt = receipts.get(String(commandId));
          return Effect.succeed(
            receipt === undefined
              ? Option.none()
              : Option.some({
                  commandId,
                  projectId,
                  ...(receipt as object),
                } as never),
          );
        },
      } as Pick<CommandStoreService, "findResolution">,
      clock: {
        now: () => Effect.succeed("2026-10-05T00:00:00.000Z"),
      } as ClockService,
    });
    const produceAction = {
      _tag: "ProduceDeliverable" as const,
      kind: "Report",
      artifacts: [],
    };
    const run = (generation: number) =>
      Effect.runPromise(
        Effect.match(
          handler.handle({
            action: produceAction,
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

    expect(await run(0)).toMatchObject({ _tag: "Accepted" });
    expect(await run(1)).toMatchObject({ _tag: "Accepted" });
    expect(calls).toHaveLength(1);
  });
});

describe("AH10 receipt-first DeclareDependency takeover", () => {
  const makeDependencyHandler = (
    gateway: CommandGatewayService,
    receipts: ReadonlyMap<string, unknown>,
    dependencyRows: ReadonlyMap<string, unknown>,
  ) =>
    actionHandlerFromRegistry(
      "DeclareDependency",
      gateway,
      receipts,
      dependencyRows,
    );

  it("uses a new CommandId after gen0 FencingRejected", async () => {
    const receipts = new Map<string, unknown>();
    const dependencyRows = new Map<string, unknown>();
    const calls: Array<{
      readonly commandId: string;
      readonly generation: number;
    }> = [];
    const gateway = {
      execute: (envelope: GatewayEnvelope<unknown>, context: unknown) => {
        const commandId = String(envelope.commandId);
        const generation = Number(
          (context as { readonly fencingGeneration: number }).fencingGeneration,
        );
        calls.push({ commandId, generation });
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
        const payload = envelope.payload as {
          readonly dependencyId: string;
          readonly consumerWorkId: string;
          readonly producerBinding: unknown;
          readonly expectedDeliverable: unknown;
          readonly revision: number;
        };
        dependencyRows.set(payload.dependencyId, {
          dependencyId: payload.dependencyId,
          consumerWorkId: payload.consumerWorkId,
          producerBinding: payload.producerBinding,
          expectedDeliverable: payload.expectedDeliverable,
          revision: payload.revision,
          state: "Unsatisfied",
          satisfiedByDeliverableId: null,
          satisfiedAtDependencyRevision: null,
        });
        const committed = {
          resolution: {
            _tag: "Committed" as const,
            result: {
              dependencyId: payload.dependencyId,
              consumerWorkId: payload.consumerWorkId,
              state: "Unsatisfied" as const,
              revision: payload.revision,
            },
          },
        };
        receipts.set(commandId, committed);
        return Effect.succeed(committed);
      },
    } as unknown as CommandGatewayService;
    const handler = makeDependencyHandler(gateway, receipts, dependencyRows);

    await runControlHandler(handler, dependencyAction, 0, dependencyInvocation);
    const currentOwner = await runControlHandler(
      handler,
      dependencyAction,
      1,
      dependencyInvocation,
    );

    expect(currentOwner._tag).toBe("Accepted");
    expect(calls.map((call) => call.generation)).toEqual([0, 1]);
    expect(calls[0]?.commandId).not.toBe(calls[1]?.commandId);
    expect(calls[0]?.commandId).toBe(
      `cmd_${newUuid7(
        "declare-dependency-command",
        `${dependencyInvocation.providerTurnId}:${dependencyInvocation.outputPosition}`,
      )}`,
    );
  });

  it("converges a prior Committed dependency row without sending another command", async () => {
    const receipts = new Map<string, unknown>();
    const dependencyRows = new Map<string, unknown>();
    const calls: string[] = [];
    const gateway = {
      execute: (envelope: GatewayEnvelope<unknown>) => {
        const commandId = String(envelope.commandId);
        calls.push(commandId);
        const payload = envelope.payload as {
          readonly dependencyId: string;
          readonly consumerWorkId: string;
          readonly producerBinding: unknown;
          readonly expectedDeliverable: unknown;
          readonly revision: number;
        };
        dependencyRows.set(payload.dependencyId, {
          dependencyId: payload.dependencyId,
          consumerWorkId: payload.consumerWorkId,
          producerBinding: payload.producerBinding,
          expectedDeliverable: payload.expectedDeliverable,
          revision: payload.revision,
          state: "Unsatisfied",
          satisfiedByDeliverableId: null,
          satisfiedAtDependencyRevision: null,
        });
        const committed = {
          resolution: {
            _tag: "Committed" as const,
            result: {
              dependencyId: payload.dependencyId,
              consumerWorkId: payload.consumerWorkId,
              state: "Unsatisfied" as const,
              revision: payload.revision,
            },
          },
        };
        receipts.set(commandId, committed);
        return Effect.succeed(committed);
      },
    } as unknown as CommandGatewayService;
    const handler = makeDependencyHandler(gateway, receipts, dependencyRows);

    await runControlHandler(handler, dependencyAction, 0, dependencyInvocation);
    const dependencyId = [...dependencyRows.keys()][0];
    if (dependencyId === undefined)
      throw new Error("missing committed Dependency");
    dependencyRows.set(dependencyId, {
      ...(dependencyRows.get(dependencyId) as object),
      state: "Satisfied",
    });
    const converged = await runControlHandler(
      handler,
      dependencyAction,
      1,
      dependencyInvocation,
    );

    expect(converged).toMatchObject({
      _tag: "Accepted",
      outcome: {
        _tag: "Observation",
        observation: {
          text: `DependencyDeclared(${dependencyId}, Unsatisfied)`,
        },
      },
    });
    expect(calls).toHaveLength(1);
  });

  it("fails closed when a Committed receipt has no canonical Dependency row", async () => {
    const receipts = new Map<string, unknown>();
    const calls: string[] = [];
    const gateway = {
      execute: (envelope: GatewayEnvelope<unknown>) => {
        const commandId = String(envelope.commandId);
        calls.push(commandId);
        const payload = envelope.payload as {
          readonly dependencyId: string;
          readonly consumerWorkId: string;
          readonly revision: number;
        };
        const committed = {
          resolution: {
            _tag: "Committed" as const,
            result: {
              dependencyId: payload.dependencyId,
              consumerWorkId: payload.consumerWorkId,
              state: "Unsatisfied" as const,
              revision: payload.revision,
            },
          },
        };
        receipts.set(commandId, committed);
        return Effect.succeed(committed);
      },
    } as unknown as CommandGatewayService;
    const handler = makeDependencyHandler(gateway, receipts, new Map());

    await runControlHandler(handler, dependencyAction, 0, dependencyInvocation);
    const takeover = await runControlHandler(
      handler,
      dependencyAction,
      1,
      dependencyInvocation,
    );

    expect(takeover._tag).toBe("Rejected");
    expect(calls).toHaveLength(1);
  });

  it("does not retry an older non-fencing terminal rejection", async () => {
    const receipts = new Map<string, unknown>();
    const calls: string[] = [];
    const gateway = {
      execute: (envelope: GatewayEnvelope<unknown>) => {
        const commandId = String(envelope.commandId);
        calls.push(commandId);
        const rejected = {
          resolution: {
            _tag: "TerminalRejected" as const,
            error: { _tag: "RevisionConflict" as const },
          },
        };
        receipts.set(commandId, rejected);
        return Effect.succeed(rejected);
      },
    } as unknown as CommandGatewayService;
    const handler = makeDependencyHandler(gateway, receipts, new Map());

    await runControlHandler(handler, dependencyAction, 0, dependencyInvocation);
    await runControlHandler(handler, dependencyAction, 1, dependencyInvocation);

    expect(calls).toHaveLength(1);
  });
});

describe("AH10 receipt-first AcceptResult takeover", () => {
  it("uses a new CommandId after gen0 FencingRejected", async () => {
    const receipts = new Map<string, unknown>();
    const calls: Array<{
      readonly commandId: string;
      readonly generation: number;
    }> = [];
    const gateway = {
      execute: (envelope: GatewayEnvelope<unknown>, context: unknown) => {
        const commandId = String(envelope.commandId);
        const generation = Number(
          (context as { readonly fencingGeneration: number }).fencingGeneration,
        );
        calls.push({ commandId, generation });
        const prior = receipts.get(commandId);
        if (prior !== undefined) return Effect.succeed(prior);
        const resolution =
          generation === 0
            ? {
                _tag: "TerminalRejected" as const,
                error: { _tag: "FencingRejected" as const },
              }
            : {
                _tag: "Committed" as const,
                result: envelope.payload,
              };
        const receipt = { resolution };
        receipts.set(commandId, receipt);
        return Effect.succeed(receipt);
      },
    } as unknown as CommandGatewayService;
    const handler = actionHandlerFromRegistry(
      "AcceptResult",
      gateway,
      receipts,
    );

    await runControlHandler(handler, acceptAction, 0, acceptInvocation);
    const currentOwner = await runControlHandler(
      handler,
      acceptAction,
      1,
      acceptInvocation,
    );

    expect(currentOwner._tag).toBe("Accepted");
    expect(calls.map((call) => call.generation)).toEqual([0, 1]);
    expect(calls[0]?.commandId).not.toBe(calls[1]?.commandId);
    expect(calls[0]?.commandId).toBe(
      `cmd_${newUuid7(
        "accept-child-result-command",
        `${acceptInvocation.providerTurnId}:${acceptInvocation.outputPosition}`,
      )}`,
    );
  });

  it("converges a prior Committed acceptance after the result ref is no longer ready", async () => {
    const receipts = new Map<string, unknown>();
    const acceptanceRows = new Map<string, unknown>();
    const calls: string[] = [];
    let resolved = true;
    const gateway = {
      execute: (envelope: GatewayEnvelope<unknown>) => {
        const commandId = String(envelope.commandId);
        calls.push(commandId);
        const committed = {
          resolution: {
            _tag: "Committed" as const,
            result: envelope.payload,
          },
        };
        const result = envelope.payload as {
          readonly acceptanceId: string;
          readonly workId: string;
          readonly targetWorkRevision: number;
          readonly verificationId: string;
        };
        acceptanceRows.set(`${result.workId}:${result.targetWorkRevision}`, {
          ...result,
          actor: "worker:ah10",
          acceptedAt: "2026-10-05T00:00:00.000Z",
        });
        receipts.set(commandId, committed);
        resolved = false;
        return Effect.succeed(committed);
      },
    } as unknown as CommandGatewayService;
    const handler = actionHandlerFromRegistry(
      "AcceptResult",
      gateway,
      receipts,
      new Map(),
      () =>
        resolved
          ? Option.some({
              childWorkspaceId,
              workId: acceptanceWorkId,
              workRevision: parse(WorkRevision)(0),
              verificationId,
            })
          : Option.none(),
      acceptanceRows,
    );

    await runControlHandler(handler, acceptAction, 0, acceptInvocation);
    const converged = await runControlHandler(
      handler,
      acceptAction,
      1,
      acceptInvocation,
    );

    expect(converged).toMatchObject({
      _tag: "Accepted",
      outcome: { _tag: "Observation" },
    });
    expect(calls).toHaveLength(1);
  });

  it("fails closed when a Committed receipt has no canonical Acceptance row", async () => {
    const receipts = new Map<string, unknown>();
    const calls: string[] = [];
    let resolved = true;
    const gateway = {
      execute: (envelope: GatewayEnvelope<unknown>) => {
        const commandId = String(envelope.commandId);
        calls.push(commandId);
        const committed = {
          resolution: {
            _tag: "Committed" as const,
            result: envelope.payload,
          },
        };
        receipts.set(commandId, committed);
        resolved = false;
        return Effect.succeed(committed);
      },
    } as unknown as CommandGatewayService;
    const handler = actionHandlerFromRegistry(
      "AcceptResult",
      gateway,
      receipts,
      new Map(),
      () =>
        resolved
          ? Option.some({
              childWorkspaceId,
              workId: acceptanceWorkId,
              workRevision: parse(WorkRevision)(0),
              verificationId,
            })
          : Option.none(),
      new Map(),
    );

    await runControlHandler(handler, acceptAction, 0, acceptInvocation);
    const takeover = await runControlHandler(
      handler,
      acceptAction,
      1,
      acceptInvocation,
    );

    expect(takeover._tag).toBe("Rejected");
    expect(calls).toHaveLength(1);
  });

  it("does not retry an older non-fencing terminal rejection", async () => {
    const receipts = new Map<string, unknown>();
    const calls: string[] = [];
    const gateway = {
      execute: (envelope: GatewayEnvelope<unknown>) => {
        const commandId = String(envelope.commandId);
        calls.push(commandId);
        const rejected = {
          resolution: {
            _tag: "TerminalRejected" as const,
            error: { _tag: "VerificationAcceptanceMismatch" as const },
          },
        };
        receipts.set(commandId, rejected);
        return Effect.succeed(rejected);
      },
    } as unknown as CommandGatewayService;
    const handler = actionHandlerFromRegistry(
      "AcceptResult",
      gateway,
      receipts,
    );

    await runControlHandler(handler, acceptAction, 0, acceptInvocation);
    await runControlHandler(handler, acceptAction, 1, acceptInvocation);

    expect(calls).toHaveLength(1);
  });
});

describe("AH10 receipt-first SendMessage takeover", () => {
  it("uses a new CommandId after gen0 FencingRejected while keeping message and correlation ids", async () => {
    const receipts = new Map<string, unknown>();
    const messageRows = new Map<string, unknown>();
    const calls: Array<{
      readonly commandId: string;
      readonly generation: number;
      readonly messageId: string;
      readonly correlationId: string | undefined;
    }> = [];
    const gateway = {
      execute: (envelope: GatewayEnvelope<unknown>, context: unknown) => {
        const commandId = String(envelope.commandId);
        const generation = Number(
          (context as { readonly fencingGeneration: number }).fencingGeneration,
        );
        const payload = envelope.payload as {
          readonly messageId: string;
          readonly senderWorkspaceId: WorkspaceId;
          readonly message: {
            readonly kind: string;
            readonly recipientWorkspaceId: WorkspaceId;
            readonly bodyRef: string;
            readonly urgency: string;
            readonly correlationId?: string;
          };
        };
        calls.push({
          commandId,
          generation,
          messageId: payload.messageId,
          correlationId: payload.message.correlationId,
        });
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
        messageRows.set(payload.messageId, {
          messageId: payload.messageId,
          senderWorkspaceId: payload.senderWorkspaceId,
          message: payload.message,
          sentAt: "2026-10-05T00:00:00.000Z",
        });
        const committed = {
          resolution: {
            _tag: "Committed" as const,
            result: { messageId: payload.messageId, admitted: true },
          },
        };
        receipts.set(commandId, committed);
        return Effect.succeed(committed);
      },
    } as unknown as CommandGatewayService;
    const handler = actionHandlerFromRegistry(
      "SendMessage",
      gateway,
      receipts,
      new Map(),
      undefined,
      new Map(),
      messageRows,
    );

    await runControlHandler(handler, sendAction, 0, sendInvocation);
    const currentOwner = await runControlHandler(
      handler,
      sendAction,
      1,
      sendInvocation,
    );

    expect(currentOwner._tag).toBe("Accepted");
    expect(calls.map((call) => call.generation)).toEqual([0, 1]);
    expect(calls[0]?.commandId).not.toBe(calls[1]?.commandId);
    expect(calls[0]?.messageId).toBe(calls[1]?.messageId);
    expect(calls[0]?.correlationId).toBe(calls[1]?.correlationId);
    expect(calls[0]?.commandId).toBe(
      `cmd_${newUuid7(
        "send-message-command",
        `${sendInvocation.providerTurnId}:${sendInvocation.outputPosition}`,
      )}`,
    );
  });

  it("converges a prior Committed message using the canonical MessageStore row", async () => {
    const receipts = new Map<string, unknown>();
    const messageRows = new Map<string, unknown>();
    const calls: string[] = [];
    const gateway = {
      execute: (envelope: GatewayEnvelope<unknown>) => {
        const commandId = String(envelope.commandId);
        calls.push(commandId);
        const payload = envelope.payload as {
          readonly messageId: string;
          readonly senderWorkspaceId: WorkspaceId;
          readonly message: unknown;
        };
        messageRows.set(payload.messageId, {
          messageId: payload.messageId,
          senderWorkspaceId: payload.senderWorkspaceId,
          message: payload.message,
          sentAt: "2026-10-05T00:00:00.000Z",
        });
        const committed = {
          resolution: {
            _tag: "Committed" as const,
            result: { messageId: payload.messageId, admitted: true },
          },
        };
        receipts.set(commandId, committed);
        return Effect.succeed(committed);
      },
    } as unknown as CommandGatewayService;
    const handler = actionHandlerFromRegistry(
      "SendMessage",
      gateway,
      receipts,
      new Map(),
      undefined,
      new Map(),
      messageRows,
    );

    await runControlHandler(handler, sendAction, 0, sendInvocation);
    const converged = await runControlHandler(
      handler,
      sendAction,
      1,
      sendInvocation,
    );

    expect(converged).toMatchObject({
      _tag: "Accepted",
      outcome: { _tag: "Observation" },
    });
    expect(calls).toHaveLength(1);
  });

  it("converges a prior Committed Reply after its Query correlation is closed", async () => {
    const receipts = new Map<string, unknown>();
    const messageRows = new Map<string, unknown>([
      [
        String(queryMessageId),
        {
          messageId: queryMessageId,
          senderWorkspaceId: childWorkspaceId,
          message: {
            kind: "Query",
            recipientWorkspaceId: workspaceId,
            bodyRef: "blob_query",
            correlationId: replyCorrelationId,
            urgency: "Normal",
          },
          sentAt: "2026-10-05T00:00:00.000Z",
        },
      ],
    ]);
    const closedCorrelations = new Set<string>();
    const calls: string[] = [];
    const gateway = {
      execute: (envelope: GatewayEnvelope<unknown>) => {
        const commandId = String(envelope.commandId);
        calls.push(commandId);
        const payload = envelope.payload as {
          readonly messageId: string;
          readonly senderWorkspaceId: WorkspaceId;
          readonly message: { readonly correlationId?: string };
        };
        messageRows.set(payload.messageId, {
          messageId: payload.messageId,
          senderWorkspaceId: payload.senderWorkspaceId,
          message: payload.message,
          sentAt: "2026-10-05T00:00:00.000Z",
        });
        if (payload.message.correlationId !== undefined) {
          closedCorrelations.add(payload.message.correlationId);
        }
        const committed = {
          resolution: {
            _tag: "Committed" as const,
            result: { messageId: payload.messageId, admitted: true },
          },
        };
        receipts.set(commandId, committed);
        return Effect.succeed(committed);
      },
    } as unknown as CommandGatewayService;
    const handler = actionHandlerFromRegistry(
      "SendMessage",
      gateway,
      receipts,
      new Map(),
      undefined,
      new Map(),
      messageRows,
      closedCorrelations,
    );

    await runControlHandler(handler, replyAction, 0, replyInvocation);
    const converged = await runControlHandler(
      handler,
      replyAction,
      1,
      replyInvocation,
    );

    expect(converged._tag).toBe("Accepted");
    expect(calls).toHaveLength(1);
  });

  it("fails closed when a Committed receipt has no canonical MessageStore row", async () => {
    const receipts = new Map<string, unknown>();
    const calls: string[] = [];
    const gateway = {
      execute: (envelope: GatewayEnvelope<unknown>) => {
        const commandId = String(envelope.commandId);
        calls.push(commandId);
        const payload = envelope.payload as { readonly messageId: string };
        const committed = {
          resolution: {
            _tag: "Committed" as const,
            result: { messageId: payload.messageId, admitted: true },
          },
        };
        receipts.set(commandId, committed);
        return Effect.succeed(committed);
      },
    } as unknown as CommandGatewayService;
    const handler = actionHandlerFromRegistry("SendMessage", gateway, receipts);

    await runControlHandler(handler, sendAction, 0, sendInvocation);
    const takeover = await runControlHandler(
      handler,
      sendAction,
      1,
      sendInvocation,
    );

    expect(takeover._tag).toBe("Rejected");
    expect(calls).toHaveLength(1);
  });

  it("does not resend an older non-fencing terminal rejection", async () => {
    const receipts = new Map<string, unknown>();
    const calls: string[] = [];
    const gateway = {
      execute: (envelope: GatewayEnvelope<unknown>) => {
        const commandId = String(envelope.commandId);
        calls.push(commandId);
        const rejected = {
          resolution: {
            _tag: "TerminalRejected" as const,
            error: { _tag: "AuthorityDenied" as const, reason: "old denial" },
          },
        };
        receipts.set(commandId, rejected);
        return Effect.succeed(rejected);
      },
    } as unknown as CommandGatewayService;
    const handler = actionHandlerFromRegistry("SendMessage", gateway, receipts);

    await runControlHandler(handler, sendAction, 0, sendInvocation);
    await runControlHandler(handler, sendAction, 1, sendInvocation);

    expect(calls).toHaveLength(1);
  });
});

describe("AH10 receipt-first SelectCurrentWork takeover", () => {
  it("uses a new generation CommandId after gen0 FencingRejected and retains the legacy gen0 ID", async () => {
    const receipts = new Map<string, unknown>();
    const state = makeDecisionHarnessState();
    const calls: Array<{
      readonly commandId: string;
      readonly generation: number;
    }> = [];
    const gateway = {
      execute: (envelope: GatewayEnvelope<unknown>, context: unknown) => {
        const commandId = String(envelope.commandId);
        const generation = Number(
          (context as { readonly fencingGeneration: number }).fencingGeneration,
        );
        calls.push({ commandId, generation });
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
        const result = {
          workspaceId,
          workId: decisionWorkId,
          revision: state.workspaceRevision + 1,
        };
        state.currentWorkId = decisionWorkId;
        state.workspaceRevision = result.revision;
        const committed = {
          resolution: { _tag: "Committed" as const, result },
        };
        receipts.set(commandId, committed);
        return Effect.succeed(committed);
      },
    } as unknown as CommandGatewayService;
    const handler = makeSelectCurrentWorkHandler(gateway, receipts, state);

    expect(
      await runControlHandler(
        handler,
        decisionAction,
        0,
        decisionInvocation,
        decisionExecution,
      ),
    ).toMatchObject({ _tag: "Rejected" });
    const currentOwner = await runControlHandler(
      handler,
      decisionAction,
      1,
      decisionInvocation,
      decisionExecution,
    );

    expect(currentOwner._tag).toBe("Accepted");
    expect(calls.map((call) => call.generation)).toEqual([0, 1]);
    expect(calls[0]?.commandId).toBe(legacySelectCommandId);
    expect(calls[1]?.commandId).not.toBe(calls[0]?.commandId);
    expect(state.currentWorkId).toBe(decisionWorkId);
    expect(state.submitCalls).toBe(1);
  });

  it("converges a Committed receipt before DecisionRequest.submit without resending the command", async () => {
    const receipts = new Map<string, unknown>([
      [
        String(legacySelectCommandId),
        {
          resolution: {
            _tag: "Committed" as const,
            result: {
              workspaceId,
              workId: decisionWorkId,
              revision: 6,
            },
          },
        },
      ],
    ]);
    const state = makeDecisionHarnessState();
    state.currentWorkId = decisionWorkId;
    state.workspaceRevision = 6;
    const calls: string[] = [];
    const gateway = {
      execute: (envelope: GatewayEnvelope<unknown>) => {
        calls.push(String(envelope.commandId));
        return Effect.succeed(receipts.get(String(envelope.commandId)));
      },
    } as unknown as CommandGatewayService;
    const handler = makeSelectCurrentWorkHandler(gateway, receipts, state);

    const converged = await runControlHandler(
      handler,
      decisionAction,
      1,
      decisionInvocation,
      decisionExecution,
    );

    expect(converged._tag).toBe("Accepted");
    expect(calls).toHaveLength(0);
    expect(state.submitCalls).toBe(1);
    expect(state.request.state).toEqual({
      _tag: "Submitted",
      selectedWorkId: decisionWorkId,
    });
  });

  it("converges after DecisionRequest.submit without repeating either effect", async () => {
    const receipts = new Map<string, unknown>([
      [
        String(legacySelectCommandId),
        {
          resolution: {
            _tag: "Committed" as const,
            result: {
              workspaceId,
              workId: decisionWorkId,
              revision: 6,
            },
          },
        },
      ],
    ]);
    const state = makeDecisionHarnessState({
      _tag: "Submitted",
      selectedWorkId: decisionWorkId,
    });
    state.currentWorkId = decisionWorkId;
    state.workspaceRevision = 6;
    const calls: string[] = [];
    const gateway = {
      execute: (envelope: GatewayEnvelope<unknown>) => {
        calls.push(String(envelope.commandId));
        return Effect.succeed(receipts.get(String(envelope.commandId)));
      },
    } as unknown as CommandGatewayService;
    const handler = makeSelectCurrentWorkHandler(gateway, receipts, state);

    const converged = await runControlHandler(
      handler,
      decisionAction,
      1,
      decisionInvocation,
      decisionExecution,
    );

    expect(converged._tag).toBe("Accepted");
    expect(calls).toHaveLength(0);
    expect(state.submitCalls).toBe(0);
  });

  it("does not resend an older non-fencing terminal rejection", async () => {
    const receipts = new Map<string, unknown>();
    const state = makeDecisionHarnessState();
    const calls: string[] = [];
    const gateway = {
      execute: (envelope: GatewayEnvelope<unknown>) => {
        const commandId = String(envelope.commandId);
        calls.push(commandId);
        const rejected = {
          resolution: {
            _tag: "TerminalRejected" as const,
            error: { _tag: "RevisionConflict" as const },
          },
        };
        receipts.set(commandId, rejected);
        return Effect.succeed(rejected);
      },
    } as unknown as CommandGatewayService;
    const handler = makeSelectCurrentWorkHandler(gateway, receipts, state);

    await runControlHandler(
      handler,
      decisionAction,
      0,
      decisionInvocation,
      decisionExecution,
    );
    const replay = await runControlHandler(
      handler,
      decisionAction,
      1,
      decisionInvocation,
      decisionExecution,
    );

    expect(replay._tag).toBe("Rejected");
    expect(calls).toEqual([String(legacySelectCommandId)]);
  });
});
