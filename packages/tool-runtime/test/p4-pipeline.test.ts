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
  ToolDefinitionStore,
  ToolInvocationStore,
  type ToolRuntimeError,
  ToolRuntimePort,
  TransactionPort,
  TransactionScope,
  WorkspaceRepository,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  ToolDefinitionStoreLive,
  type ToolExecutor,
  ToolRuntimeLive,
} from "../src/index.js";

const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");
const principal = parse(Principal)("worker:a");
const actor = parse(Actor)("worker:a");
const invocationId = parse(ToolInvocationId)(
  "tin_018f2b3c-4d5e-7abc-8def-0123456789a1",
);

const authority = {
  principal,
  workspaceId,
  executionId,
  toolName: "read",
  toolVersion: "2",
  resourceSpaceIds: ["filesystem"],
  allowedCapabilities: ["fs:read"],
  controlBasisDigest: "d",
  expiresAt: "2999-01-01T00:00:00.000Z",
  delegationDepth: 0,
};
const context = {
  executionId,
  workspaceId,
  sessionId,
  projectId,
  actor,
  authenticatedPrincipal: principal,
  authority,
  controlBasisDigest: "d",
  requestedAt: "t",
} as import("@arbor/ports").ToolExecutionContext;
const intent = (argumentsJson: string) => ({
  callRef: "c",
  toolName: "read",
  toolVersion: "2",
  argumentsJson,
  invocationId,
  approvalId: null,
});

const okExecutor: ToolExecutor = {
  name: "read",
  write: false,
  requiresApproval: () => false,
  execute: () =>
    Effect.succeed({
      settlement: { _tag: "Success" },
      observation: { text: "ok", truncated: false },
      resultRef: null,
    }),
};

interface PipelineFaults {
  readonly workspaceLookup?: boolean;
  readonly environmentResolution?: boolean;
  readonly resourceAdmission?: boolean;
  readonly sandboxOpen?: boolean;
  readonly sandboxClose?: boolean;
  readonly intentJournal?: boolean;
  readonly settlementJournal?: boolean;
}

const app = (
  admissionDeny = false,
  executor: ToolExecutor = okExecutor,
  faults: PipelineFaults = {},
) => {
  const tx = Layer.succeed(TransactionPort, {
    transact: <A, E, R>(body: Effect.Effect<A, E, R | TransactionScope>) =>
      Effect.provideService(body, TransactionScope, { session: { id: "t" } }),
  });
  const deps = Layer.mergeAll(
    tx,
    ToolDefinitionStoreLive,
    Layer.succeed(SandboxPort, {
      open: () =>
        faults.sandboxOpen === true
          ? Effect.fail({
              _tag: "SandboxError" as const,
              cause: "sandbox-open-failure",
            })
          : Effect.succeed({
              handleId: "s",
              rootPath: "/tmp/s",
              writableRegions: [],
            }),
      close: () =>
        faults.sandboxClose === true
          ? Effect.fail({
              _tag: "SandboxError" as const,
              cause: "sandbox-close-failure",
            })
          : Effect.void,
    }),
    Layer.succeed(ResourceAdmission, {
      admit: () =>
        faults.resourceAdmission === true
          ? Effect.fail({
              _tag: "ResourceAdmissionError" as const,
              cause: "admission-failure",
            })
          : Effect.succeed(
              admissionDeny
                ? { _tag: "Denied" as const, reason: "no" }
                : { _tag: "Admitted" as const },
            ),
    } as never),
    Layer.succeed(ToolInvocationStore, {
      recordIntent: () =>
        faults.intentJournal === true
          ? Effect.fail({
              _tag: "PersistenceUnavailable" as const,
              repository: "ToolInvocationStore" as const,
              operation: "record-intent-test",
              retryDisposition: "retryable" as const,
              sourceTag: "InjectedFailure",
              cause: "intent-journal-failure",
            })
          : Effect.void,
      settle: () =>
        faults.settlementJournal === true
          ? Effect.fail({
              _tag: "PersistenceUnavailable" as const,
              repository: "ToolInvocationStore" as const,
              operation: "settle-test",
              retryDisposition: "retryable" as const,
              sourceTag: "InjectedFailure",
              cause: "settlement-journal-failure",
            })
          : Effect.void,
      consumeApproval: () => Effect.succeed(true),
      findApproval: () => Effect.succeed(Option.none()),
      findById: () => Effect.succeed(Option.none()),
      findUnsettled: () => Effect.succeed([]),
    } as never),
    Layer.succeed(ProjectEnvironmentPort, {
      resolve: (_p, addresses) =>
        faults.environmentResolution === true
          ? Effect.fail({
              _tag: "EnvironmentError" as const,
              cause: "environment-resolution-failure",
            })
          : Effect.succeed({
              regions: addresses.map((a) => ({
                resourceSpaceId: "filesystem",
                normalizedRegion: a,
              })),
              observedEnvironmentRevision: "rev",
            }),
    }),
    Layer.succeed(WorkspaceRepository, {
      findById: () =>
        faults.workspaceLookup === true
          ? Effect.fail({
              _tag: "PersistenceUnavailable" as const,
              repository: "WorkspaceRepository" as const,
              operation: "test",
              retryDisposition: "retryable" as const,
              sourceTag: "InjectedFailure",
              cause: "workspace-lookup-failure",
            })
          : Effect.succeed(
              Option.some({
                projectId,
                resourceBoundary: {
                  addresses: [{ _tag: "GitWorktree", path: "/repo/a" }],
                },
              }),
            ),
    } as never),
    Layer.succeed(Clock, {
      now: () => Effect.succeed("2026-01-01T00:00:00.000Z"),
    }),
  );
  return Layer.mergeAll(deps, Layer.provide(ToolRuntimeLive([executor]), deps));
};

