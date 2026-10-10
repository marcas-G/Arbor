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
  type InvocationApproval,
  type NoEffectDenialCode,
  ProjectEnvironmentPort,
  ResourceAdmission,
  SandboxPort,
  ToolDefinitionStore,
  type ToolInvocationRecord,
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
  actionDigestOf,
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
  readonly settlementUnapplied?: boolean;
}

interface PipelineTrace {
  readonly noEffectDenials: Array<string>;
  readonly events: Array<string>;
  approvalConsumer: string | null;
  intentWrites: number;
  effectAdmissions: number;
  approvalConsumes: number;
  effectAdmissionDenial?: NoEffectDenialCode;
  afterAuthorityResolved?: () => Promise<void>;
}

const app = (
  admissionDeny = false,
  executor: ToolExecutor = okExecutor,
  faults: PipelineFaults = {},
  trace?: PipelineTrace,
  initialApproval?: InvocationApproval,
) => {
  let approval = initialApproval;
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
          : Effect.succeed(true),
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
      recordIntent: () => {
        if (trace !== undefined) {
          trace.intentWrites += 1;
          trace.events.push("intent");
        }
        return faults.intentJournal === true
          ? Effect.fail({
              _tag: "PersistenceUnavailable" as const,
              repository: "ToolInvocationStore" as const,
              operation: "record-intent-test",
              retryDisposition: "retryable" as const,
              sourceTag: "InjectedFailure",
              cause: "intent-journal-failure",
            })
          : Effect.succeed("Recorded" as const);
      },
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
          : Effect.succeed(faults.settlementUnapplied !== true),
      consumeApproval: () => {
        if (trace !== undefined) {
          trace.approvalConsumes += 1;
          trace.events.push("consume");
        }
        if (approval === undefined || approval.consumedBy !== null) {
          return Effect.succeed(false);
        }
        approval = { ...approval, consumedBy: invocationId };
        if (trace !== undefined) trace.approvalConsumer = String(invocationId);
        return Effect.succeed(true);
      },
      recordNoEffectDenial: (
        invocation: ToolInvocationRecord,
        reasonCode: string,
        settledAt: string,
      ) =>
        Effect.sync(() => {
          trace?.noEffectDenials.push(reasonCode);
          trace?.events.push("denied");
          return {
            ...invocation,
            effectAdmissionState: "NotAdmitted" as const,
            settledAt,
            settlement: {
              _tag: "Denied" as const,
              reasonCode: reasonCode as never,
            },
            resultRef: null,
          };
        }),
      recordNoEffectInterruption: () => Effect.succeed(false),
      admitEffect: () => {
        if (trace !== undefined) {
          trace.effectAdmissions += 1;
          trace.events.push("effect-admission");
        }
        return Effect.succeed(
          trace?.effectAdmissionDenial === undefined
            ? { _tag: "Admitted" as const }
            : {
                _tag: "Denied" as const,
                reasonCode: trace.effectAdmissionDenial,
              },
        );
      },
      findApproval: () =>
        Effect.succeed(
          approval === undefined ? Option.none() : Option.some(approval),
        ),
      findById: (() => {
        let calls = 0;
        const canonicalUnknown: ToolInvocationRecord = {
          invocationId,
          executionId,
          workspaceId,
          toolName: "read",
          toolVersion: "2",
          sideEffectSemantics: "NonIdempotent",
          argumentsJson: '{"target":{"mount":"workspace","path":"."}}',
          resolvedRegions: [],
          approvalId: null,
          effectAdmissionState: "MayHaveStarted",
          intentAt: "2026-01-01T00:00:00.000Z",
          settledAt: "2026-01-01T00:00:01.000Z",
          settlement: {
            _tag: "OutcomeUnknown",
            reconciliationRefs: [String(invocationId)],
          },
          resultRef: null,
        };
        return () => {
          calls += 1;
          return Effect.succeed(
            faults.settlementUnapplied === true && calls > 1
              ? Option.some(canonicalUnknown)
              : Option.none(),
          );
        };
      })(),
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
  const toolRuntime = ToolRuntimeLive(
    [executor],
    trace?.afterAuthorityResolved === undefined
      ? {}
      : {
          qualificationProbe: async (event) => {
            if (
              event.boundary ===
              "AH7AfterEffectAuthorityResolvedBeforeAdmission"
            ) {
              await trace.afterAuthorityResolved?.();
            }
          },
        },
  );
  return Layer.mergeAll(deps, Layer.provide(toolRuntime, deps));
};

