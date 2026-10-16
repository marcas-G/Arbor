import {
  Actor,
  ExecutionId,
  Principal,
  ProjectId,
  ProviderTurnId,
  parse,
  SessionId,
  ToolInvocationId,
  WorkspaceId,
} from "@arbor/domain";
import {
  Clock,
  EnvironmentRevisionStore,
  type ExecutableApprovalRecord,
  ExecutableApprovalStore,
  type ExecutableApprovalStoreService,
  type InvocationApproval,
  type NoEffectDenialCode,
  P39RecoveryEvidenceStore,
  ProjectEnvironmentPort,
  ResourceAdmission,
  SandboxPort,
  ToolAuthorityResolver,
  ToolDefinitionStore,
  type ToolInvocationRecord,
  ToolInvocationStore,
  type ToolObservationEvidence,
  ToolObservationEvidenceStore,
  type ToolRuntimeError,
  ToolRuntimePort,
  TransactionPort,
  TransactionScope,
  WorkspaceRepository,
} from "@arbor/ports";
import { Effect, Exit, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  actionDigestOf,
  ToolDefinitionStoreLive,
  type ToolExecutor,
  ToolRuntimeLive,
} from "../src/index.js";
import { createShellExecutor } from "../src/tools/shell.js";

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
  sourceRevision: "fixture-authority-revision",
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
  executionFence: {
    executionId,
    workerId: "worker:p4-pipeline",
    workerIncarnationId: "incarnation:p4-pipeline",
    fencingGeneration: 0 as never,
  },
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
  environmentResolutions?: number;
  resourceAdmissionCalls?: number;
  p39BindingCalls?: number;
  p39SelectedReads?: number;
  readonly existingInvocationAfterStop?: ToolInvocationRecord;
  legacyInterruptedInvocation?: ToolInvocationRecord;
  legacyNoEffectInterruptionWrites?: number;
  readonly p40WinnerEvidence?: ToolObservationEvidence;
  readonly stopAtEffectAdmission?: boolean;
}