// biome-ignore lint/suspicious/noExplicitAny: test helper erases the app layer type
const run = (appLayer: Layer.Layer<any, any, any>, argumentsJson: string) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const runtime = yield* ToolRuntimePort;
        return yield* runtime.invoke(intent(argumentsJson) as never, context);
      }),
      appLayer,
    ) as Effect.Effect<{ _tag: string }, unknown, never>,
  );

const runFailure = (
  // biome-ignore lint/suspicious/noExplicitAny: test helper erases the app layer type
  appLayer: Layer.Layer<any, any, any>,
  argumentsJson: string,
): Promise<ToolRuntimeError> =>
  Effect.runPromise(
    Effect.flip(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* ToolRuntimePort;
          return yield* runtime.invoke(intent(argumentsJson) as never, context);
        }),
        appLayer,
      ),
    ) as Effect.Effect<ToolRuntimeError, never, never>,
  );

describe("P4 tool runtime pipeline", () => {
  it("runs the pipeline and returns Success", async () => {
    const result = await run(
      app(),
      '{"target":{"mount":"workspace","path":"."}}',
    );
    expect(result._tag).toBe("Success");
  });

  it("returns ExpectedFailure on invalid input", async () => {
    const result = await run(app(), "{}");
    expect(result._tag).toBe("ExpectedFailure");
  });

  it("returns Denied when admission denies", async () => {
    const result = await run(
      app(true),
      '{"target":{"mount":"workspace","path":"."}}',
    );
    expect(result._tag).toBe("Denied");
  });

  it("returns Denied for an unknown tool", async () => {
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* ToolRuntimePort;
          return yield* runtime.invoke(
            { ...intent("{}"), toolName: "nope" } as never,
            context,
          );
        }),
        app(),
      ) as Effect.Effect<{ _tag: string }, unknown, never>,
    );
    expect(result._tag).toBe("Denied");
  });

  it("requires approval when the executor demands it", async () => {
    const approvalExecutor: ToolExecutor = {
      name: "read",
      write: false,
      requiresApproval: () => true,
      execute: okExecutor.execute,
    };
    const result = await run(
      app(false, approvalExecutor),
      '{"target":{"mount":"workspace","path":"."}}',
    );
    expect(result._tag).toBe("Denied");
  });

  it.each([
    ["WorkspaceLookup", { workspaceLookup: true }],
    ["EnvironmentResolution", { environmentResolution: true }],
    ["ResourceAdmission", { resourceAdmission: true }],
    ["IntentJournal", { intentJournal: true }],
    ["SandboxOpen", { sandboxOpen: true }],
    ["SettlementJournal", { settlementJournal: true }],
  ] as const)(
    "preserves the %s operational stage instead of flattening the cause",
    async (stage, faults) => {
      const failure = await runFailure(
        app(false, okExecutor, faults),
        '{"target":{"mount":"workspace","path":"."}}',
      );
      expect(failure).toMatchObject({
        _tag: "ToolRuntimeOperationalFailure",
        stage,
      });
    },
  );

  it("returns sandbox close failure as typed cleanup failure instead of a defect", async () => {
    const failure = await runFailure(
      app(false, okExecutor, { sandboxClose: true }),
      '{"target":{"mount":"workspace","path":"."}}',
    );
    expect(failure).toMatchObject({
      _tag: "ToolRuntimeCleanupFailure",
      stage: "SandboxClose",
    });
  });

  it("retains executor failure when sandbox cleanup also fails", async () => {
    const failingExecutor: ToolExecutor = {
      ...okExecutor,
      execute: () =>
        Effect.fail({
          _tag: "ToolRuntimeOperationalFailure",
          stage: "Executor",
          effectDisposition: "OutcomeUncertain",
          invocationRef: String(invocationId),
          cause: "executor-failure",
        }),
    };
    const failure = await runFailure(
      app(false, failingExecutor, { sandboxClose: true }),
      '{"target":{"mount":"workspace","path":"."}}',
    );
    expect(failure).toMatchObject({
      _tag: "ToolRuntimeCleanupFailure",
      stage: "SandboxClose",
      priorFailure: {
        _tag: "ToolRuntimeOperationalFailure",
        stage: "Executor",
      },
    });
  });

  void ToolDefinitionStore;
});
