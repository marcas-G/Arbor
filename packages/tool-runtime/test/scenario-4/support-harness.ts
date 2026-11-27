import type { SandboxProviderCapability, WorkspaceId } from "@arbor/domain";
import {
  Clock,
  type ExecutableApprovalRecord,
  type InvocationApproval,
  type NoEffectDenialCode,
  ProjectEnvironmentPort,
  type RecoveryBindingV1,
  ResourceAdmission,
  SandboxPort,
  SandboxProcessPort,
  type SandboxProcessPortService,
  type SelectedP39EffectAttempt,
  type SelectedP39RecoveryEvidence,
  type ToolInvocationIntent,
  type ToolInvocationRecord,
  ToolInvocationStore,
  type ToolObservationEvidence,
  type ToolObservationEvidenceCandidate,
  type ToolObservationReplayFailureCode,
  type ToolReconciliationProfile,
  type ToolReconciliationRequest,
  type ToolReconciliationResult,
  TrustedLocalProcessPort,
  type TrustedLocalProcessPortService,
  type verifyRecoveryBindingV1,
  WorkspaceRepository,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import type { ToolRuntimeQualificationEvent } from "../../src/index.js";
import {
  executionId,
  fixtureWorkspaceAddresses,
  invocationId,
  projectId,
  workspaceId,
} from "./support.js";

export interface PipelineFaults {
  readonly workspaceLookup?: boolean;
  readonly environmentResolution?: boolean;
  readonly resourceAdmission?: boolean;
  readonly sandboxOpen?: boolean;
  readonly sandboxClose?: boolean;
  readonly intentJournal?: boolean;
  readonly settlementJournal?: boolean;
  readonly settlementUnapplied?: boolean;
}

export interface PipelineTrace {
  processExecutionMode?: "Disabled" | "NativeOsSupportedOnly";
  nativeOsSupportedTupleAvailable?: boolean;
  testOnlyAllowTrustedLocalProcessExecution?: boolean;
  readonly noEffectDenials: Array<string>;
  readonly events: Array<string>;
  approvalConsumer: string | null;
  intentWrites: number;
  settlementWrites?: number;
  effectAdmissions: number;
  approvalConsumes: number;
  effectAdmissionDenial?: NoEffectDenialCode;
  resourceAdmissionDeniedAtCall?: number;
  afterAuthorityResolved?: () => Promise<void>;
  environmentResolutions?: number;
  resourceAdmissionCalls?: number;
  p39BindingCalls?: number;
  p39SelectedReads?: number;
  authorityResolutionCalls?: number;
  sandboxOpenedMountRefs?: ReadonlyArray<string>;
  trustedLocalProcessRuns?: number;
  readonly reconciliationRetry?: {
    readonly profile: ToolReconciliationProfile;
    readonly registryProfileOverride?: ToolReconciliationProfile;
    readonly verifiedBinding: NonNullable<
      ReturnType<typeof verifyRecoveryBindingV1>
    >;
    readonly attempt: SelectedP39EffectAttempt;
    readonly authority: import("@arbor/ports").InvocationAuthority;
    readonly result: ToolReconciliationResult;
    readonly factId: string;
    readonly settlementEvidence: ToolObservationEvidence;
    readonly failFactWrite?: boolean;
    readonly denyAuthorityOnCall?: number | null;
    readonly priorOverride?: ToolInvocationRecord;
    readonly bindingOverride?: NonNullable<
      ReturnType<typeof verifyRecoveryBindingV1>
    >;
  };
  reconciliationFactWrites?: number;
  reconciliationCalls?: number;
  reconciliationRequests?: Array<ToolReconciliationRequest>;
  rejectFenceAfterReconciliation?: boolean;
  qualificationEvents?: Array<ToolRuntimeQualificationEvent>;
  p39SelectedEvidence?: SelectedP39RecoveryEvidence;
  p39SelectedFenceReject?: boolean;
  p40ReadInvocations?: Array<ToolInvocationIntent>;
  p40ReadFences?: Array<
    NonNullable<import("@arbor/ports").ToolExecutionContext["executionFence"]>
  >;
  p40ReadFenceTimes?: Array<string>;
  p40ReadFailure?: ToolObservationReplayFailureCode;
  retryAttemptNumbers?: Array<number>;
  p40Candidates?: Array<ToolObservationEvidenceCandidate>;
  readonly existingInvocationAfterStop?: ToolInvocationRecord;
  readonly profilelessLegacyInvocation?: ToolInvocationRecord;
  legacyInterruptedInvocation?: ToolInvocationRecord;
  legacyNoEffectInterruptionWrites?: number;
  readonly p40WinnerEvidence?: ToolObservationEvidence;
  readonly sandboxCapabilities?: ReadonlyArray<SandboxProviderCapability>;
  sandboxProcessPortRuns?: number;
  sandboxProcessTimeouts?: Array<number>;
  persistedSandboxInvocation?: ToolInvocationRecord;
  readonly persistSandboxInvocations?: boolean;
  transactionDepth?: number;
  readonly stopAtEffectAdmission?: boolean;
  readonly resolvedEnvironmentRevisionSequence?: ReadonlyArray<string>;
  readonly currentEnvironmentRevisionValues?: ReadonlyArray<string | null>;
  readonly workspaceBoundaryAddresses?: ReadonlyArray<
    import("@arbor/domain").ResourceAddress
  >;
  readonly workspaceRevisionSequence?: ReadonlyArray<number>;
  readonly workspaceBoundaryAddressSequence?: ReadonlyArray<
    ReadonlyArray<import("@arbor/domain").ResourceAddress>
  >;
  workspaceSnapshots?: Array<{
    readonly phase:
      | "InitialBoundaryResolve"
      | "RefreshedBoundaryResolve"
      | "FinalClaimFreshness";
    readonly workspaceId: WorkspaceId;
    readonly revision: number;
    readonly addresses: ReadonlyArray<import("@arbor/domain").ResourceAddress>;
  }>;
  resourceAdmissionRegions?: Array<
    ReadonlyArray<import("@arbor/domain").CanonicalResourceRegion>
  >;
  resourceAdmissionBoundaryRegions?: Array<
    ReadonlyArray<import("@arbor/domain").CanonicalResourceRegion>
  >;
  claimedBindings?: Array<RecoveryBindingV1>;
}

/**
 * Boxed mutable harness state. The original single app() closure rebound
 * these five locals while the layer factories ran; splitting the factories
 * into top-level functions routes the same reads/writes through these cells.
 */
export interface MutableState {
  approval: { value: InvocationApproval | undefined };
  executableApproval: { value: ExecutableApprovalRecord | undefined };
  environmentResolutionIndex: { value: number };
  environmentRevisionReadIndex: { value: number };
  workspaceReadIndex: { value: number };
}

export type HarnessRetry = NonNullable<PipelineTrace["reconciliationRetry"]>;

/** Fresh mandatory trace state — the baseline every pipeline test extends
 * with its scenario deltas (cross-file fixture convergence for the split
 * scenario-4 files). */
export const newTrace = (): PipelineTrace => ({
  noEffectDenials: [],
  events: [],
  approvalConsumer: null,
  intentWrites: 0,
  effectAdmissions: 0,
  approvalConsumes: 0,
});

/** The standard reconciliation-retry wiring from a retry fixture: the
 * seven-field block every P39 replay test repeated verbatim. */
export const retryHarness = (fixture: {
  readonly profile: ToolReconciliationProfile;
  readonly verifiedBinding: NonNullable<
    ReturnType<typeof verifyRecoveryBindingV1>
  >;
  readonly attempt: SelectedP39EffectAttempt;
  readonly authority: import("@arbor/ports").InvocationAuthority;
  readonly result: ToolReconciliationResult;
  readonly factId: string;
  readonly settlementEvidence: ToolObservationEvidence;
}): HarnessRetry => ({
  profile: fixture.profile,
  verifiedBinding: fixture.verifiedBinding,
  attempt: fixture.attempt,
  authority: fixture.authority,
  result: fixture.result,
  factId: fixture.factId,
  settlementEvidence: fixture.settlementEvidence,
});

export const sandboxDeps = (
  faults: PipelineFaults,
  trace: PipelineTrace | undefined,
) =>
  Layer.succeed(SandboxPort, {
    open: (input) =>
      faults.sandboxOpen === true
        ? Effect.fail({
            _tag: "SandboxError" as const,
            cause: "sandbox-open-failure",
          })
        : Effect.sync(() => {
            const openedMounts = input.mounts?.map((mount) => ({
              ...mount,
              rootPath:
                mount.ref === "workspace" ? "/tmp/s" : `/tmp/${mount.ref}`,
            })) ?? [
              {
                ref: "workspace",
                rootPath: "/tmp/s",
                region: {
                  resourceSpaceId: "filesystem",
                  normalizedRegion: {},
                },
                access: "ReadOnly" as const,
              },
            ];
            if (trace !== undefined)
              trace.sandboxOpenedMountRefs = openedMounts.map(
                (mount) => mount.ref,
              );
            return {
              handleId: "s",
              rootPath: "/tmp/s",
              mounts: openedMounts,
              writableRegions: openedMounts
                .filter((mount) => mount.access === "ReadWrite")
                .map((mount) => mount.region),
            };
          }),
    close: () =>
      faults.sandboxClose === true
        ? Effect.fail({
            _tag: "SandboxError" as const,
            cause: "sandbox-close-failure",
          })
        : Effect.succeed(true),
  });

export const sandboxProcessDeps = (trace: PipelineTrace | undefined) =>
  Layer.succeed(SandboxProcessPort, {
    capabilities: () => Effect.succeed(trace?.sandboxCapabilities ?? []),
    run: (request) =>
      Effect.sync(() => {
        if (trace !== undefined) {
          trace.sandboxProcessPortRuns =
            (trace.sandboxProcessPortRuns ?? 0) + 1;
          trace.sandboxProcessTimeouts ??= [];
          trace.sandboxProcessTimeouts.push(request.timeoutMs);
        }
        return {
          _tag: "Completed" as const,
          exitCode: 0,
          stdout: "process succeeded",
          stderr: "",
          timedOut: false,
          truncated: false,
        };
      }),
  } satisfies SandboxProcessPortService);

export const trustedLocalDeps = (trace: PipelineTrace | undefined) =>
  Layer.succeed(TrustedLocalProcessPort, {
    run: () =>
      Effect.sync(() => {
        if (trace !== undefined)
          trace.trustedLocalProcessRuns =
            (trace.trustedLocalProcessRuns ?? 0) + 1;
        return {
          _tag: "Completed" as const,
          exitCode: 0,
          stdout: "trusted local process succeeded",
          stderr: "",
          timedOut: false,
          truncated: false,
        };
      }),
  } satisfies TrustedLocalProcessPortService);

export const resourceAdmissionDeps = (
  admissionDeny: boolean,
  faults: PipelineFaults,
  trace: PipelineTrace | undefined,
  p39BindingEnabled: boolean,
) =>
  Layer.succeed(ResourceAdmission, {
    admit: (input: {
      readonly regions: ReadonlyArray<
        import("@arbor/domain").CanonicalResourceRegion
      >;
      readonly resolvedBoundaryRegions: ReadonlyArray<
        import("@arbor/domain").CanonicalResourceRegion
      >;
    }) => {
      let admissionCall = 0;
      if (p39BindingEnabled && trace !== undefined) {
        trace.resourceAdmissionCalls = (trace.resourceAdmissionCalls ?? 0) + 1;
        admissionCall = trace.resourceAdmissionCalls;
        if (trace.resourceAdmissionRegions === undefined) {
          trace.resourceAdmissionRegions = [];
        }
        trace.resourceAdmissionRegions.push(input.regions);
        if (trace.resourceAdmissionBoundaryRegions === undefined) {
          trace.resourceAdmissionBoundaryRegions = [];
        }
        trace.resourceAdmissionBoundaryRegions.push(
          input.resolvedBoundaryRegions,
        );
      }
      return faults.resourceAdmission === true
        ? Effect.fail({
            _tag: "ResourceAdmissionError" as const,
            cause: "admission-failure",
          })
        : Effect.succeed(
            admissionDeny ||
              trace?.resourceAdmissionDeniedAtCall === admissionCall
              ? { _tag: "Denied" as const, reason: "no" }
              : { _tag: "Admitted" as const },
          );
    },
  } as never);

export const invocationStoreDeps = (
  s: MutableState,
  faults: PipelineFaults,
  trace: PipelineTrace | undefined,
  p39DeniedReplay: ToolInvocationRecord | undefined,
  reconciliationRetry: HarnessRetry | undefined,
) =>
  Layer.succeed(ToolInvocationStore, {
    recordIntent: (record: ToolInvocationIntent) => {
      if (trace !== undefined) {
        if (trace.persistSandboxInvocations === true) {
          if (trace.persistedSandboxInvocation === undefined) {
            trace.persistedSandboxInvocation = {
              ...record,
              effectAdmissionState: "NotAdmitted",
              settledAt: null,
              settlement: null,
              resultRef: null,
            };
            trace.intentWrites += 1;
            trace.events.push("intent");
          }
        } else {
          trace.intentWrites += 1;
          trace.events.push("intent");
        }
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
    settle: (
      id: typeof invocationId,
      settlement: ToolInvocationRecord["settlement"],
      resultRef: string | null,
      settledAt: string,
    ) => {
      if (trace !== undefined) {
        trace.settlementWrites = (trace.settlementWrites ?? 0) + 1;
        trace.events.push("settlement");
        if (
          trace.persistSandboxInvocations === true &&
          trace.persistedSandboxInvocation?.invocationId === id
        ) {
          trace.persistedSandboxInvocation = {
            ...trace.persistedSandboxInvocation,
            settledAt,
            settlement,
            resultRef,
          };
        }
      }
      return faults.settlementJournal === true
        ? Effect.fail({
            _tag: "PersistenceUnavailable" as const,
            repository: "ToolInvocationStore" as const,
            operation: "settle-test",
            retryDisposition: "retryable" as const,
            sourceTag: "InjectedFailure",
            cause: "settlement-journal-failure",
          })
        : Effect.succeed(faults.settlementUnapplied !== true);
    },
    consumeApproval: () => {
      if (trace !== undefined) {
        trace.approvalConsumes += 1;
        trace.events.push("consume");
      }
      if (
        s.approval.value === undefined ||
        s.approval.value.consumedBy !== null
      ) {
        return Effect.succeed(false);
      }
      s.approval.value = { ...s.approval.value, consumedBy: invocationId };
      if (trace !== undefined) trace.approvalConsumer = String(invocationId);
      return Effect.succeed(true);
    },
    recordNoEffectDenial: (
      invocation: ToolInvocationRecord,
      reasonCode: string,
      settledAt: string,
    ) =>
      Effect.sync(() => {
        if (trace !== undefined) {
          trace.noEffectDenials.push(reasonCode);
          trace.events.push("denied");
          trace.settlementWrites = (trace.settlementWrites ?? 0) + 1;
        }
        const deniedRecord = {
          ...invocation,
          effectAdmissionState: "NotAdmitted" as const,
          settledAt,
          settlement: {
            _tag: "Denied" as const,
            reasonCode: reasonCode as never,
          },
          resultRef: null,
        };
        if (
          trace?.persistSandboxInvocations === true &&
          trace.persistedSandboxInvocation?.invocationId ===
            invocation.invocationId
        ) {
          trace.persistedSandboxInvocation = deniedRecord;
        }
        return deniedRecord;
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
    admitEffect: (id: typeof invocationId) => {
      if (trace !== undefined) {
        trace.effectAdmissions += 1;
        trace.events.push("effect-admission");
        if (
          trace.persistSandboxInvocations === true &&
          trace.persistedSandboxInvocation?.invocationId === id
        )
          trace.persistedSandboxInvocation = {
            ...trace.persistedSandboxInvocation,
            effectAdmissionState: "MayHaveStarted",
          };
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
        s.approval.value === undefined
          ? Option.none()
          : Option.some(s.approval.value),
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
        if (trace?.profilelessLegacyInvocation !== undefined) {
          return Effect.succeed(Option.some(trace.profilelessLegacyInvocation));
        }
        if (p39DeniedReplay !== undefined) {
          return Effect.succeed(Option.some(p39DeniedReplay));
        }
        if (reconciliationRetry?.priorOverride !== undefined) {
          return Effect.succeed(Option.some(reconciliationRetry.priorOverride));
        }
        if (
          trace?.persistSandboxInvocations === true &&
          trace.persistedSandboxInvocation !== undefined
        )
          return Effect.succeed(Option.some(trace.persistedSandboxInvocation));
        return Effect.succeed(
          faults.settlementUnapplied === true && calls > 1
            ? Option.some(canonicalUnknown)
            : Option.none(),
        );
      };
    })(),
    findUnsettled: () => Effect.succeed([]),
  } as never);

export const projectEnvironmentDeps = (
  s: MutableState,
  faults: PipelineFaults,
  trace: PipelineTrace | undefined,
  p39BindingEnabled: boolean,
  _resolvedEnvironmentRevisionSequence: ReadonlyArray<string> | undefined,
) =>
  Layer.succeed(ProjectEnvironmentPort, {
    resolve: (_p, addresses) => {
      if (p39BindingEnabled && trace !== undefined) {
        trace.environmentResolutions = (trace.environmentResolutions ?? 0) + 1;
      }
      const observedEnvironmentRevision =
        trace?.resolvedEnvironmentRevisionSequence?.[
          s.environmentResolutionIndex.value
        ] ?? "rev";
      s.environmentResolutionIndex.value += 1;
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
            observedEnvironmentRevision,
          });
    },
  });

export const workspaceRepositoryDeps = (
  s: MutableState,
  faults: PipelineFaults,
  trace: PipelineTrace | undefined,
) =>
  Layer.succeed(WorkspaceRepository, {
    findById: () => {
      if (faults.workspaceLookup === true) {
        return Effect.fail({
          _tag: "PersistenceUnavailable" as const,
          repository: "WorkspaceRepository" as const,
          operation: "test",
          retryDisposition: "retryable" as const,
          sourceTag: "InjectedFailure",
          cause: "workspace-lookup-failure",
        });
      }
      const readIndex = s.workspaceReadIndex.value;
      s.workspaceReadIndex.value += 1;
      const revisions = trace?.workspaceRevisionSequence;
      const addressesByRead = trace?.workspaceBoundaryAddressSequence;
      const resolvedEnvironments = trace?.resolvedEnvironmentRevisionSequence;
      const refreshRequired =
        resolvedEnvironments !== undefined &&
        resolvedEnvironments[0] !== resolvedEnvironments[1];
      const revision = revisions?.[readIndex] ?? revisions?.at(-1) ?? 0;
      const addresses =
        addressesByRead?.[readIndex] ??
        addressesByRead?.at(-1) ??
        trace?.workspaceBoundaryAddresses ??
        fixtureWorkspaceAddresses;
      if (trace !== undefined) {
        if (trace.workspaceSnapshots === undefined) {
          trace.workspaceSnapshots = [];
        }
        trace.workspaceSnapshots.push({
          phase:
            readIndex === 0
              ? "InitialBoundaryResolve"
              : refreshRequired && readIndex === 1
                ? "RefreshedBoundaryResolve"
                : "FinalClaimFreshness",
          workspaceId,
          revision,
          addresses,
        });
      }
      return Effect.succeed(
        Option.some({
          projectId,
          resourceBoundaryRevision: revision,
          resourceBoundary: { addresses },
        }),
      );
    },
  } as never);

export const clockDeps = () =>
  Layer.succeed(Clock, {
    now: () => Effect.succeed("2026-01-01T00:00:00.000Z"),
  });