const app = (
  admissionDeny = false,
  executor: ToolExecutor = okExecutor,
  faults: PipelineFaults = {},
  trace?: PipelineTrace,
  initialApprovalOrExecutableApproval?:
    | InvocationApproval
    | ExecutableApprovalRecord,
  authorityDeniedOrDeniedReplay: boolean | ToolInvocationRecord = false,
  suppliedP39DeniedReplay?: ToolInvocationRecord,
  p39CurrentEnvironmentRevision?: string,
) => {
  const authorityDenied =
    typeof authorityDeniedOrDeniedReplay === "boolean"
      ? authorityDeniedOrDeniedReplay
      : false;
  const p39DeniedReplay =
    suppliedP39DeniedReplay ??
    (typeof authorityDeniedOrDeniedReplay === "object"
      ? authorityDeniedOrDeniedReplay
      : undefined);
  const p39BindingEnabled =
    p39DeniedReplay !== undefined ||
    p39CurrentEnvironmentRevision !== undefined;
  let approval =
    initialApprovalOrExecutableApproval !== undefined &&
    !("routeKind" in initialApprovalOrExecutableApproval)
      ? initialApprovalOrExecutableApproval
      : undefined;
  let executableApproval =
    initialApprovalOrExecutableApproval !== undefined &&
    "routeKind" in initialApprovalOrExecutableApproval
      ? initialApprovalOrExecutableApproval
      : undefined;
  const tx = Layer.succeed(TransactionPort, {
    transact: <A, E, R>(body: Effect.Effect<A, E, R | TransactionScope>) =>
      Effect.provideService(body, TransactionScope, { session: { id: "t" } }),
  });
  const baseDeps = Layer.mergeAll(
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
      admit: () => {
        if (p39BindingEnabled && trace !== undefined) {
          trace.resourceAdmissionCalls =
            (trace.resourceAdmissionCalls ?? 0) + 1;
        }
        return faults.resourceAdmission === true
          ? Effect.fail({
              _tag: "ResourceAdmissionError" as const,
              cause: "admission-failure",
            })
          : Effect.succeed(
              admissionDeny
                ? { _tag: "Denied" as const, reason: "no" }
                : { _tag: "Admitted" as const },
            );
      },
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
      recordNoEffectInterruption: (
        _id: typeof invocationId,
        settledAt: string,
      ) => {
        if (trace?.existingInvocationAfterStop !== undefined) {
          trace.legacyNoEffectInterruptionWrites =
            (trace.legacyNoEffectInterruptionWrites ?? 0) + 1;
          trace.legacyInterruptedInvocation = {
            ...trace.existingInvocationAfterStop,
            settledAt,
            settlement: { _tag: "Interrupted" },
          };
          return Effect.succeed(true);
        }
        return Effect.succeed(false);
      },
      admitEffect: () => {
        if (trace !== undefined) {
          trace.effectAdmissions += 1;
          trace.events.push("effect-admission");
        }
        return Effect.succeed(
          trace?.stopAtEffectAdmission === true
            ? { _tag: "ExecutionStopping" as const }
            : trace?.effectAdmissionDenial === undefined
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
          if (trace?.existingInvocationAfterStop !== undefined) {
            return Effect.succeed(
              trace.legacyInterruptedInvocation !== undefined
                ? Option.some(trace.legacyInterruptedInvocation)
                : calls === 1
                  ? Option.none()
                  : Option.some(trace.existingInvocationAfterStop),
            );
          }
          if (p39DeniedReplay !== undefined) {
            return Effect.succeed(Option.some(p39DeniedReplay));
          }
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
      resolve: (_p, addresses) => {
        if (p39BindingEnabled && trace !== undefined) {
          trace.environmentResolutions =
            (trace.environmentResolutions ?? 0) + 1;
        }
        return faults.environmentResolution === true
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
            });
      },
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
                resourceBoundaryRevision: 0,
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
  const evidenceDeps =
    trace?.p40WinnerEvidence === undefined
      ? baseDeps
      : Layer.merge(
          baseDeps,
          Layer.succeed(ToolObservationEvidenceStore, {
            assertCurrentFence: () => Effect.void,
            read: () =>
              Effect.succeed(
                trace.p40WinnerEvidence as ToolObservationEvidence,
              ),
            settleOrReadWinner: () =>
              Effect.succeed({
                _tag: "Existing" as const,
                evidence: trace.p40WinnerEvidence as ToolObservationEvidence,
              }),
          } as never),
        );
  const deps = authorityDenied
    ? Layer.mergeAll(
        evidenceDeps,
        Layer.succeed(ToolAuthorityResolver, {
          resolve: () => Effect.fail({ _tag: "ToolAuthorityDenied" as const }),
        }),
      )
    : evidenceDeps;
  const executableApprovalDeps =
    executableApproval === undefined
      ? deps
      : Layer.mergeAll(
          deps,
          Layer.succeed(ExecutableApprovalStore, {
            findById: () =>
              Effect.succeed(
                executableApproval === undefined
                  ? Option.none()
                  : Option.some(executableApproval),
              ),
            consumeApproved: (
              input: Parameters<
                ExecutableApprovalStoreService["consumeApproved"]
              >[0],
            ) => {
              if (
                executableApproval === undefined ||
                executableApproval.state !== "Approved" ||
                executableApproval.revision !== input.expectedRevision ||
                input.consumedBy !== invocationId
              ) {
                return Effect.succeed(false);
              }
              const before = executableApproval;
              const consumedRevision = before.revision + 1;
              executableApproval = {
                ...before,
                state: "Consumed",
                revision: consumedRevision,
                consumedAt: input.consumedAt,
                consumedBy: input.consumedBy,
              };
              if (trace !== undefined) {
                trace.approvalConsumes += 1;
                trace.events.push("consume");
                trace.approvalConsumer = String(input.consumedBy);
              }
              return Effect.succeed({
                approvalId: before.approvalId,
                preConsumeRevision: before.revision,
                consumedRevision,
                approvalDigest: "p38-exact-test-digest",
                binding: input.binding,
                expiresAt: before.expiresAt,
                consumedBy: input.consumedBy,
              });
            },
          } as never),
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
  const p39Deps = !p39BindingEnabled
    ? executableApprovalDeps
    : Layer.mergeAll(
        executableApprovalDeps,
        Layer.succeed(EnvironmentRevisionStore, {
          current: () =>
            Effect.succeed(
              p39CurrentEnvironmentRevision === undefined
                ? Option.none()
                : Option.some(p39CurrentEnvironmentRevision as never),
            ),
          record: () => Effect.void,
          lazyInitAnchor: () => Effect.void,
        }),
        Layer.succeed(P39RecoveryEvidenceStore, {
          bindClaim: () => {
            if (trace !== undefined) {
              trace.p39BindingCalls = (trace.p39BindingCalls ?? 0) + 1;
            }
            return Effect.succeed("Bound" as const);
          },
          findBinding: () => Effect.succeed(Option.none()),
          findSelected: () => {
            if (trace !== undefined) {
              trace.p39SelectedReads = (trace.p39SelectedReads ?? 0) + 1;
            }
            return Effect.succeed(Option.none());
          },
          findTerminalUnboundDenial: (id: typeof invocationId) =>
            Effect.succeed(
              p39DeniedReplay !== undefined &&
                id === p39DeniedReplay.invocationId
                ? Option.some({
                    invocationId: id,
                    recoveryBindingState: "DeniedUnbound" as const,
                  })
                : Option.none(),
            ),
        } as never),
      );
  return Layer.mergeAll(p39Deps, Layer.provide(toolRuntime, p39Deps));
};

const run = (
  // biome-ignore lint/suspicious/noExplicitAny: test helper erases the app layer type
  appLayer: Layer.Layer<any, any, any>,
  argumentsJson: string,
  approvalId: string | null = null,
  invocationOrContext:
    | ToolInvocationId
    | import("@arbor/ports").ToolExecutionContext = intent(
    argumentsJson,
  ).invocationId,
) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const runtime = yield* ToolRuntimePort;
        const invocationId =
          typeof invocationOrContext === "string"
            ? invocationOrContext
            : intent(argumentsJson).invocationId;
        const executionContext =
          typeof invocationOrContext === "string"
            ? context
            : invocationOrContext;
        return yield* runtime.invoke(
          { ...intent(argumentsJson), approvalId, invocationId } as never,
          executionContext,
        );
      }),
      appLayer,
    ) as Effect.Effect<{ _tag: string }, unknown, never>,
  );

