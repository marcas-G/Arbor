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
  ExecutionId,
  type LeaseGeneration,
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
) =>
  Effect.runPromise(
    Effect.match(
      handler.handle({
        action: handlerAction,
        invocation: handlerInvocation,
        execution,
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
  action: "AcceptResult" | "DeclareDependency",
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
) => {
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
    messages: {},
    blobs: {},
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
