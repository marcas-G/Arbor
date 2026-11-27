import {
  Actor,
  ExecutionId,
  Principal,
  ProjectId,
  parse,
  SessionId,
  ToolInvocationId,
  WorkspaceId,
} from "@arbor/domain";
import {
  Clock,
  ProjectEnvironmentPort,
  ResourceAdmission,
  SandboxPort,
  type ToolDefinition,
  ToolDefinitionStore,
  type ToolExecutionContext,
  type ToolInvocationRecord,
  TransactionPort,
  TransactionScope,
  WorkspaceRepository,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { expect } from "vitest";

// Shared fixtures for the exact-approval-reentry suites (legacy
// consumeApproval route and P38 executable route): one identity block and
// one pipeline-dependency builder instead of three hand-rolled copies.

export const approvalWorkspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
export const approvalExecutionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
export const approvalProjectId = parse(ProjectId)(
  "prj_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const approvalSessionId = parse(SessionId)(
  "ses_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const approvalPrincipal = parse(Principal)("worker:a");
const approvalActor = parse(Actor)("worker:a");
export const approvalInvocationId = parse(ToolInvocationId)(
  "tin_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
export const approvalId = "iap_018f2b3c-4d5e-7abc-8def-0123456789a1";

const definition: ToolDefinition = {
  name: "read",
  version: "1",
  hash: "read-v1",
  description: "Read a value.",
  inputSchemaJson: JSON.stringify({ type: "object" }),
  resultSchemaJson: JSON.stringify({ type: "object" }),
  capabilityMetadata: [],
  sideEffectSemantics: "Idempotent",
  source: "Builtin",
};

export const approvalArgumentsJson = "{}";

export const approvalIntent = (argumentsJson = approvalArgumentsJson) =>
  ({
    callRef: "call-ah7-approval",
    toolName: "read",
    toolVersion: "1",
    argumentsJson,
    invocationId: approvalInvocationId,
    approvalId,
  }) as const;

export const approvalContext: ToolExecutionContext = {
  executionId: approvalExecutionId,
  workspaceId: approvalWorkspaceId,
  sessionId: approvalSessionId,
  projectId: approvalProjectId,
  actor: approvalActor,
  authenticatedPrincipal: approvalPrincipal,
  authority: {
    principal: approvalPrincipal,
    workspaceId: approvalWorkspaceId,
    executionId: approvalExecutionId,
    toolName: "read",
    toolVersion: "1",
    sourceRevision: "fixture-authority-revision",
    resourceSpaceIds: [],
    allowedCapabilities: [],
    controlBasisDigest: "basis-ah7",
    expiresAt: "2999-01-01T00:00:00.000Z",
    delegationDepth: 0,
  },
  controlBasisDigest: "basis-ah7",
  executionFence: {
    executionId: approvalExecutionId,
    workerId: "worker:p4-approval-reentry",
    workerIncarnationId: "incarnation:p4-approval-reentry",
    fencingGeneration: 0 as never,
  },
  requestedAt: "2026-10-05T00:00:00.000Z",
};

/** The generic pipeline ports (everything except ToolInvocationStore and
 * ExecutableApprovalStore, which each scenario scripts itself): transaction
 * scope, builtin definition, sandbox, admission, environment, workspace and
 * clock, parameterized by the values the scenarios differ in. */
export const approvalPipelineDeps = (options: {
  readonly sandboxHandleId: string;
  readonly environmentRevision: string;
  readonly now: string;
  readonly sandboxPort?: Layer.Layer<SandboxPort, never, never>;
}) =>
  Layer.mergeAll(
    Layer.succeed(TransactionPort, {
      transact: <A, E, R>(body: Effect.Effect<A, E, R | TransactionScope>) =>
        Effect.provideService(body, TransactionScope, {
          session: { id: "approval-reentry" },
        }),
    }),
    Layer.succeed(ToolDefinitionStore, {
      definition: () => Effect.succeed(Option.some(definition)),
      all: () => Effect.succeed([definition]),
    }),
    options.sandboxPort ??
      Layer.succeed(SandboxPort, {
        open: () =>
          Effect.succeed({
            handleId: options.sandboxHandleId,
            rootPath: "/repo",
            writableRegions: [],
          }),
        close: () => Effect.void,
      }),
    Layer.succeed(ResourceAdmission, {
      admit: () => Effect.succeed({ _tag: "Admitted" as const }),
    }),
    Layer.succeed(ProjectEnvironmentPort, {
      resolve: (_targetProjectId, addresses) =>
        Effect.succeed({
          regions: addresses.map((address) => ({
            resourceSpaceId: "filesystem",
            normalizedRegion: address,
          })),
          observedEnvironmentRevision: options.environmentRevision,
        }),
    }),
    Layer.succeed(WorkspaceRepository, {
      findById: (id: WorkspaceId) => {
        expect(id).toBe(approvalWorkspaceId);
        return Effect.succeed(
          Option.some({
            projectId: approvalProjectId,
            resourceBoundaryRevision: 0,
            resourceBoundary: {
              addresses: [{ _tag: "GitWorktree" as const, path: "/repo" }],
            },
          }),
        );
      },
    } as never),
    Layer.succeed(Clock, {
      now: () => Effect.succeed(options.now),
    }),
  );

/** Seeds a fresh pending invocation record for the shared intent. */
export const pendingInvocationRecord = (
  argumentsJson = approvalArgumentsJson,
): ToolInvocationRecord => ({
  invocationId: approvalInvocationId,
  executionId: approvalExecutionId,
  workspaceId: approvalWorkspaceId,
  toolName: "read",
  toolVersion: "1",
  sideEffectSemantics: "Idempotent",
  argumentsJson,
  resolvedRegions: [],
  approvalId,
  effectAdmissionState: "NotAdmitted",
  intentAt: "2026-10-05T00:00:00.000Z",
  settledAt: null,
  settlement: null,
  resultRef: null,
});