const run = (
  // biome-ignore lint/suspicious/noExplicitAny: test helper erases the app layer type
  appLayer: Layer.Layer<any, any, any>,
  argumentsJson: string,
  approvalId: string | null = null,
) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const runtime = yield* ToolRuntimePort;
        return yield* runtime.invoke(
          { ...intent(argumentsJson), approvalId } as never,
          context,
        );
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

  it("returns the canonical OutcomeUnknown when settlement CAS updates zero rows", async () => {
    let externalEffects = 0;
    const executor: ToolExecutor = {
      ...okExecutor,
      execute: () =>
        Effect.sync(() => {
          externalEffects += 1;
          return {
            settlement: { _tag: "Success" as const },
            observation: { text: "executed once", truncated: false },
            resultRef: null,
          };
        }),
    };
    const result = await run(
      app(false, executor, { settlementUnapplied: true }),
      '{"target":{"mount":"workspace","path":"."}}',
    );
    expect(result).toMatchObject({
      _tag: "OutcomeUnknown",
      reconciliationRefs: [String(invocationId)],
    });
    expect(externalEffects).toBe(1);
  });

  it("returns ExpectedFailure on invalid input", async () => {
    const result = await run(app(), "{}");
    expect(result._tag).toBe("ExpectedFailure");
  });

  it("returns Denied when admission denies", async () => {
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
    };
    const result = await run(
      app(true, okExecutor, {}, trace),
      '{"target":{"mount":"workspace","path":"."}}',
    );
    expect(result).toMatchObject({
      _tag: "Denied",
      reasonCode: "ResourceAdmissionDenied",
    });
    expect(trace).toEqual({
      noEffectDenials: ["ResourceAdmissionDenied"],
      events: ["denied"],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
    });
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
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
    };
    const result = await run(
      app(false, approvalExecutor, {}, trace),
      '{"target":{"mount":"workspace","path":"."}}',
    );
    expect(result).toMatchObject({
      _tag: "Denied",
      reasonCode: "ApprovalRequired",
    });
    expect(trace).toEqual({
      noEffectDenials: ["ApprovalRequired"],
      events: ["denied"],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
    });
  });

  it("settles a post-claim effect-gate denial without opening the executor", async () => {
    let executorCalls = 0;
    const approvalExecutor: ToolExecutor = {
      ...okExecutor,
      requiresApproval: () => true,
      execute: (input) => {
        executorCalls += 1;
        return okExecutor.execute(input);
      },
    };
    const argumentsJson = '{"target":{"mount":"workspace","path":"."}}';
    const approvalId = "iap_018f2b3c-4d5e-7abc-8def-0123456789a1";
    const approval: InvocationApproval = {
      approvalId,
      toolName: "read",
      toolVersion: "2",
      actionDigest: actionDigestOf(intent(argumentsJson)),
      targetResourceSpaceIds: ["filesystem"],
      controlBasisDigest: "d",
      expiresAt: "2999-01-01T00:00:00.000Z",
      consumedBy: null,
    };
    let signalAuthorityResolved!: () => void;
    let resumeEffectGate!: () => void;
    const authorityResolved = new Promise<void>((resolve) => {
      signalAuthorityResolved = resolve;
    });
    const effectGateResumed = new Promise<void>((resolve) => {
      resumeEffectGate = resolve;
    });
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
      afterAuthorityResolved: async () => {
        signalAuthorityResolved();
        await effectGateResumed;
      },
    };

    const resultPromise = run(
      app(false, approvalExecutor, {}, trace, approval),
      argumentsJson,
      approvalId,
    );
    await authorityResolved;
    // Simulate the authoritative source changing after resolution but before
    // the store's separate fenced admission transaction.
    trace.effectAdmissionDenial = "InvocationAuthorityDenied";
    resumeEffectGate();
    const result = await resultPromise;

    expect(result).toMatchObject({
      _tag: "Denied",
      reasonCode: "ApprovalNoLongerAuthorized",
    });
    expect(trace.events).toEqual([
      "intent",
      "consume",
      "effect-admission",
      "denied",
    ]);
    expect(trace.approvalConsumes).toBe(1);
    expect(trace.approvalConsumer).toBe(String(invocationId));
    expect(executorCalls).toBe(0);
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