const shellAuthority = {
  ...authority,
  toolName: "shell",
  toolVersion: "2",
  allowedCapabilities: ["shell:exec"],
};
const runShell = (
  // biome-ignore lint/suspicious/noExplicitAny: test helper erases the app layer type
  appLayer: Layer.Layer<any, any, any>,
  command: string,
) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const runtime = yield* ToolRuntimePort;
        return yield* runtime.invoke(
          {
            ...intent(
              JSON.stringify({
                command,
                cwd: { mount: "workspace", path: "." },
              }),
            ),
            toolName: "shell",
            toolVersion: "2",
          } as never,
          { ...context, authority: shellAuthority } as never,
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
  it("keeps unknown and compound shell commands in the nonterminal P38 approval handoff", async () => {
    for (const command of [
      "python -c 'print(1)'",
      "ls -la; rm file.txt",
      "s'u'do rm -rf /",
      "r'm' -rf /",
      "& 'sudo' rm -rf /",
    ]) {
      const trace: PipelineTrace = {
        noEffectDenials: [],
        events: [],
        approvalConsumer: null,
        intentWrites: 0,
        effectAdmissions: 0,
        approvalConsumes: 0,
      };
      let executorCalls = 0;
      const shell = createShellExecutor(() => {
        executorCalls += 1;
        throw new Error("approved effect must not execute before approval");
      });
      const result = await runShell(app(false, shell, {}, trace), command);

      expect(result._tag, command).toBe("ApprovalRequired");
      expect(executorCalls).toBe(0);
      expect(trace).toMatchObject({
        noEffectDenials: [],
        intentWrites: 0,
        effectAdmissions: 0,
        approvalConsumes: 0,
      });
    }
  });

  it("projects a typed authority policy rejection as Denied without execution", async () => {
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
    };
    let executorCalls = 0;
    const executor: ToolExecutor = {
      ...okExecutor,
      execute: (input) => {
        executorCalls += 1;
        return okExecutor.execute(input);
      },
    };
    const result = await run(
      app(false, executor, {}, trace, undefined, true),
      '{"target":{"mount":"workspace","path":"."}}',
    );

    expect(result).toMatchObject({
      _tag: "Denied",
      reasonCode: "InvocationAuthorityDenied",
    });
    expect(trace.noEffectDenials).toEqual(["InvocationAuthorityDenied"]);
    expect(trace.intentWrites).toBe(0);
    expect(trace.effectAdmissions).toBe(0);
    expect(executorCalls).toBe(0);
  });

  it("runs the pipeline and returns Success", async () => {
    const result = await run(
      app(),
      '{"target":{"mount":"workspace","path":"."}}',
    );
    expect(result._tag).toBe("Success");
  });

  it.each([
    {
      name: "Success",
      effectAdmissionState: "MayHaveStarted",
      settlement: { _tag: "Success" },
      observation: {
        _tag: "Success",
        observation: { text: "committed-success", truncated: false },
        resultRef: null,
      },
    },
    {
      name: "ExpectedFailure",
      effectAdmissionState: "MayHaveStarted",
      settlement: { _tag: "ExpectedFailure" },
      observation: {
        _tag: "ExpectedFailure",
        observation: { text: "committed-failure", truncated: false },
      },
    },
    {
      name: "Interrupted",
      effectAdmissionState: "NotAdmitted",
      settlement: { _tag: "Interrupted" },
      observation: { _tag: "Interrupted" },
    },
    {
      name: "OutcomeUnknown",
      effectAdmissionState: "MayHaveStarted",
      settlement: {
        _tag: "OutcomeUnknown",
        reconciliationRefs: [String(invocationId)],
      },
      observation: {
        _tag: "OutcomeUnknown",
        reconciliationRefs: [String(invocationId)],
      },
    },
    {
      name: "RuntimeFailure",
      effectAdmissionState: "MayHaveStarted",
      settlement: { _tag: "RuntimeFailure", cause: "committed-runtime-error" },
      observation: { _tag: "RuntimeFailure", cause: "committed-runtime-error" },
    },
  ] as const)(
    "P4 Stop re-entry projects the committed $name winner without rerunning the executor",
    async (winnerCase) => {
      const argumentsJson = '{"target":{"mount":"workspace","path":"."}}';
      const observation =
        winnerCase.observation as import("@arbor/ports").ToolObservationEvidenceObservation;
      const evidence: ToolObservationEvidence = {
        formatVersion: "p4-canonical-tool-observation-v1",
        bytes: new TextEncoder().encode(JSON.stringify(observation)),
        sha256: "a".repeat(64),
        observation,
      };
      const existing: ToolInvocationRecord = {
        invocationId,
        executionId,
        workspaceId,
        toolName: "read",
        toolVersion: "2",
        sideEffectSemantics: "ReadOnly",
        argumentsJson,
        resolvedRegions: [],
        approvalId: null,
        effectAdmissionState: winnerCase.effectAdmissionState,
        intentAt: "2026-01-01T00:00:00.000Z",
        settledAt: "2026-01-01T00:00:01.000Z",
        settlement: winnerCase.settlement as ToolInvocationRecord["settlement"],
        resultRef: null,
      };
      const trace: PipelineTrace = {
        noEffectDenials: [],
        events: [],
        approvalConsumer: null,
        intentWrites: 0,
        effectAdmissions: 0,
        approvalConsumes: 0,
        existingInvocationAfterStop: existing,
        p40WinnerEvidence: evidence,
        stopAtEffectAdmission: true,
      };
      let executorCalls = 0;
      const executor: ToolExecutor = {
        ...okExecutor,
        execute: (input) => {
          executorCalls += 1;
          return okExecutor.execute(input);
        },
      };
      const result = await run(app(false, executor, {}, trace), argumentsJson);
      expect(result).toEqual(observation);
      expect(executorCalls).toBe(0);
      expect(trace.effectAdmissions).toBe(1);
    },
  );

  it("keeps the canonical P4 Denied winner when Stop arrives before the effect gate", async () => {
    const argumentsJson = '{"target":{"mount":"workspace","path":"."}}';
    const deniedRecord: ToolInvocationRecord = {
      invocationId,
      executionId,
      workspaceId,
      toolName: "read",
      toolVersion: "2",
      sideEffectSemantics: "ReadOnly",
      argumentsJson,
      resolvedRegions: [],
      approvalId: null,
      effectAdmissionState: "NotAdmitted",
      intentAt: "2026-01-01T00:00:00.000Z",
      settledAt: "2026-01-01T00:00:01.000Z",
      settlement: { _tag: "Denied", reasonCode: "InvocationAuthorityDenied" },
      resultRef: null,
    };
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
      existingInvocationAfterStop: deniedRecord,
      stopAtEffectAdmission: true,
    };
    const result = await run(app(false, okExecutor, {}, trace), argumentsJson);
    expect(result).toMatchObject({
      _tag: "Denied",
      reasonCode: "InvocationAuthorityDenied",
    });
    expect(trace.effectAdmissions).toBe(1);
  });

  it("uses the legacy no-P40 interruption writer idempotently for a Stop before effect admission", async () => {
    const argumentsJson = '{"target":{"mount":"workspace","path":"."}}';
    const existing: ToolInvocationRecord = {
      invocationId,
      executionId,
      workspaceId,
      toolName: "read",
      toolVersion: "2",
      sideEffectSemantics: "ReadOnly",
      argumentsJson,
      resolvedRegions: [
        {
          resourceSpaceId: "filesystem",
          normalizedRegion: { _tag: "GitWorktree", path: "/repo/a" },
        },
      ],
      approvalId: null,
      effectAdmissionState: "NotAdmitted",
      intentAt: "2026-01-01T00:00:00.000Z",
      settledAt: null,
      settlement: null,
      resultRef: null,
    };
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
      existingInvocationAfterStop: existing,
      stopAtEffectAdmission: true,
    };
    const layer = app(false, okExecutor, {}, trace);
    const first = await run(layer, argumentsJson);
    const replay = await run(layer, argumentsJson);

    expect(first).toEqual({ _tag: "Interrupted" });
    expect(replay).toEqual({ _tag: "Interrupted" });
    expect(trace.legacyNoEffectInterruptionWrites).toBe(1);
    expect(trace.legacyInterruptedInvocation).toMatchObject({
      effectAdmissionState: "NotAdmitted",
      settlement: { _tag: "Interrupted" },
    });
    expect(trace.intentWrites).toBe(1);
    expect(trace.effectAdmissions).toBe(1);
    expect(trace.approvalConsumes).toBe(0);
  });

  it("fails closed when P39 does not return authenticated selected evidence for RNO", async () => {
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
    };
    const rnoExecutor: ToolExecutor = {
      ...okExecutor,
      execute: () =>
        Effect.succeed({
          settlement: {
            _tag: "ReconciledNoEffect",
            reasonCode: "ReplayLimitReached",
            reconciliationFactRef: "f".repeat(64),
          },
          observation: {
            text: "P39 selected outcome is absent",
            truncated: false,
          },
          resultRef: null,
        } as never),
    };
    const result = await Effect.runPromiseExit(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* ToolRuntimePort;
          return yield* runtime.invoke(
            intent(
              JSON.stringify({ target: { mount: "workspace", path: "." } }),
            ) as never,
            {
              ...context,
              authority: {
                ...authority,
                sourceRevision: JSON.stringify({
                  workspacePolicyRevision: 0,
                  activeGrants: [],
                  verifierId: null,
                }),
              },
              providerTurnId:
                "ptn_018f2b3c-4d5e-7abc-8def-0123456789a2" as never,
              logicalActionId: "lac_p40_missing_selected",
              recoveryBindingIdentity: {
                executionId,
                providerTurnId:
                  "ptn_018f2b3c-4d5e-7abc-8def-0123456789a2" as never,
                logicalStepNo: 0,
                repairAttempt: 0,
                logicalActionId: "lac_p40_missing_selected",
                actionIndex: 0,
                callRef: "c",
              },
              recoveryBindingPolicyRevisions: {
                workspacePolicyRevision: 0,
                projectPolicyRevision: 0,
              },
            } as never,
          );
        }),
        app(false, rnoExecutor, {}, trace, undefined, false, undefined, "rev"),
      ),
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect(trace.p39SelectedReads).toBe(1);
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

  it("replays exact DeniedUnbound before resource resolution, admission, or effect work", async () => {
    const argumentsJson = '{"target":{"mount":"workspace","path":"."}}';
    const deniedRecord: ToolInvocationRecord = {
      invocationId,
      executionId,
      workspaceId,
      toolName: "read",
      toolVersion: "2",
      sideEffectSemantics: "ReadOnly",
      argumentsJson,
      resolvedRegions: [
        {
          resourceSpaceId: "filesystem",
          normalizedRegion: { _tag: "GitWorktree", path: "/repo/a" },
        },
      ],
      approvalId: null,
      effectAdmissionState: "NotAdmitted",
      intentAt: "2026-01-01T00:00:00.000Z",
      settledAt: "2026-01-01T00:00:01.000Z",
      settlement: {
        _tag: "Denied",
        reasonCode: "ResourceAdmissionDenied",
      },
      resultRef: null,
    };
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
      environmentResolutions: 0,
      resourceAdmissionCalls: 0,
    };
    const p39Context = {
      ...context,
      recoveryBindingIdentity: {
        executionId,
        providerTurnId: parse(ProviderTurnId)(
          "ptn_018f2b3c-4d5e-7abc-8def-0123456789a7",
        ),
        logicalStepNo: 8,
        repairAttempt: 0,
        logicalActionId: "action-denied-replay",
        actionIndex: 0,
        callRef: "c",
      },
      recoveryBindingPolicyRevisions: {
        workspacePolicyRevision: 0,
        projectPolicyRevision: 0,
      },
    } as import("@arbor/ports").ToolExecutionContext;
    const executor: ToolExecutor = {
      ...okExecutor,
      execute: () => {
        throw new Error("DeniedUnbound replay must not execute");
      },
    };
    const result = await run(
      app(false, executor, {}, trace, undefined, deniedRecord),
      argumentsJson,
      null,
      p39Context,
    );
    expect(result).toMatchObject({
      _tag: "Denied",
      reasonCode: "ResourceAdmissionDenied",
    });
    expect(trace.environmentResolutions).toBe(0);
    expect(trace.resourceAdmissionCalls).toBe(0);
    expect(trace.intentWrites).toBe(0);
    expect(trace.approvalConsumes).toBe(0);
    expect(trace.effectAdmissions).toBe(0);
  });

  it("fails a stale P39 environment snapshot before intent, approval, admission, or effect writes", async () => {
    let executorCalls = 0;
    const executor: ToolExecutor = {
      ...okExecutor,
      execute: (input) => {
        executorCalls += 1;
        return okExecutor.execute(input);
      },
    };
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
      environmentResolutions: 0,
      resourceAdmissionCalls: 0,
      p39BindingCalls: 0,
    };
    const p39Context = {
      ...context,
      recoveryBindingIdentity: {
        executionId,
        providerTurnId: parse(ProviderTurnId)(
          "ptn_018f2b3c-4d5e-7abc-8def-0123456789b8",
        ),
        logicalStepNo: 9,
        repairAttempt: 0,
        logicalActionId: "action-p39-freshness",
        actionIndex: 0,
        callRef: "c",
      },
      recoveryBindingPolicyRevisions: {
        workspacePolicyRevision: 0,
        projectPolicyRevision: 0,
      },
    } as import("@arbor/ports").ToolExecutionContext;
    const appLayer = app(
      false,
      executor,
      {},
      trace,
      undefined,
      false,
      undefined,
      "newer-environment-revision",
    );
    const outcome = await Effect.runPromise(
      Effect.provide(
        Effect.match(
          Effect.gen(function* () {
            const runtime = yield* ToolRuntimePort;
            return yield* runtime.invoke(
              intent('{"target":{"mount":"workspace","path":"."}}') as never,
              p39Context,
            );
          }),
          {
            onFailure: (cause) => ({ _tag: "Failure" as const, cause }),
            onSuccess: (value) => ({ _tag: "Success" as const, value }),
          },
        ),
        appLayer,
      ),
    );

    expect(outcome._tag).toBe("Failure");
    expect(trace.environmentResolutions).toBeGreaterThan(0);
    expect(trace.resourceAdmissionCalls).toBe(0);
    expect(trace.intentWrites).toBe(0);
    expect(trace.approvalConsumes).toBe(0);
    expect(trace.p39BindingCalls).toBe(0);
    expect(trace.effectAdmissions).toBe(0);
    expect(trace.noEffectDenials).toEqual([]);
    expect(executorCalls).toBe(0);
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
      _tag: "ApprovalRequired",
    });
    expect(trace).toEqual({
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
    });
  });

  it("does not accept a P38 approval id without its exact executable context", async () => {
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
      "eap_018f2b3c-4d5e-7abc-8def-0123456789a1",
    );

    expect(result).toMatchObject({
      _tag: "Denied",
      reasonCode: "ApprovalNotFound",
    });
    expect(trace).toEqual({
      noEffectDenials: ["ApprovalNotFound"],
      events: ["denied"],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
    });
  });

  it("fails closed when this approval's consumer has no recorded invocation", async () => {
    const approvalExecutor: ToolExecutor = {
      name: "read",
      write: false,
      requiresApproval: () => true,
      execute: okExecutor.execute,
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
      consumedBy: invocationId,
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
      app(false, approvalExecutor, {}, trace, approval),
      argumentsJson,
      approvalId,
    );

    expect(result).toMatchObject({
      _tag: "Denied",
      reasonCode: "ApprovalConsumedByOtherInvocation",
    });
    expect(trace.approvalConsumes).toBe(0);
    expect(trace.intentWrites).toBe(0);
    expect(trace.effectAdmissions).toBe(0);
  });

  it("does not reuse a legacy approval consumed by another invocation", async () => {
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
    const consumedApproval: InvocationApproval = {
      approvalId,
      toolName: "read",
      toolVersion: "2",
      actionDigest: actionDigestOf(intent(argumentsJson)),
      targetResourceSpaceIds: ["filesystem"],
      controlBasisDigest: "d",
      expiresAt: "2999-01-01T00:00:00.000Z",
      consumedBy: invocationId,
    };
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
    };
    const otherInvocationId = parse(ToolInvocationId)(
      "tin_018f2b3c-4d5e-7abc-8def-0123456789a2",
    );
    const result = await run(
      app(false, approvalExecutor, {}, trace, consumedApproval),
      argumentsJson,
      approvalId,
      otherInvocationId,
    );

    expect(result).toMatchObject({
      _tag: "Denied",
      reasonCode: "ApprovalConsumedByOtherInvocation",
    });
    expect(trace.approvalConsumes).toBe(0);
    expect(trace.intentWrites).toBe(0);
    expect(trace.effectAdmissions).toBe(0);
    expect(executorCalls).toBe(0);
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
    const approval: ExecutableApprovalRecord = {
      executionId,
      logicalStepNo: 0,
      repairAttempt: 0,
      actionIndex: 0,
      logicalActionId: "action-post-claim-denial",
      projectId,
      workspaceId,
      subject: principal,
      callRef: intent(argumentsJson).callRef,
      toolInvocationId: invocationId,
      toolName: "read",
      toolVersion: "2",
      sideEffectSemantics: "ReadOnly",
      argumentsJson,
      actionDigest: actionDigestOf({ ...intent(argumentsJson), approvalId }),
      targetResourceSpaceIds: ["filesystem"],
      controlBasisDigest: "d",
      approvalId,
      routeKind: "Executable",
      revision: 4,
      requestedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2999-01-01T00:00:00.000Z",
      state: "Approved",
      decidedAt: "2026-01-01T00:00:01.000Z",
      decidedBy: principal,
      decisionReason: null,
      cancelledAt: null,
      cancelledBy: null,
      cancellationReason: null,
      consumedAt: null,
      consumedBy: null,
    };
    const approvedContext: import("@arbor/ports").ToolExecutionContext = {
      ...context,
      authority: { ...authority, sourceRevision: "source-revision-1" },
      executionFence: {
        executionId,
        workerId: "worker-a",
        workerIncarnationId: "incarnation-a",
        fencingGeneration: 0 as never,
      },
      executableApproval: {
        approvalId,
        expectedRevision: approval.revision,
        state: approval.state,
        binding: approval,
      },
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
      approvedContext,
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
