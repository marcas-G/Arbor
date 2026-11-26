import type {
  AgentActionHandler,
  AgentActionHandlerInput,
} from "@arbor/agent-runtime";
import type { CommandGatewayService } from "@arbor/application";
import {
  CommandId,
  DecisionId,
  ExecutionId,
  type LeaseGeneration,
  MessageId,
  Principal,
  ProjectId,
  parse,
  SemanticRequestFingerprint,
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
  StoredCommandResolution,
  TransactionPortService,
  WorkspaceRepositoryService,
} from "@arbor/ports";
import { sha256Hex } from "@arbor/ports";
import { Effect, Option } from "effect";
import {
  assignWorkHandler,
  makeSingleWorkspaceControlActionHandlers,
  selectCurrentWorkHandler,
} from "../../src/control-actions.js";

export const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
export const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
export const projectId = parse(ProjectId)(
  "prj_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
export const sessionId = parse(SessionId)(
  "ses_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
export const principal = parse(Principal)("worker:ah10");
export const commandHandlerRegistry = {
  lookup: (commandType: string) =>
    Option.some({ commandType, schemaVersion: "1" } as never),
} as never;

type FakeReceipt =
  | {
      readonly resolution: {
        readonly _tag: "Committed";
        readonly result: unknown;
      };
      readonly semanticRequestFingerprint?: string;
    }
  | {
      readonly resolution: {
        readonly _tag: "TerminalRejected";
        readonly error: unknown;
      };
      readonly semanticRequestFingerprint?: string;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isFakeReceipt = (value: unknown): value is FakeReceipt => {
  if (!isRecord(value) || !isRecord(value.resolution)) return false;
  const resolution = value.resolution;
  return (
    (resolution._tag === "Committed" && "result" in resolution) ||
    (resolution._tag === "TerminalRejected" && "error" in resolution)
  );
};

const toStoredCommandResolution = (
  commandId: string,
  value: unknown,
): StoredCommandResolution => {
  if (!isFakeReceipt(value)) {
    throw new Error("AH10 fake receipt fixture has an invalid resolution");
  }
  const receipt = value;
  return receipt.resolution._tag === "Committed"
    ? {
        commandId: parse(CommandId)(commandId),
        projectId,
        semanticRequestFingerprint: parse(SemanticRequestFingerprint)(
          receipt.semanticRequestFingerprint ?? "ah10-test-fingerprint",
        ),
        schemaVersion: "1",
        fingerprintAlgorithmVersion: 1,
        resolution: "Committed",
        resultJson: JSON.stringify(receipt.resolution.result) ?? "null",
        terminalErrorJson: null,
        createdAt: "2026-10-05T00:00:00.000Z",
        settledAt: "2026-10-05T00:00:00.000Z",
      }
    : {
        commandId: parse(CommandId)(commandId),
        projectId,
        semanticRequestFingerprint: parse(SemanticRequestFingerprint)(
          receipt.semanticRequestFingerprint ?? "ah10-test-fingerprint",
        ),
        schemaVersion: "1",
        fingerprintAlgorithmVersion: 1,
        resolution: "TerminalRejected",
        resultJson: null,
        terminalErrorJson: JSON.stringify(receipt.resolution.error) ?? "null",
        createdAt: "2026-10-05T00:00:00.000Z",
        settledAt: "2026-10-05T00:00:00.000Z",
      };
};

export const execution = {
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

export const decisionId = parse(DecisionId)(
  "dec_018f2b3c-4d5e-7abc-8def-0123456789a7",
);
export const decisionWorkId = parse(WorkId)(
  "wrk_018f2b3c-4d5e-7abc-8def-0123456789a8",
);
export const decisionExecution = {
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
export const decisionAction = {
  _tag: "SelectCurrentWork" as const,
  workId: decisionWorkId,
};
export const decisionInvocation = {
  providerTurnId: "ptn_018f2b3c-4d5e-7abc-8def-0123456789b1" as never,
  outputPosition: 0,
  callRef: "call-ah10-select-current-work",
  toolName: "select_current_work",
  argumentsJson: JSON.stringify(decisionAction),
};
export const legacySelectCommandId = parse(CommandId)(
  `cmd_${String(decisionId).slice("dec_".length)}`,
);

export interface DecisionHarnessState {
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

export const makeDecisionHarnessState = (
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

export const makeSelectCurrentWorkHandler = (
  gateway: CommandGatewayService,
  receipts: ReadonlyMap<string, unknown>,
  state: DecisionHarnessState,
) =>
  selectCurrentWorkHandler({
    gateway,
    commandHandlerRegistry,
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

export const action = {
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

export const invocation = {
  providerTurnId: "ptn_018f2b3c-4d5e-7abc-8def-0123456789a2" as never,
  outputPosition: 0,
  callRef: "call-ah10-same-pinned-action",
  toolName: "assign_work",
  argumentsJson: JSON.stringify(action),
};

export const generationContext = (generation: number) =>
  ({
    _tag: "ExecutionOrigin" as const,
    principal,
    executionId,
    fencingGeneration: generation as LeaseGeneration,
  }) as never;

export const transaction = {
  transact: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
} as TransactionPortService;

export const receiptLookup = (
  receipts: ReadonlyMap<string, unknown>,
): Pick<CommandStoreService, "findResolution"> => ({
  findResolution: (commandId) => {
    const receipt = receipts.get(String(commandId));
    if (
      isRecord(receipt) &&
      "schemaVersion" in receipt &&
      "resultJson" in receipt &&
      "terminalErrorJson" in receipt
    ) {
      return Effect.succeed(
        Option.some(receipt as unknown as StoredCommandResolution),
      );
    }
    return Effect.succeed(
      receipt === undefined
        ? Option.none()
        : Option.some(toStoredCommandResolution(String(commandId), receipt)),
    );
  },
});

export const runControlHandler = (
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

export const consumerWork = {
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
export const boundDependencyConsumerWorkId = parse(WorkId)(
  "wrk_018f2b3c-4d5e-7abc-8def-0123456789a1",
);

export const dependencyAction = {
  _tag: "DeclareDependency" as const,
  producerBinding: { _tag: "AnyProducer" as const },
  expectedDeliverable: { kind: "report", requiredArtifactRoles: [] },
};

export const dependencyInvocation = {
  ...invocation,
  toolName: "declare_dependency",
  argumentsJson: JSON.stringify(dependencyAction),
};

export const childWorkspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a2",
);
export const sendAction = {
  _tag: "SendMessage" as const,
  kind: "Query" as const,
  body: "AH10 pinned message body",
  recipientWorkspaceId: childWorkspaceId,
};
export const sendInvocation = {
  ...invocation,
  toolName: "send_message",
  argumentsJson: JSON.stringify(sendAction),
};
export const queryMessageId = parse(MessageId)(
  "msg_018f2b3c-4d5e-7abc-8def-0123456789a5",
);
export const replyCorrelationId = "cor_018f2b3c-4d5e-7abc-8def-0123456789a6";
export const replyAction = {
  _tag: "SendMessage" as const,
  kind: "Reply" as const,
  body: "AH10 reply to the pinned query",
  queryMessageId,
};
export const replyInvocation = {
  ...invocation,
  toolName: "send_message",
  argumentsJson: JSON.stringify(replyAction),
};
export const acceptanceWork = {
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
export const acceptanceWorkId = acceptanceWork.workId as WorkId;
export const verificationId = parse(VerificationId)(
  "ver_018f2b3c-4d5e-7abc-8def-0123456789a3",
);
export const acceptAction = {
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
export const acceptInvocation = {
  ...invocation,
  toolName: "accept_result",
  argumentsJson: JSON.stringify(acceptAction),
};

export const actionHandlerFromRegistry = (
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
  sideEffects?: { blobWrites: number },
  anyProducerEvidence: () => Effect.Effect<boolean> = () =>
    Effect.succeed(true),
) => {
  const blobBytes = new Map<string, Uint8Array>();
  const handlers = makeSingleWorkspaceControlActionHandlers({
    gateway,
    commandHandlerRegistry,
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
        if (sideEffects !== undefined) sideEffects.blobWrites += 1;
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
    anyProducerEvidence,
  } as never);
  const handler = handlers.find((candidate) => candidate.action === action);
  if (handler === undefined) throw new Error(`missing ${action} handler`);
  return handler;
};

export const runHandler = (
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

export const makeHandler = (
  gateway: CommandGatewayService,
  receipts: ReadonlyMap<string, unknown>,
) =>
  assignWorkHandler({
    gateway,
    commandHandlerRegistry,
    commandReceipts: receiptLookup(receipts),
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
