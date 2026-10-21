import {
  Actor,
  ArtifactId,
  canonicalRegionString,
  type ExecutionEpisodeBinding,
  ExecutionId,
  Principal,
  ProjectId,
  ProviderTurnId,
  parse,
  type SandboxProviderCapability,
  SessionId,
  ToolInvocationId,
  WorkspaceId,
} from "@arbor/domain";
import {
  ArtifactService,
  Clock,
  canonicalArgumentsDigestV1,
  canonicalizeRecoveryBindingV1,
  EnvironmentRevisionStore,
  type ExecutableApprovalRecord,
  ExecutableApprovalStore,
  type ExecutableApprovalStoreService,
  type InvocationApproval,
  makeToolReconciliationProfileRegistry,
  type NoEffectDenialCode,
  P39RecoveryEvidenceStore,
  ProjectEnvironmentPort,
  type RecoveryBindingV1,
  ResourceAdmission,
  reconciliationFactId,
  recoveryBindingV1Digest,
  type SandboxMountBinding,
  SandboxPort,
  type SandboxProcessPolicy,
  SandboxProcessPort,
  type SandboxProcessPortService,
  type SelectedP39EffectAttempt,
  type SelectedP39ReconciliationFact,
  type SelectedP39RecoveryEvidence,
  ToolAuthorityResolver,
  ToolDefinitionStore,
  type ToolInvocationIntent,
  type ToolInvocationRecord,
  ToolInvocationStore,
  type ToolObservationEvidence,
  type ToolObservationEvidenceCandidate,
  ToolObservationEvidenceStore,
  type ToolObservationReplayFailureCode,
  ToolReconciliationFactStore,
  ToolReconciliationPort,
  type ToolReconciliationProfile,
  ToolReconciliationProfileRegistry,
  type ToolReconciliationRequest,
  type ToolReconciliationResult,
  type ToolRuntimeError,
  ToolRuntimePort,
  TransactionPort,
  TransactionScope,
  TrustedLocalProcessPort,
  type TrustedLocalProcessPortService,
  targetResourceIdentityDigestV1,
  toolDefinitionIdentityDigestV1,
  verifyRecoveryBindingV1,
  WorkspaceRepository,
} from "@arbor/ports";
import { Effect, Exit, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  actionDigestOf,
  LEGACY_SHELL_DEFINITION,
  reconciliationRetryDenialReasonCode,
  ToolDefinitionStoreLive,
  type ToolExecutor,
  ToolRuntimeLive,
  type ToolRuntimeQualificationEvent,
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

const p39ApprovedCase = (
  suffix: "c4" | "c5" | "c6" | "c7",
  logicalActionId: string,
) => {
  const argumentsJson = '{"target":{"mount":"workspace","path":"."}}';
  const approvalId = `eap_018f2b3c-4d5e-7abc-8def-0123456789${suffix}`;
  const approval: ExecutableApprovalRecord = {
    executionId,
    logicalStepNo: 13,
    repairAttempt: 0,
    actionIndex: 0,
    logicalActionId,
    projectId,
    workspaceId,
    subject: principal,
    callRef: intent(argumentsJson).callRef,
    toolInvocationId: invocationId,
    toolName: "read",
    toolVersion: "2",
    sideEffectSemantics: "ReadOnly",
    argumentsJson,
    actionDigest: actionDigestOf({
      ...intent(argumentsJson),
      approvalId,
    }),
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
    authority: {
      ...authority,
      sourceRevision: JSON.stringify({
        workspacePolicyRevision: 0,
        activeGrants: [],
        verifierId: null,
      }),
    },
    recoveryBindingIdentity: {
      executionId,
      providerTurnId: parse(ProviderTurnId)(
        `ptn_018f2b3c-4d5e-7abc-8def-0123456789${suffix}`,
      ),
      logicalStepNo: 13,
      repairAttempt: 0,
      logicalActionId,
      actionIndex: 0,
      callRef: "c",
    },
    recoveryBindingPolicyRevisions: {
      workspacePolicyRevision: 0,
      projectPolicyRevision: 0,
    },
    executableApproval: {
      approvalId,
      expectedRevision: approval.revision,
      state: approval.state,
      binding: approval,
    },
  };
  const executor: ToolExecutor = {
    ...okExecutor,
    requiresApproval: () => true,
  };
  return { argumentsJson, approval, approvedContext, executor, approvalId };
};

const p39NotOccurredRetryCase = (
  denialReasonCode:
    | "AuthoritySnapshotChanged"
    | "ResourceSnapshotChanged" = "AuthoritySnapshotChanged",
) => {
  const argumentsJson = JSON.stringify({
    command: "echo p4-reconciliation-retry",
    cwd: { mount: "workspace", path: "." },
  });
  const callRef = "c";
  const providerTurnId = parse(ProviderTurnId)(
    "ptn_018f2b3c-4d5e-7abc-8def-0123456789a3",
  );
  const logicalActionId = "lac_p4_reconciliation_retry_denied";
  const controlBasisDigest = "d".repeat(64);
  const authoritySourceRevision = JSON.stringify({
    workspacePolicyRevision: 0,
    activeGrants: [],
    verifierId: null,
  });
  const shellAuthority = {
    ...authority,
    toolName: "shell",
    toolVersion: "2",
    sourceRevision: authoritySourceRevision,
    resourceSpaceIds: ["filesystem"],
    allowedCapabilities: ["shell:exec"],
    controlBasisDigest,
  };
  const retryContext: import("@arbor/ports").ToolExecutionContext = {
    ...context,
    authority: shellAuthority,
    controlBasisDigest,
    providerTurnId,
    logicalActionId,
    recoveryBindingIdentity: {
      executionId,
      providerTurnId,
      logicalStepNo: 0,
      repairAttempt: 0,
      logicalActionId,
      actionIndex: 0,
      callRef,
    },
    recoveryBindingPolicyRevisions: {
      workspacePolicyRevision: 0,
      projectPolicyRevision: 0,
    },
  };
  const regions = [
    {
      resourceSpaceId: "filesystem",
      normalizedRegion: { _tag: "GitWorktree" as const, path: "/repo/a" },
    },
  ];
  const profile: ToolReconciliationProfile = {
    toolName: "shell",
    toolVersion: "2",
    toolDefinitionHash: LEGACY_SHELL_DEFINITION.hash,
    profileId: "p4-pipeline-retry-gate",
    profileVersion: "1",
    profileHash: "a".repeat(64),
    profileProtocol: "p4-pipeline-test-v1",
    effectKey: ({ invocationId: id }) => `p4-test:${id}`,
    reconstructOccurred: () => null,
  };
  const effectKey = profile.effectKey({ invocationId, argumentsJson });
  if (effectKey === null) throw new Error("test profile effect key missing");
  const binding: RecoveryBindingV1 = {
    bindingVersion: 1,
    digestAlgorithm: "SHA-256",
    executionId,
    invocationId,
    providerTurnId,
    logicalStepNo: 0,
    repairAttempt: 0,
    logicalActionId,
    actionIndex: 0,
    callRef,
    toolName: "shell",
    toolVersion: "2",
    toolDefinitionHash: toolDefinitionIdentityDigestV1(
      LEGACY_SHELL_DEFINITION.hash,
    ),
    sideEffectSemantics: "Reconcilable",
    canonicalArgumentsDigest: canonicalArgumentsDigestV1(
      JSON.parse(argumentsJson),
    ),
    targetResourceIdentityDigest: targetResourceIdentityDigestV1(regions),
    resourceBoundaryRevision: 0,
    environmentRevision: "rev",
    authoritySourceRevision,
    principalId: String(principal),
    capability: ["shell:exec"],
    permissionGrantRevisions: [],
    workspacePolicyRevision: 0,
    projectPolicyRevision: 0,
    controlBasisDigest,
    approvalId: null,
    approvalSubject: null,
    approvalPreConsumeRevision: null,
    approvalConsumedRevision: null,
    approvalExpiresAt: null,
    approvalTargetDigest: null,
    approvalActionDigest: null,
    approvalConsumedBy: null,
    profileId: profile.profileId,
    profileVersion: profile.profileVersion,
    profileHash: profile.profileHash,
    profileProtocol: profile.profileProtocol,
    effectKey,
  };
  const canonicalJson = canonicalizeRecoveryBindingV1(binding);
  const bindingSha256 = recoveryBindingV1Digest(binding);
  const verifiedBinding = verifyRecoveryBindingV1({
    invocationId,
    canonicalJson,
    bindingSha256,
  });
  if (verifiedBinding === null) {
    throw new Error("test RecoveryBindingV1 did not verify");
  }
  const result: ToolReconciliationResult = {
    _tag: "NotOccurred",
    proof: {
      invocationId,
      attemptNo: 0,
      bindingSha256,
      profileHash: profile.profileHash,
      effectKey,
      sourceRevision: "p4-test-ledger-v1",
      sourceWatermark: "p4-test-final-watermark",
      observedAt: "2026-01-01T00:00:03.000Z",
      visibilityScopeSha256: binding.targetResourceIdentityDigest,
      evidenceRef: "art_p4_reconcile_proof",
      evidenceSha256: "b".repeat(64),
      finality: {
        _tag: "ExternallyFenced",
        confirmationRef: "p4-test-no-effect-fence",
        confirmedAt: "2026-01-01T00:00:03.000Z",
      },
    },
  };
  const factId = reconciliationFactId({
    request: {
      invocationId,
      attemptNo: 0,
      bindingSha256,
      profileHash: profile.profileHash,
      effectKey,
      visibilityScopeSha256: binding.targetResourceIdentityDigest,
    },
    result,
    factDisposition: "RecoveryInput",
    evidenceSha256:
      result._tag === "NotOccurred" ? result.proof.evidenceSha256 : null,
  });
  const observation = {
    _tag: "ReconciledNoEffect" as const,
    reasonCode: denialReasonCode,
    reconciliationFactRef: factId,
    observation: {
      text: "authoritative source confirmed no effect",
      truncated: false,
    },
    resultRef: "art_p4_reconcile_observation",
  };
  const settlementEvidence: ToolObservationEvidence = {
    formatVersion: "p4-canonical-tool-observation-v1",
    bytes: new TextEncoder().encode(JSON.stringify(observation)),
    sha256: "c".repeat(64),
    observation,
  };
  const attempt: SelectedP39EffectAttempt = {
    invocationId,
    attemptNo: 0,
    admissionState: "MayHaveStarted",
    bindingSha256,
    toolDefinitionHash: binding.toolDefinitionHash,
    sideEffectSemantics: "Reconcilable",
    profileId: profile.profileId,
    profileVersion: profile.profileVersion,
    profileHash: profile.profileHash,
    profileProtocol: profile.profileProtocol,
    effectKey,
    admittedAt: "2026-01-01T00:00:02.000Z",
    admissionSource: "P39Admission",
    admissionTimePrecision: "TransactionTimestamp",
  };
  const prior: ToolInvocationRecord = {
    invocationId,
    executionId,
    workspaceId,
    toolName: "shell",
    toolVersion: "2",
    sideEffectSemantics: "Reconcilable",
    argumentsJson,
    resolvedRegions: regions,
    approvalId: null,
    effectAdmissionState: "MayHaveStarted",
    intentAt: "2026-01-01T00:00:01.000Z",
    settledAt: null,
    settlement: null,
    resultRef: null,
  };
  return {
    argumentsJson,
    context: retryContext,
    profile,
    verifiedBinding,
    attempt,
    result,
    factId,
    settlementEvidence,
    prior,
    authority: shellAuthority,
  };
};

const p39TerminalReceiptCase = (
  terminalKind: "NotOccurred" | "Success" | "ExpectedFailure" = "NotOccurred",
) => {
  const retry = p39NotOccurredRetryCase("ResourceSnapshotChanged");
  const resultRef = "art_p4_occurred_terminal_result";
  const factOutcome =
    terminalKind === "NotOccurred" ? "NotOccurred" : "Occurred";
  const p40Observation =
    terminalKind === "NotOccurred"
      ? retry.settlementEvidence.observation
      : terminalKind === "Success"
        ? {
            _tag: "Success" as const,
            observation: {
              text: "authoritative effect result",
              truncated: false,
            },
            resultRef,
          }
        : {
            _tag: "ExpectedFailure" as const,
            observation: {
              text: "authoritative effect result was an expected failure",
              truncated: false,
            },
          };
  const settlementEvidence: ToolObservationEvidence =
    terminalKind === "NotOccurred"
      ? retry.settlementEvidence
      : {
          formatVersion: "p4-canonical-tool-observation-v1",
          bytes: new TextEncoder().encode(JSON.stringify(p40Observation)),
          sha256: "d".repeat(64),
          observation: p40Observation,
        };
  const fact: SelectedP39ReconciliationFact = {
    factId: retry.factId,
    invocationId,
    attemptNo: 0,
    bindingSha256: retry.verifiedBinding.bindingSha256,
    profileHash: retry.profile.profileHash,
    effectKey: retry.attempt.effectKey,
    factOrigin: "ProfileReconciliation",
    legacyReason: null,
    factDisposition: "RecoveryInput",
    outcome: factOutcome,
    reasonCode: null,
    evidenceRef: "art_p4_reconcile_proof",
    evidenceSha256: "b".repeat(64),
    resultRef: factOutcome === "Occurred" ? resultRef : null,
    observedAt: "2026-01-01T00:00:03.000Z",
  };
  return {
    ...retry,
    settlementEvidence,
    prior: {
      ...retry.prior,
      settledAt: "2026-01-01T00:00:04.000Z",
      settlement:
        terminalKind === "NotOccurred"
          ? {
              _tag: "ReconciledNoEffect" as const,
              reasonCode: "ResourceSnapshotChanged" as const,
              reconciliationFactRef: retry.factId,
            }
          : terminalKind === "Success"
            ? { _tag: "Success" as const }
            : { _tag: "ExpectedFailure" as const },
      resultRef: terminalKind === "Success" ? resultRef : null,
    } satisfies ToolInvocationRecord,
    selected: {
      binding: retry.verifiedBinding,
      attempt: retry.attempt,
      fact,
    } satisfies SelectedP39RecoveryEvidence,
  };
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

const fixtureWorkspaceAddresses = [
  { _tag: "GitWorktree", path: "/repo/a" },
] as const satisfies ReadonlyArray<import("@arbor/domain").ResourceAddress>;

const expectWorkspaceSnapshotPhases = (
  trace: PipelineTrace,
  expected: NonNullable<PipelineTrace["workspaceSnapshots"]>,
) => {
  expect(trace.workspaceSnapshots).toEqual(expected);
};

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
  reconciliationRetry?: NonNullable<PipelineTrace["reconciliationRetry"]>,
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
    reconciliationRetry !== undefined ||
    p39CurrentEnvironmentRevision !== undefined ||
    trace?.currentEnvironmentRevisionValues !== undefined;
  let environmentResolutionIndex = 0;
  let environmentRevisionReadIndex = 0;
  let workspaceReadIndex = 0;
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
      Effect.suspend(() => {
        if (trace !== undefined)
          trace.transactionDepth = (trace.transactionDepth ?? 0) + 1;
        return Effect.provideService(body, TransactionScope, {
          session: { id: "t" },
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (trace !== undefined)
                trace.transactionDepth = (trace.transactionDepth ?? 1) - 1;
            }),
          ),
        );
      }),
  });
  const baseDeps = Layer.mergeAll(
    tx,
    ToolDefinitionStoreLive,
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
    }),
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
    } satisfies SandboxProcessPortService),
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
    } satisfies TrustedLocalProcessPortService),
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
          trace.resourceAdmissionCalls =
            (trace.resourceAdmissionCalls ?? 0) + 1;
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
    } as never),
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
          if (trace?.profilelessLegacyInvocation !== undefined) {
            return Effect.succeed(
              Option.some(trace.profilelessLegacyInvocation),
            );
          }
          if (p39DeniedReplay !== undefined) {
            return Effect.succeed(Option.some(p39DeniedReplay));
          }
          if (reconciliationRetry?.priorOverride !== undefined) {
            return Effect.succeed(
              Option.some(reconciliationRetry.priorOverride),
            );
          }
          if (
            trace?.persistSandboxInvocations === true &&
            trace.persistedSandboxInvocation !== undefined
          )
            return Effect.succeed(
              Option.some(trace.persistedSandboxInvocation),
            );
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
        const observedEnvironmentRevision =
          trace?.resolvedEnvironmentRevisionSequence?.[
            environmentResolutionIndex
          ] ?? "rev";
        environmentResolutionIndex += 1;
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
    }),
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
        const readIndex = workspaceReadIndex;
        workspaceReadIndex += 1;
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
            read: (
              invocation: ToolInvocationIntent,
              _fence: NonNullable<
                import("@arbor/ports").ToolExecutionContext["executionFence"]
              >,
              _fenceNow: string,
            ) => {
              trace.p40ReadInvocations ??= [];
              trace.p40ReadInvocations.push(invocation);
              trace.p40ReadFences ??= [];
              trace.p40ReadFences.push(_fence);
              trace.p40ReadFenceTimes ??= [];
              trace.p40ReadFenceTimes.push(_fenceNow);
              return trace.p40ReadFailure === undefined
                ? Effect.succeed(
                    trace.p40WinnerEvidence as ToolObservationEvidence,
                  )
                : Effect.fail({
                    _tag: "ToolObservationReplayEvidenceFailure" as const,
                    invocationId: invocation.invocationId,
                    failureCode: trace.p40ReadFailure,
                  });
            },
            settleOrReadWinner: () =>
              Effect.succeed({
                _tag: "Existing" as const,
                evidence: trace.p40WinnerEvidence as ToolObservationEvidence,
              }),
          } as never),
        );
  const authorityResolverLayer = reconciliationRetry
    ? Layer.succeed(ToolAuthorityResolver, {
        resolve: (() => {
          let calls = 0;
          return () => {
            calls += 1;
            if (trace !== undefined) {
              trace.authorityResolutionCalls = calls;
            }
            return reconciliationRetry.denyAuthorityOnCall === calls
              ? Effect.fail({ _tag: "ToolAuthorityDenied" as const })
              : Effect.succeed(reconciliationRetry.authority);
          };
        })(),
      })
    : authorityDenied
      ? Layer.succeed(ToolAuthorityResolver, {
          resolve: () => Effect.fail({ _tag: "ToolAuthorityDenied" as const }),
        })
      : undefined;
  const deps =
    authorityResolverLayer !== undefined
      ? Layer.mergeAll(evidenceDeps, authorityResolverLayer)
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
    trace === undefined
      ? {}
      : {
          qualificationProbe: async (event) => {
            trace.qualificationEvents ??= [];
            trace.qualificationEvents.push(event);
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
          current: () => {
            const value =
              trace?.currentEnvironmentRevisionValues?.[
                environmentRevisionReadIndex
              ];
            environmentRevisionReadIndex += 1;
            return Effect.succeed(
              value !== undefined
                ? value === null
                  ? Option.none()
                  : Option.some(value as never)
                : p39CurrentEnvironmentRevision === undefined
                  ? Option.none()
                  : Option.some(p39CurrentEnvironmentRevision as never),
            );
          },
          record: () => Effect.void,
          lazyInitAnchor: () => Effect.void,
        }),
        Layer.succeed(P39RecoveryEvidenceStore, {
          bindClaim: ({ binding }: { readonly binding: RecoveryBindingV1 }) => {
            if (trace !== undefined) {
              trace.p39BindingCalls = (trace.p39BindingCalls ?? 0) + 1;
              if (trace.claimedBindings === undefined) {
                trace.claimedBindings = [];
              }
              trace.claimedBindings.push(binding);
            }
            return Effect.succeed("Bound" as const);
          },
          findBinding: (id: typeof invocationId) => {
            if (reconciliationRetry !== undefined)
              return Effect.succeed(
                Option.some(
                  reconciliationRetry.bindingOverride ??
                    reconciliationRetry.verifiedBinding,
                ),
              );
            const binding =
              trace?.persistSandboxInvocations === true
                ? trace.claimedBindings?.find(
                    (candidate) => candidate.invocationId === id,
                  )
                : undefined;
            if (binding === undefined) return Effect.succeed(Option.none());
            const verified = verifyRecoveryBindingV1({
              invocationId: id,
              canonicalJson: canonicalizeRecoveryBindingV1(binding),
              bindingSha256: recoveryBindingV1Digest(binding),
            });
            return Effect.succeed(
              verified === undefined ? Option.none() : Option.some(verified),
            );
          },
          findSelected: () => {
            if (trace !== undefined) {
              trace.p39SelectedReads = (trace.p39SelectedReads ?? 0) + 1;
            }
            if (trace?.p39SelectedFenceReject === true) {
              return Effect.fail({
                _tag: "LeaseFencingRejected" as const,
                executionId,
                generation: 0 as never,
              });
            }
            return Effect.succeed(
              trace?.p39SelectedEvidence === undefined
                ? Option.none()
                : Option.some(trace.p39SelectedEvidence),
            );
          },
          findLatestAttempt: () =>
            Effect.succeed(
              reconciliationRetry === undefined
                ? Option.none()
                : Option.some(reconciliationRetry.attempt),
            ),
          admitFirstAttempt: () => Effect.void,
          admitRetryAttempt: () => {
            if (trace !== undefined) {
              trace.retryAttemptNumbers ??= [0];
              trace.retryAttemptNumbers.push(1);
            }
            return Effect.void;
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
  const reconciliationDeps =
    reconciliationRetry === undefined
      ? p39Deps
      : Layer.mergeAll(
          p39Deps,
          Layer.succeed(
            ToolReconciliationProfileRegistry,
            makeToolReconciliationProfileRegistry([
              reconciliationRetry.registryProfileOverride ??
                reconciliationRetry.profile,
            ]),
          ),
          Layer.succeed(ToolReconciliationPort, {
            reconcile: (request: ToolReconciliationRequest) =>
              Effect.sync(() => {
                if (trace !== undefined) {
                  trace.reconciliationCalls =
                    (trace.reconciliationCalls ?? 0) + 1;
                  trace.reconciliationRequests ??= [];
                  trace.reconciliationRequests.push(request);
                }
                return reconciliationRetry.result;
              }),
          }),
          Layer.succeed(ToolReconciliationFactStore, {
            record: (
              request: ToolReconciliationRequest,
              result: ToolReconciliationResult,
            ) => {
              if (reconciliationRetry.failFactWrite === true) {
                if (trace !== undefined) {
                  trace.reconciliationFactWrites =
                    (trace.reconciliationFactWrites ?? 0) + 1;
                }
                return Effect.fail(
                  new Error("injected P39 reconciliation fact-store failure"),
                ) as never;
              }
              return Effect.sync(() => {
                if (trace !== undefined) {
                  trace.reconciliationFactWrites =
                    (trace.reconciliationFactWrites ?? 0) + 1;
                }
                return {
                  factId: reconciliationRetry.factId,
                  invocationId: request.invocationId,
                  attemptNo: request.attemptNo,
                  factDisposition: "RecoveryInput" as const,
                  outcome: result._tag,
                };
              });
            },
          } as never),
          Layer.succeed(ToolObservationEvidenceStore, {
            assertCurrentFence: () => {
              if (
                trace?.rejectFenceAfterReconciliation === true &&
                (trace.reconciliationCalls ?? 0) > 0
              ) {
                return Effect.fail({
                  _tag: "LeaseFencingRejected" as const,
                  executionId,
                  generation: 0 as never,
                });
              }
              return Effect.void;
            },
            read: (
              invocation: ToolInvocationIntent,
              _fence: NonNullable<
                import("@arbor/ports").ToolExecutionContext["executionFence"]
              >,
              _fenceNow: string,
            ) => {
              if (trace !== undefined) {
                trace.p40ReadInvocations ??= [];
                trace.p40ReadInvocations.push(invocation);
                trace.p40ReadFences ??= [];
                trace.p40ReadFences.push(_fence);
                trace.p40ReadFenceTimes ??= [];
                trace.p40ReadFenceTimes.push(_fenceNow);
              }
              return trace?.p40ReadFailure === undefined
                ? Effect.succeed(reconciliationRetry.settlementEvidence)
                : Effect.fail({
                    _tag: "ToolObservationReplayEvidenceFailure" as const,
                    invocationId: invocation.invocationId,
                    failureCode: trace.p40ReadFailure,
                  });
            },
            settleOrReadWinner: (candidate: ToolObservationEvidenceCandidate) =>
              Effect.sync(() => {
                if (trace !== undefined) {
                  trace.p40Candidates ??= [];
                  trace.p40Candidates.push(candidate);
                }
                return {
                  _tag: "Applied" as const,
                  evidence: reconciliationRetry.settlementEvidence,
                };
              }),
          } as never),
        );
  const artifactDeps =
    reconciliationRetry?.result._tag === "Occurred"
      ? (() => {
          const resultRef = reconciliationRetry.result.resultRef;
          return Layer.succeed(ArtifactService, {
            store: () => Effect.die(new Error("unexpected artifact store")),
            load: (artifactId) =>
              Effect.succeed(
                String(artifactId) === resultRef
                  ? Option.some(
                      new TextEncoder().encode("reconstructable result"),
                    )
                  : Option.none(),
              ),
          });
        })()
      : undefined;
  const runtimeDeps =
    artifactDeps === undefined
      ? reconciliationDeps
      : Layer.mergeAll(reconciliationDeps, artifactDeps);
  return Layer.mergeAll(runtimeDeps, Layer.provide(toolRuntime, runtimeDeps));
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

const processEpisode: ExecutionEpisodeBinding = {
  _tag: "InboxEpisode",
  entryKey: "p4-sandbox-process-entry",
  inputKind: "HumanMessage",
};

const processPolicy = (
  episodeBinding: ExecutionEpisodeBinding,
  providerId = "bwrap",
  providerVersion = "0.8.0",
): SandboxProcessPolicy => ({
  kind: "OsEnforcedProcessPolicy",
  executionId,
  episodeBinding,
  sandboxHandleId: "s",
  policyRevision: 2,
  profile: "ReadOnly",
  providerId,
  providerVersion,
  capabilityRevision: "capability-v1",
  enforcementRuleSetDigest: "b".repeat(64),
  qualificationEvidenceRef: `blob:sha256:${"a".repeat(64)}`,
  boundary: "OsEnforced",
  networkPolicy: { version: 1, mode: "Disabled", destinations: [] },
  policyDigest: "a".repeat(64),
  admittedMounts: [
    { ref: "workspace", rootPath: "/tmp/s", access: "ReadOnly" },
  ],
  environmentAllowlist: ["PATH"],
  limits: {
    wallTimeMs: 1_000,
    stdoutBytes: 1_024,
    stderrBytes: 1_024,
    processCount: 4,
    memoryBytes: 64 * 1024 * 1024,
    cpuTimeMs: 1_000,
  },
  auditRefs: [],
});

const processContext = (
  policy: SandboxProcessPolicy,
  currentEpisode = policy.episodeBinding,
): import("@arbor/ports").ToolExecutionContext => ({
  ...context,
  executionEpisodeBinding: currentEpisode,
  recoveryBindingIdentity: {
    executionId,
    providerTurnId: parse(ProviderTurnId)(
      "ptn_018f2b3c-4d5e-7abc-8def-0123456789a1",
    ),
    logicalStepNo: 0,
    repairAttempt: 0,
    logicalActionId: "lac_p4_process",
    actionIndex: 0,
    callRef: "c",
  },
  recoveryBindingPolicyRevisions: {
    workspacePolicyRevision: 0,
    projectPolicyRevision: 0,
  },
  sandboxProcessPolicy: policy,
});

const processExecutor: ToolExecutor = {
  ...okExecutor,
  processCapability: "SandboxProcess",
  execute: ({ runProcess }) =>
    Effect.gen(function* () {
      if (runProcess === undefined) {
        return {
          settlement: {
            _tag: "RuntimeFailure" as const,
            cause: "process runner missing",
          },
          observation: { text: "process runner missing", truncated: false },
          resultRef: null,
        };
      }
      const result = yield* runProcess({
        executable: "bash",
        args: ["-lc", "true"],
        cwd: { mount: "workspace", path: "." },
        requestedTimeoutMs: 5_000,
        ambientEnvironment: {},
      });
      if (result._tag === "SandboxProviderUnavailable") {
        return {
          settlement: {
            _tag: "ExpectedFailure" as const,
          },
          observation: {
            text: "required sandbox capability was unavailable or could not be verified; execution did not start",
            truncated: false,
          },
          resultRef: null,
          sandboxProviderUnavailable: result,
        };
      }
      if (result._tag === "Rejected") {
        return {
          settlement: {
            _tag: "RuntimeFailure" as const,
            cause: "sandbox request rejected",
          },
          observation: { text: "sandbox request rejected", truncated: false },
          resultRef: null,
        };
      }
      return {
        settlement: { _tag: "Success" as const },
        observation: { text: result.stdout, truncated: result.truncated },
        resultRef: null,
      };
    }),
};

const sandboxCapability = (
  providerId: string,
  status: "Supported" | "Experimental",
  providerVersion: string,
  capabilityRevision = "capability-v1",
): SandboxProviderCapability => ({
  providerId,
  providerVersion,
  capabilityRevision,
  probeEvidenceRef:
    providerId === "TrustedLocal"
      ? `evidence:${providerId}:${providerVersion}`
      : `blob:sha256:${"a".repeat(64)}`,
  enforcementRuleSetDigest:
    providerId === "TrustedLocal" ? null : "b".repeat(64),
  qualificationEvidenceRef:
    providerId === "TrustedLocal" ? null : `blob:sha256:${"a".repeat(64)}`,
  status,
  boundary: providerId === "TrustedLocal" ? "TrustedLocal" : "OsEnforced",
  profiles: ["ReadOnly"],
  networkModes: ["Disabled"],
});

describe("P4 tool runtime pipeline", () => {
  it("parks the same bound invocation when process policy is absent, before effect admission", async () => {
    const p39Case = p39ApprovedCase("c7", "action-p4-policy-required");
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
      resolvedEnvironmentRevisionSequence: [
        "rev-exact",
        "rev-exact",
        "rev-exact",
        "rev-exact",
      ],
      currentEnvironmentRevisionValues: ["rev-exact", "rev-exact"],
      sandboxCapabilities: [sandboxCapability("bwrap", "Supported", "0.8.0")],
    };
    const { sandboxProcessPolicy: _policy, ...contextWithoutPolicy } =
      p39Case.approvedContext;
    expect(_policy).toBeUndefined();
    const result = await run(
      app(
        false,
        { ...processExecutor, requiresApproval: () => true },
        {},
        trace,
        p39Case.approval,
        false,
        undefined,
        "rev-exact",
      ),
      p39Case.argumentsJson,
      p39Case.approvalId,
      contextWithoutPolicy,
    );
    expect(result._tag).toBe("SandboxPolicyRequiredInterruption");
    expect(trace.intentWrites).toBe(1);
    expect(trace.effectAdmissions).toBe(0);
    expect(trace.settlementWrites ?? 0).toBe(0);
    expect(trace.sandboxProcessPortRuns ?? 0).toBe(0);
  });

  it("rejects an episode-mismatched policy before provider execution", async () => {
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
      sandboxCapabilities: [sandboxCapability("bwrap", "Supported", "0.8.0")],
    };
    const policy = processPolicy(processEpisode);
    const result = await run(
      app(false, processExecutor, {}, trace),
      '{"target":{"mount":"workspace","path":"."}}',
      null,
      processContext(policy, {
        ...processEpisode,
        entryKey: "different-entry",
      }),
    );
    expect(result._tag).toBe("RuntimeFailure");
    expect(trace.sandboxProcessPortRuns ?? 0).toBe(0);
  });

  it.each([
    "missing-policy-evidence",
    "missing-policy-rule-digest",
    "provider-evidence-mismatch",
    "provider-rule-digest-mismatch",
  ] as const)(
    "rejects %s before the SandboxProcessPort run seam",
    async (caseName) => {
      const trace: PipelineTrace = {
        noEffectDenials: [],
        events: [],
        approvalConsumer: null,
        intentWrites: 0,
        effectAdmissions: 0,
        approvalConsumes: 0,
        sandboxCapabilities: [
          {
            ...sandboxCapability("bwrap", "Supported", "0.8.0"),
            ...(caseName === "provider-evidence-mismatch"
              ? { probeEvidenceRef: `blob:sha256:${"c".repeat(64)}` }
              : {}),
            ...(caseName === "provider-rule-digest-mismatch"
              ? { enforcementRuleSetDigest: "c".repeat(64) }
              : {}),
          },
        ],
      };
      const policy = processPolicy(processEpisode);
      const selectedPolicy: SandboxProcessPolicy =
        caseName === "missing-policy-evidence"
          ? ({
              ...policy,
              qualificationEvidenceRef: undefined,
            } as unknown as SandboxProcessPolicy)
          : caseName === "missing-policy-rule-digest"
            ? ({
                ...policy,
                enforcementRuleSetDigest: undefined,
              } as unknown as SandboxProcessPolicy)
            : policy;
      const result = await run(
        app(false, processExecutor, {}, trace),
        '{"target":{"mount":"workspace","path":"."}}',
        null,
        processContext(selectedPolicy),
      );
      expect(result._tag).not.toBe("Success");
      expect(trace.sandboxProcessPortRuns ?? 0).toBe(0);
      expect(trace.trustedLocalProcessRuns ?? 0).toBe(0);
      if (
        caseName === "provider-evidence-mismatch" ||
        caseName === "provider-rule-digest-mismatch"
      ) {
        expect(result).toMatchObject({
          _tag: "SandboxProviderUnavailable",
          failureCode:
            caseName === "provider-evidence-mismatch"
              ? "QualificationEvidenceMismatch"
              : "EnforcementRuleSetDigestMismatch",
        });
      }
    },
  );

  it("parks only after exact intent/binding, then reuses that NotAdmitted action when lazy policy appears", async () => {
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
      sandboxCapabilities: [sandboxCapability("bwrap", "Supported", "0.8.0")],
      persistSandboxInvocations: true,
      resolvedEnvironmentRevisionSequence: [
        "rev-exact",
        "rev-exact",
        "rev-exact",
        "rev-exact",
      ],
    };
    const policy = processPolicy(processEpisode);
    const mounts: ReadonlyArray<SandboxMountBinding> = [
      {
        ref: "workspace",
        address: { _tag: "GitWorktree", path: "/tmp/s" },
        region: {
          resourceSpaceId: "filesystem",
          normalizedRegion: { kind: "GitWorktree", path: "/tmp/s" },
        },
        access: "ReadOnly",
      },
    ];
    let policyAvailable = false;
    let policyResolutions = 0;
    const {
      sandboxProcessPolicy: eagerPolicy,
      sandboxProcessMountBindings: eagerMounts,
      ...contextWithoutEagerPolicy
    } = processContext(policy);
    void eagerPolicy;
    void eagerMounts;
    const contextWithLazyPolicy = {
      ...contextWithoutEagerPolicy,
      authority: {
        ...authority,
        controlBasisDigest: "d".repeat(64),
        sourceRevision: JSON.stringify({
          workspacePolicyRevision: 0,
          activeGrants: [],
          verifierId: null,
        }),
      },
      controlBasisDigest: "d".repeat(64),
      resolveSandboxProcessPolicy: ({ now }: { readonly now: string }) =>
        Effect.sync(() => {
          policyResolutions += 1;
          trace.events.push("policy-resolver");
          expect(now).toBe("2026-01-01T00:00:00.000Z");
          expect(trace.transactionDepth ?? 0).toBe(0);
          expect(trace.intentWrites).toBe(1);
          expect(trace.claimedBindings).toHaveLength(1);
          expect(
            trace.qualificationEvents?.some(
              (event) => event.boundary === "AH7AfterToolIntentCommit",
            ),
          ).toBe(true);
          return policyAvailable ? { policy, mounts } : undefined;
        }),
    };
    const appLayer = app(
      false,
      processExecutor,
      {},
      trace,
      undefined,
      false,
      undefined,
      "rev-exact",
    );
    const first = await run(
      appLayer,
      '{"target":{"mount":"workspace","path":"."}}',
      null,
      contextWithLazyPolicy,
    );
    expect(first._tag).toBe("SandboxPolicyRequiredInterruption");
    expect(trace.persistedSandboxInvocation).toMatchObject({
      effectAdmissionState: "NotAdmitted",
      settlement: null,
      settledAt: null,
    });
    expect(trace.intentWrites).toBe(1);
    expect(trace.p39BindingCalls).toBe(1);
    expect(trace.effectAdmissions).toBe(0);
    expect(trace.settlementWrites ?? 0).toBe(0);
    expect(trace.sandboxProcessPortRuns ?? 0).toBe(0);

    policyAvailable = true;
    const resumed = await run(
      appLayer,
      '{"target":{"mount":"workspace","path":"."}}',
      null,
      contextWithLazyPolicy,
    );
    expect(resumed._tag).toBe("Success");
    expect(policyResolutions).toBe(2);
    expect(trace.intentWrites).toBe(1);
    expect(trace.claimedBindings).toHaveLength(1);
    expect(trace.p39BindingCalls).toBe(1);
    expect(trace.effectAdmissions).toBe(1);
    expect(trace.settlementWrites).toBe(1);
    expect(trace.sandboxProcessPortRuns).toBe(1);
    expect(trace.trustedLocalProcessRuns ?? 0).toBe(0);
  });

  it("replays durable sandbox unavailability through the memoized current lazy policy", async () => {
    const policy = processPolicy(processEpisode);
    const argumentsJson = '{"target":{"mount":"workspace","path":"."}}';
    const observation = {
      _tag: "ExpectedFailure" as const,
      observation: {
        text: "required sandbox capability was unavailable or could not be verified; execution did not start",
        truncated: false,
      },
      sandboxProviderUnavailable: {
        policyRevision: policy.policyRevision,
        policyDigest: policy.policyDigest,
        profile: policy.profile,
        providerId: policy.providerId,
        providerVersion: policy.providerVersion,
        capabilityRevision: policy.capabilityRevision,
        probeEvidenceRef:
          policy.kind === "OsEnforcedProcessPolicy"
            ? policy.qualificationEvidenceRef
            : null,
        failureCode: "ProviderNotSupported",
        effectDisposition: "NoEffect" as const,
      },
    };
    const evidence: ToolObservationEvidence = {
      formatVersion: "p4-canonical-tool-observation-v1",
      bytes: new TextEncoder().encode(JSON.stringify(observation)),
      sha256: "e".repeat(64),
      observation,
    };
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
      sandboxCapabilities: [
        sandboxCapability("bwrap", "Experimental", "0.8.0"),
      ],
      persistSandboxInvocations: true,
      p40WinnerEvidence: evidence,
      persistedSandboxInvocation: {
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
        effectAdmissionState: "MayHaveStarted",
        intentAt: "2026-01-01T00:00:00.000Z",
        settledAt: "2026-01-01T00:00:01.000Z",
        settlement: { _tag: "ExpectedFailure" },
        resultRef: null,
      },
    };
    let resolutions = 0;
    const { sandboxProcessPolicy: _policy, ...lazyContext } =
      processContext(policy);
    void _policy;
    const result = await run(
      app(false, processExecutor, {}, trace),
      argumentsJson,
      null,
      {
        ...lazyContext,
        resolveSandboxProcessPolicy: ({ now }) =>
          Effect.sync(() => {
            resolutions += 1;
            expect(now).toBe("2026-01-01T00:00:00.000Z");
            expect(trace.transactionDepth ?? 0).toBe(0);
            return {
              policy,
              mounts: [
                {
                  ref: "workspace",
                  address: { _tag: "GitWorktree", path: "/tmp/s" },
                  region: {
                    resourceSpaceId: "filesystem",
                    normalizedRegion: {
                      kind: "GitWorktree",
                      path: "/tmp/s",
                    },
                  },
                  access: "ReadOnly",
                },
              ],
            };
          }),
      },
    );

    expect(result).toMatchObject({
      _tag: "SandboxProviderUnavailable",
      policyRevision: policy.policyRevision,
      policyDigest: policy.policyDigest,
      failureCode: "ProviderNotSupported",
    });
    expect(resolutions).toBe(1);
    expect(trace.p40ReadInvocations).toHaveLength(1);
    expect(trace.intentWrites).toBe(0);
    expect(trace.effectAdmissions).toBe(0);
    expect(trace.settlementWrites ?? 0).toBe(0);
    expect(trace.sandboxProcessPortRuns ?? 0).toBe(0);
    expect(trace.trustedLocalProcessRuns ?? 0).toBe(0);

    const staleResult = run(
      app(false, processExecutor, {}, trace),
      argumentsJson,
      null,
      {
        ...lazyContext,
        resolveSandboxProcessPolicy: () =>
          Effect.succeed({
            policy: { ...policy, policyRevision: policy.policyRevision + 1 },
            mounts: [],
          }),
      },
    );
    await expect(staleResult).rejects.toMatchObject({
      cause: { _tag: "SandboxUnavailableObservationPolicyMismatch" },
    });
    await expect(
      run(app(false, processExecutor, {}, trace), argumentsJson, null, {
        ...lazyContext,
        sandboxProcessPolicy: policy,
        resolveSandboxProcessPolicy: () => Effect.succeed(undefined),
      }),
    ).rejects.toMatchObject({
      cause: { _tag: "SandboxUnavailableObservationPolicyMismatch" },
    });
    const eagerOnlyReplay = await run(
      app(false, processExecutor, {}, trace),
      argumentsJson,
      null,
      processContext(policy),
    );
    expect(eagerOnlyReplay).toMatchObject({
      _tag: "SandboxProviderUnavailable",
      policyRevision: policy.policyRevision,
      policyDigest: policy.policyDigest,
      failureCode: "ProviderNotSupported",
    });
    expect(trace.sandboxProcessPortRuns ?? 0).toBe(0);
    expect(trace.trustedLocalProcessRuns ?? 0).toBe(0);
  });

  it.each(["handle", "mount"] as const)(
    "rejects a %s-mismatched policy before provider execution",
    async (mismatch) => {
      const trace: PipelineTrace = {
        noEffectDenials: [],
        events: [],
        approvalConsumer: null,
        intentWrites: 0,
        effectAdmissions: 0,
        approvalConsumes: 0,
        sandboxCapabilities: [sandboxCapability("bwrap", "Supported", "0.8.0")],
      };
      const policy = processPolicy(processEpisode);
      const mismatchedPolicy: SandboxProcessPolicy =
        mismatch === "handle"
          ? { ...policy, sandboxHandleId: "different-handle" }
          : {
              ...policy,
              admittedMounts: [
                {
                  ref: "workspace",
                  rootPath: "/tmp/other",
                  access: "ReadOnly",
                },
              ],
            };
      const result = await run(
        app(false, processExecutor, {}, trace),
        '{"target":{"mount":"workspace","path":"."}}',
        null,
        processContext(mismatchedPolicy),
      );
      expect(result._tag).toBe("RuntimeFailure");
      expect(trace.sandboxProcessPortRuns ?? 0).toBe(0);
    },
  );

  it("opens the full committed process mount set instead of the executor's single target", async () => {
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
      sandboxCapabilities: [sandboxCapability("bwrap", "Supported", "0.8.0")],
    };
    const policy = processPolicy(processEpisode);
    const processMounts = [
      {
        ref: "workspace",
        address: { _tag: "GitWorktree" as const, path: "/tmp/s" },
        region: {
          resourceSpaceId: "filesystem",
          normalizedRegion: { kind: "GitWorktree", path: "/tmp/s" },
        },
        access: "ReadOnly" as const,
      },
      {
        ref: "resource-123",
        address: { _tag: "FileTree" as const, path: "/tmp/secondary" },
        region: {
          resourceSpaceId: "filesystem",
          normalizedRegion: { kind: "FileTree", path: "/tmp/secondary" },
        },
        access: "ReadOnly" as const,
      },
    ];
    const fullBoundaryPolicy: SandboxProcessPolicy = {
      ...policy,
      admittedMounts: [
        { ref: "workspace", rootPath: "/tmp/s", access: "ReadOnly" },
        {
          ref: "resource-123",
          rootPath: "/tmp/resource-123",
          access: "ReadOnly",
        },
      ],
    };
    const result = await run(
      app(false, processExecutor, {}, trace),
      '{"target":{"mount":"workspace","path":"."}}',
      null,
      {
        ...processContext(fullBoundaryPolicy),
        sandboxProcessMountBindings: processMounts,
      },
    );
    expect(result._tag).toBe("Success");
    expect(trace.sandboxOpenedMountRefs).toEqual(["workspace", "resource-123"]);
    expect(trace.sandboxProcessPortRuns).toBe(1);
  });

  it("rejects an invalid requested process timeout before provider execution", async () => {
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
      sandboxCapabilities: [sandboxCapability("bwrap", "Supported", "0.8.0")],
    };
    const invalidTimeoutExecutor: ToolExecutor = {
      ...processExecutor,
      execute: ({ runProcess }) =>
        Effect.gen(function* () {
          const result =
            runProcess === undefined
              ? {
                  _tag: "Rejected" as const,
                  failureCode: "ProcessCapabilityNotBound" as const,
                }
              : yield* runProcess({
                  executable: "bash",
                  args: ["-lc", "true"],
                  cwd: { mount: "workspace", path: "." },
                  requestedTimeoutMs: 0,
                  ambientEnvironment: {},
                });
          return {
            settlement: {
              _tag: "RuntimeFailure" as const,
              cause:
                result._tag === "Rejected"
                  ? result.failureCode
                  : "unexpected provider call",
            },
            observation: { text: "invalid timeout rejected", truncated: false },
            resultRef: null,
          };
        }),
    };
    const result = await run(
      app(false, invalidTimeoutExecutor, {}, trace),
      '{"target":{"mount":"workspace","path":"."}}',
      null,
      processContext(processPolicy(processEpisode)),
    );
    expect(result._tag).toBe("RuntimeFailure");
    expect(trace.sandboxProcessPortRuns ?? 0).toBe(0);
  });

  it("does not inject process capability or trust an unavailable result from an unregistered executor", async () => {
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
      sandboxCapabilities: [sandboxCapability("bwrap", "Supported", "0.8.0")],
    };
    let processRunnerInjected = false;
    const unregisteredExecutor: ToolExecutor = {
      name: "read",
      write: false,
      requiresApproval: () => false,
      execute: ({ runProcess }) => {
        processRunnerInjected = runProcess !== undefined;
        return Effect.succeed({
          settlement: {
            _tag: "RuntimeFailure" as const,
            cause: "unregistered process request",
          },
          observation: {
            text: "unregistered process request",
            truncated: false,
          },
          resultRef: null,
          sandboxProviderUnavailable: {
            _tag: "SandboxProviderUnavailable" as const,
            projectId,
            workspaceId,
            executionId,
            episodeBinding: processEpisode,
            policyRevision: 2,
            policyDigest: "a".repeat(64),
            profileId: "ReadOnly" as const,
            providerId: "bwrap",
            providerVersion: "0.8.0",
            capabilityRevision: "capability-v1",
            probeEvidenceRef: null,
            enforcementRuleSetDigest: null,
            qualificationEvidenceRef: null,
            failureCode: "ForgedUnavailability",
            actionBinding: {
              identity: {
                executionId,
                logicalStepNo: 0,
                repairAttempt: 0,
              },
              providerTurnId: "ptn_forged" as never,
              logicalActionId: "lac_forged",
              actionIndex: 0,
              callRef: "call-forged",
              invocationId,
            },
          },
        });
      },
    };
    const result = await run(
      app(false, unregisteredExecutor, {}, trace),
      '{"target":{"mount":"workspace","path":"."}}',
      null,
      processContext(processPolicy(processEpisode)),
    );
    expect(processRunnerInjected).toBe(false);
    expect(result._tag).toBe("RuntimeFailure");
    expect(trace.sandboxProcessPortRuns ?? 0).toBe(0);
  });

  it("returns typed provider unavailability without TrustedLocal fallback", async () => {
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
      sandboxCapabilities: [
        sandboxCapability("bwrap", "Experimental", "0.8.0"),
        sandboxCapability("TrustedLocal", "Supported", "builtin-v1"),
      ],
    };
    const result = await run(
      app(false, processExecutor, {}, trace),
      '{"target":{"mount":"workspace","path":"."}}',
      null,
      processContext(processPolicy(processEpisode)),
    );
    expect(result).toMatchObject({
      _tag: "SandboxProviderUnavailable",
      providerId: "bwrap",
      providerVersion: "0.8.0",
      policyRevision: 2,
      failureCode: "ProviderNotSupported",
      capabilityRevision: "capability-v1",
    });
    expect(trace.sandboxProcessPortRuns ?? 0).toBe(0);
    expect(trace.trustedLocalProcessRuns ?? 0).toBe(0);
    expect(trace.settlementWrites).toBe(1);
    expect(trace.effectAdmissions).toBe(1);
  });

  it("runs only the exact explicit TrustedLocalUnconfinedV1 runtime branch", async () => {
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
      sandboxCapabilities: [],
    };
    const policy: SandboxProcessPolicy = {
      ...processPolicy(processEpisode),
      kind: "TrustedLocalUnconfinedRuntimePolicy",
      profile: "FullAccess",
      providerId: "TrustedLocal",
      providerVersion: "builtin-v1",
      capabilityRevision: "builtin-v1",
      boundary: "TrustedLocal",
      trustedRuntimeIdentity: "TrustedLocal",
      trustedRuntimeVersion: "builtin-v1",
      networkBoundary: "Unconfined",
    };
    const result = await run(
      app(false, processExecutor, {}, trace),
      '{"target":{"mount":"workspace","path":"."}}',
      null,
      processContext(policy),
    );
    expect(result._tag).toBe("Success");
    expect(trace.trustedLocalProcessRuns).toBe(1);
    expect(trace.sandboxProcessPortRuns ?? 0).toBe(0);
  });

  it("binds provider-version mismatch unavailability to the durable policy tuple", async () => {
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
      sandboxCapabilities: [sandboxCapability("bwrap", "Supported", "0.9.0")],
    };
    const result = await run(
      app(false, processExecutor, {}, trace),
      '{"target":{"mount":"workspace","path":"."}}',
      null,
      processContext(processPolicy(processEpisode, "bwrap", "0.8.0")),
    );
    expect(result).toMatchObject({
      _tag: "SandboxProviderUnavailable",
      providerId: "bwrap",
      providerVersion: "0.8.0",
      failureCode: "ProviderVersionMismatch",
      capabilityRevision: "capability-v1",
      probeEvidenceRef: `blob:sha256:${"a".repeat(64)}`,
    });
    expect(trace.sandboxProcessPortRuns ?? 0).toBe(0);
    expect(trace.settlementWrites).toBe(1);
  });

  it("binds capability-revision mismatch unavailability to the durable policy tuple", async () => {
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
      sandboxCapabilities: [
        sandboxCapability("bwrap", "Supported", "0.8.0", "capability-v2"),
      ],
    };
    const result = await run(
      app(false, processExecutor, {}, trace),
      '{"target":{"mount":"workspace","path":"."}}',
      null,
      processContext(processPolicy(processEpisode)),
    );
    expect(result).toMatchObject({
      _tag: "SandboxProviderUnavailable",
      providerId: "bwrap",
      providerVersion: "0.8.0",
      capabilityRevision: "capability-v1",
      probeEvidenceRef: `blob:sha256:${"a".repeat(64)}`,
      failureCode: "CapabilityRevisionMismatch",
    });
    expect(trace.sandboxProcessPortRuns ?? 0).toBe(0);
    expect(trace.settlementWrites).toBe(1);
  });

  it("pins provider version and clamps a requested timeout to policy", async () => {
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
      sandboxCapabilities: [sandboxCapability("bwrap", "Supported", "0.8.0")],
    };
    const result = await run(
      app(false, processExecutor, {}, trace),
      '{"target":{"mount":"workspace","path":"."}}',
      null,
      processContext(processPolicy(processEpisode)),
    );
    expect(result._tag).toBe("Success");
    expect(trace.sandboxProcessPortRuns).toBe(1);
    expect(trace.sandboxProcessTimeouts).toEqual([1_000]);
  });

  it.each(["NotOccurred", "Occurred", "StillUnknown"] as const)(
    "stops before admission and P40 settlement when the P39 %s fact write fails, then safely resumes the exact reconciliation",
    async (outcomeTag) => {
      const retry = p39NotOccurredRetryCase("ResourceSnapshotChanged");
      if (retry.result._tag !== "NotOccurred") {
        throw new Error(
          "expected the retry fixture to carry a NotOccurred proof",
        );
      }
      const resultArtifactId = parse(ArtifactId)(
        "art_018f2b3c-4d5e-7abc-8def-0123456789a3",
      );
      const effectKey = retry.profile.effectKey({
        invocationId,
        argumentsJson: retry.argumentsJson,
      });
      if (effectKey === null) throw new Error("test effect key missing");
      const reconciliationResult: ToolReconciliationResult =
        outcomeTag === "NotOccurred"
          ? retry.result
          : outcomeTag === "Occurred"
            ? {
                _tag: "Occurred",
                proof: retry.result.proof,
                settlement: "Success",
                resultRef: String(resultArtifactId),
              }
            : {
                _tag: "StillUnknown",
                reasonCode: "ExternalSourceUnavailable",
                evidenceRef: null,
              };
      const profile: ToolReconciliationProfile = {
        ...retry.profile,
        reconstructOccurred: ({ settlement }) => ({
          settlement,
          observation: {
            text: "reconstructed from exact result artifact",
            truncated: false,
          },
        }),
      };
      const factId = reconciliationFactId({
        request: {
          invocationId,
          attemptNo: 0,
          bindingSha256: retry.verifiedBinding.bindingSha256,
          profileHash: retry.profile.profileHash,
          effectKey,
          visibilityScopeSha256:
            retry.verifiedBinding.value.targetResourceIdentityDigest,
        },
        result: reconciliationResult,
        factDisposition: "RecoveryInput",
      });
      let failedStoreCalls = 0;
      let recoveryStoreCalls = 0;
      let firstExecutorCalls = 0;
      let recoveryExecutorCalls = 0;
      let policyResolutions = 0;
      const policy = processPolicy(processEpisode);
      const policyMounts: ReadonlyArray<SandboxMountBinding> = [
        {
          ref: "workspace",
          address: { _tag: "GitWorktree", path: "/tmp/s" },
          region: {
            resourceSpaceId: "filesystem",
            normalizedRegion: { kind: "GitWorktree", path: "/tmp/s" },
          },
          access: "ReadOnly",
        },
      ];
      const {
        sandboxProcessPolicy: _restartPolicy,
        sandboxProcessMountBindings: _restartMounts,
        ...restartContext
      } = retry.context;
      void _restartPolicy;
      void _restartMounts;
      const makeTrace = (failFactWrite: boolean): PipelineTrace => ({
        noEffectDenials: [],
        events: [],
        approvalConsumer: null,
        intentWrites: 0,
        effectAdmissions: 0,
        approvalConsumes: 0,
        retryAttemptNumbers: [0],
        reconciliationRetry: {
          profile,
          verifiedBinding: retry.verifiedBinding,
          attempt: retry.attempt,
          authority: retry.authority,
          result: reconciliationResult,
          factId,
          settlementEvidence: retry.settlementEvidence,
          failFactWrite,
        },
      });
      const invoke = async (
        trace: PipelineTrace,
        execute: () => void,
        afterRestart = false,
        refreshedPolicy: SandboxProcessPolicy = policy,
      ) =>
        Effect.runPromise(
          Effect.provide(
            Effect.match(
              Effect.gen(function* () {
                const runtime = yield* ToolRuntimePort;
                return yield* runtime.invoke(
                  {
                    ...intent(retry.argumentsJson),
                    toolName: "shell",
                    toolVersion: "2",
                    invocationId,
                    approvalId: null,
                  } as never,
                  afterRestart
                    ? {
                        ...restartContext,
                        resolveSandboxProcessPolicy: ({ now }) =>
                          Effect.sync(() => {
                            policyResolutions += 1;
                            expect(now).toBe("2026-01-01T00:00:00.000Z");
                            expect(trace.transactionDepth ?? 0).toBe(0);
                            return {
                              policy: refreshedPolicy,
                              mounts: policyMounts,
                            };
                          }),
                      }
                    : retry.context,
                );
              }),
              {
                onFailure: (cause) => ({ _tag: "Failure" as const, cause }),
                onSuccess: (value) => ({ _tag: "Success" as const, value }),
              },
            ),
            app(
              false,
              {
                ...processExecutor,
                name: "shell",
                execute: (input) => {
                  execute();
                  return processExecutor.execute(input);
                },
              },
              {},
              trace,
              undefined,
              false,
              retry.prior,
              "rev",
              trace.reconciliationRetry,
            ),
          ),
        );

      const failedTrace = makeTrace(true);
      const failed = await invoke(failedTrace, () => {
        firstExecutorCalls += 1;
      });
      failedStoreCalls = failedTrace.reconciliationFactWrites ?? 0;
      expect(failed._tag).toBe("Failure");
      expect(failedStoreCalls).toBe(1);
      expect(failedTrace.reconciliationCalls).toBe(1);
      expect(failedTrace.retryAttemptNumbers).toEqual([0]);
      expect(failedTrace.effectAdmissions).toBe(0);
      expect(failedTrace.p40Candidates ?? []).toEqual([]);
      expect(firstExecutorCalls).toBe(0);

      const recoveredTrace = makeTrace(false);
      const recovered = await invoke(
        recoveredTrace,
        () => {
          recoveryExecutorCalls += 1;
        },
        true,
      );
      recoveryStoreCalls = recoveredTrace.reconciliationFactWrites ?? 0;
      expect(recovered._tag).toBe("Success");
      expect(recoveredTrace.reconciliationRequests).toEqual(
        failedTrace.reconciliationRequests,
      );
      expect(recoveryStoreCalls).toBe(1);
      if (outcomeTag === "NotOccurred") {
        expect(recoveredTrace.retryAttemptNumbers).toEqual([0, 1]);
        expect(recoveryExecutorCalls).toBe(1);
        expect(policyResolutions).toBe(1);
        for (const mismatch of ["handle", "mount"] as const) {
          const driftTrace = makeTrace(false);
          const driftedPolicy: SandboxProcessPolicy =
            mismatch === "handle"
              ? { ...policy, sandboxHandleId: "stale-handle" }
              : {
                  ...policy,
                  admittedMounts: [
                    {
                      ref: "workspace",
                      rootPath: "/tmp/stale",
                      access: "ReadOnly",
                    },
                  ],
                };
          await invoke(driftTrace, () => {}, true, driftedPolicy);
          expect(driftTrace.sandboxProcessPortRuns ?? 0).toBe(0);
        }
      } else if (outcomeTag === "Occurred") {
        expect(recoveredTrace.retryAttemptNumbers).toEqual([0]);
        expect(recoveryExecutorCalls).toBe(0);
        expect(policyResolutions).toBe(0);
        expect(recoveredTrace.p40Candidates).toHaveLength(1);
        expect(recoveredTrace.p40Candidates?.[0]).toMatchObject({
          settlement: { _tag: "Success" },
          reconciliationSelection: { attemptNo: 0, factId },
        });
      } else {
        expect(recovered).toEqual({
          _tag: "Success",
          value: {
            _tag: "OutcomeUnknown",
            reconciliationRefs: [String(invocationId)],
          },
        });
        expect(recoveredTrace.retryAttemptNumbers).toEqual([0]);
        expect(recoveryExecutorCalls).toBe(0);
        expect(policyResolutions).toBe(0);
        expect(recoveredTrace.p40Candidates ?? []).toEqual([]);
      }
    },
  );

  it("keeps historical profile-less shell@2 MayHaveStarted recovery unknown and idempotent", async () => {
    const argumentsJson = JSON.stringify({
      command: "pwd",
      cwd: { mount: "workspace", path: "." },
    });
    // Permitted legacy shape: exact shell@2 semantics and durable admission,
    // with no trusted P39 profile, binding, or reconciliation fact.
    const legacy: ToolInvocationRecord = {
      invocationId,
      executionId,
      workspaceId,
      toolName: "shell",
      toolVersion: "2",
      sideEffectSemantics: "Reconcilable",
      argumentsJson,
      resolvedRegions: [
        {
          resourceSpaceId: "filesystem",
          normalizedRegion: { _tag: "GitWorktree", path: "/repo/a" },
        },
      ],
      approvalId: null,
      effectAdmissionState: "MayHaveStarted",
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
      profilelessLegacyInvocation: legacy,
    };
    let executorCalls = 0;
    const executor: ToolExecutor = {
      ...okExecutor,
      name: "shell",
      write: true,
      execute: (input) => {
        executorCalls += 1;
        return okExecutor.execute(input);
      },
    };
    const appLayer = app(false, executor, {}, trace);

    const first = await runShell(appLayer, "pwd");
    const restartReplay = await runShell(appLayer, "pwd");

    expect(first).toEqual({
      _tag: "OutcomeUnknown",
      reconciliationRefs: [String(invocationId)],
    });
    expect(restartReplay).toEqual(first);
    expect(executorCalls).toBe(0);
    expect(trace.reconciliationCalls ?? 0).toBe(0);
    expect(trace.reconciliationFactWrites ?? 0).toBe(0);
    expect(trace.p39BindingCalls ?? 0).toBe(0);
    expect(trace.effectAdmissions).toBe(0);
    expect(trace.intentWrites).toBe(0);
    expect(trace.noEffectDenials).toEqual([]);
    expect(legacy).toMatchObject({
      effectAdmissionState: "MayHaveStarted",
      settledAt: null,
      settlement: null,
      resultRef: null,
    });
  });

  it.each(["AuthoritySnapshotChanged", "ResourceSnapshotChanged"] as const)(
    "settles a denied P39 NotOccurred retry after %s without a second effect admission",
    async (denialReasonCode) => {
      const retry = p39NotOccurredRetryCase(denialReasonCode);
      const trace: PipelineTrace = {
        noEffectDenials: [],
        events: [],
        approvalConsumer: null,
        intentWrites: 0,
        effectAdmissions: 0,
        approvalConsumes: 0,
        retryAttemptNumbers: [0],
        reconciliationRetry: {
          profile: retry.profile,
          verifiedBinding: retry.verifiedBinding,
          attempt: retry.attempt,
          authority: retry.authority,
          result: retry.result,
          factId: retry.factId,
          settlementEvidence: retry.settlementEvidence,
          denyAuthorityOnCall:
            denialReasonCode === "AuthoritySnapshotChanged" ? 2 : null,
        },
      };
      if (denialReasonCode === "ResourceSnapshotChanged") {
        trace.resourceAdmissionDeniedAtCall = 1;
      }
      const executor: ToolExecutor = {
        name: "shell",
        write: true,
        requiresApproval: () => false,
        execute: () =>
          Effect.die(new Error("a denied NotOccurred retry must not execute")),
      };
      const result = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const runtime = yield* ToolRuntimePort;
            return yield* runtime.invoke(
              {
                callRef: "c",
                toolName: "shell",
                toolVersion: "2",
                argumentsJson: retry.argumentsJson,
                invocationId,
                approvalId: null,
              } as never,
              retry.context,
            );
          }),
          app(
            false,
            executor,
            {},
            trace,
            undefined,
            false,
            retry.prior,
            "rev",
            trace.reconciliationRetry,
          ),
        ),
      );

      expect(result).toEqual(retry.settlementEvidence.observation);
      expect(trace.reconciliationFactWrites).toBe(1);
      expect(trace.authorityResolutionCalls).toBe(
        denialReasonCode === "AuthoritySnapshotChanged" ? 2 : 1,
      );
      expect(trace.resourceAdmissionCalls).toBe(1);
      expect(trace.effectAdmissions).toBe(0);
      expect(trace.retryAttemptNumbers).toEqual([0]);
      expect(trace.noEffectDenials).toEqual([]);
      expect(trace.p40Candidates).toHaveLength(1);
      expect(trace.p40Candidates?.[0]).toMatchObject({
        settlement: {
          _tag: "ReconciledNoEffect",
          reasonCode: denialReasonCode,
          reconciliationFactRef: retry.factId,
        },
        reconciliationSelection: { attemptNo: 0, factId: retry.factId },
      });
    },
  );

  it("reconciles against the persisted P39 scope before denying a changed current resource boundary", async () => {
    const retry = p39NotOccurredRetryCase("ResourceSnapshotChanged");
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
      retryAttemptNumbers: [0],
      workspaceBoundaryAddresses: [{ _tag: "GitWorktree", path: "/repo/b" }],
      workspaceRevisionSequence: [1, 1],
      reconciliationRetry: {
        profile: retry.profile,
        verifiedBinding: retry.verifiedBinding,
        attempt: retry.attempt,
        authority: retry.authority,
        result: retry.result,
        factId: retry.factId,
        settlementEvidence: retry.settlementEvidence,
      },
    };
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* ToolRuntimePort;
          return yield* runtime.invoke(
            {
              ...intent(retry.argumentsJson),
              toolName: "shell",
              toolVersion: "2",
              invocationId,
              approvalId: null,
            } as never,
            retry.context,
          );
        }),
        app(
          false,
          {
            name: "shell",
            write: true,
            requiresApproval: () => false,
            execute: () =>
              Effect.die(
                new Error("a stale P39 resource boundary must not execute"),
              ),
          },
          {},
          trace,
          undefined,
          false,
          retry.prior,
          "rev",
          trace.reconciliationRetry,
        ),
      ),
    );

    expect(result).toEqual(retry.settlementEvidence.observation);
    expect(trace.reconciliationCalls).toBe(1);
    expect(trace.reconciliationRequests).toEqual([
      expect.objectContaining({
        invocationId,
        attemptNo: 0,
        visibilityScopeSha256:
          retry.verifiedBinding.value.targetResourceIdentityDigest,
      }),
    ]);
    expect(trace.reconciliationFactWrites).toBe(1);
    expect(trace.retryAttemptNumbers).toEqual([0]);
    expect(trace.effectAdmissions).toBe(0);
    expect(trace.resourceAdmissionCalls ?? 0).toBe(0);
    expect(trace.noEffectDenials).toEqual([]);
    expect(trace.p40Candidates).toHaveLength(1);
    expect(trace.p40Candidates?.[0]).toMatchObject({
      settlement: {
        _tag: "ReconciledNoEffect",
        reasonCode: "ResourceSnapshotChanged",
      },
      reconciliationSelection: {
        attemptNo: 0,
        factId: retry.factId,
      },
    });
  });

  it("emits the delayed reconciliation fence-rejection probe and preserves the P39 failure", async () => {
    const retry = p39NotOccurredRetryCase("ResourceSnapshotChanged");
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
      retryAttemptNumbers: [0],
      rejectFenceAfterReconciliation: true,
      reconciliationRetry: {
        profile: retry.profile,
        verifiedBinding: retry.verifiedBinding,
        attempt: retry.attempt,
        authority: retry.authority,
        result: retry.result,
        factId: retry.factId,
        settlementEvidence: retry.settlementEvidence,
      },
    };
    const outcome = await Effect.runPromise(
      Effect.provide(
        Effect.match(
          Effect.gen(function* () {
            const runtime = yield* ToolRuntimePort;
            return yield* runtime.invoke(
              {
                ...intent(retry.argumentsJson),
                toolName: "shell",
                toolVersion: "2",
                invocationId,
                approvalId: null,
              } as never,
              retry.context,
            );
          }),
          {
            onFailure: (cause) => ({ _tag: "Failure" as const, cause }),
            onSuccess: (value) => ({ _tag: "Success" as const, value }),
          },
        ),
        app(
          false,
          {
            name: "shell",
            write: true,
            requiresApproval: () => false,
            execute: () =>
              Effect.die(
                new Error("a stale reconciliation result must not execute"),
              ),
          },
          {},
          trace,
          undefined,
          false,
          retry.prior,
          "rev",
          trace.reconciliationRetry,
        ),
      ),
    );

    expect(outcome).toMatchObject({
      _tag: "Failure",
      cause: {
        _tag: "ToolRuntimeOperationalFailure",
        stage: "RecoveryBinding",
        cause: { _tag: "LeaseFencingRejected" },
      },
    });
    expect(trace.qualificationEvents).toContainEqual(
      expect.objectContaining({
        boundary: "AH7ReconciliationResultFenceRejected",
        executionId,
        invocationId,
        attemptNo: 0,
        outcomeTag: "NotOccurred",
        factId: retry.factId,
      }),
    );
    expect(trace.reconciliationCalls).toBe(1);
    expect(trace.reconciliationFactWrites ?? 0).toBe(0);
    expect(trace.retryAttemptNumbers).toEqual([0]);
    expect(trace.effectAdmissions).toBe(0);
  });

  it.each(["recorded-regions", "binding"] as const)(
    "fails closed before reconciliation when the persisted %s no longer matches",
    async (tamper) => {
      const retry = p39NotOccurredRetryCase("ResourceSnapshotChanged");
      const trace: PipelineTrace = {
        noEffectDenials: [],
        events: [],
        approvalConsumer: null,
        intentWrites: 0,
        effectAdmissions: 0,
        approvalConsumes: 0,
        reconciliationRetry: {
          profile: retry.profile,
          verifiedBinding: retry.verifiedBinding,
          attempt: retry.attempt,
          authority: retry.authority,
          result: retry.result,
          factId: retry.factId,
          settlementEvidence: retry.settlementEvidence,
          ...(tamper === "binding"
            ? {
                bindingOverride: (() => {
                  const altered = {
                    ...retry.verifiedBinding.value,
                    targetResourceIdentityDigest: "e".repeat(64),
                  };
                  return verifyRecoveryBindingV1({
                    invocationId,
                    canonicalJson: canonicalizeRecoveryBindingV1(altered),
                    bindingSha256: recoveryBindingV1Digest(altered),
                  }) as NonNullable<ReturnType<typeof verifyRecoveryBindingV1>>;
                })(),
              }
            : {}),
        },
      };
      const tamperedPrior =
        tamper === "recorded-regions"
          ? {
              ...retry.prior,
              resolvedRegions: [
                {
                  resourceSpaceId: "tampered-filesystem",
                  normalizedRegion: {
                    _tag: "GitWorktree" as const,
                    path: "/repo/tampered",
                  },
                },
              ],
            }
          : retry.prior;
      let executorCalls = 0;
      const outcome = await Effect.runPromise(
        Effect.provide(
          Effect.match(
            Effect.gen(function* () {
              const runtime = yield* ToolRuntimePort;
              return yield* runtime.invoke(
                {
                  ...intent(retry.argumentsJson),
                  toolName: "shell",
                  toolVersion: "2",
                  invocationId,
                  approvalId: null,
                } as never,
                retry.context,
              );
            }),
            {
              onFailure: (cause) => ({ _tag: "Failure" as const, cause }),
              onSuccess: (value) => ({ _tag: "Success" as const, value }),
            },
          ),
          app(
            false,
            {
              name: "shell",
              write: true,
              requiresApproval: () => false,
              execute: () => {
                executorCalls += 1;
                return Effect.succeed({
                  settlement: { _tag: "Success" as const },
                  observation: { text: "should not run", truncated: false },
                  resultRef: null,
                });
              },
            },
            {},
            trace,
            undefined,
            false,
            tamperedPrior,
            "rev",
            trace.reconciliationRetry,
          ),
        ),
      );

      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure") {
        expect(outcome.cause).toMatchObject({
          _tag: "ToolRuntimeOperationalFailure",
          stage: "RecoveryBinding",
          cause: { _tag: "RecoveryBindingReplayMismatch" },
        });
      }
      expect(trace.reconciliationCalls ?? 0).toBe(0);
      expect(trace.reconciliationFactWrites ?? 0).toBe(0);
      expect(trace.effectAdmissions).toBe(0);
      expect(executorCalls).toBe(0);
    },
  );

  it.each(["version", "hash", "effect-key"] as const)(
    "returns OutcomeUnknown without reconciliation when only the trusted profile %s drifts",
    async (drift) => {
      const retry = p39NotOccurredRetryCase("ResourceSnapshotChanged");
      const currentProfile: ToolReconciliationProfile = {
        ...retry.profile,
        ...(drift === "version" ? { profileVersion: "2" } : {}),
        ...(drift === "hash" ? { profileHash: "f".repeat(64) } : {}),
        ...(drift === "effect-key"
          ? { effectKey: ({ invocationId: id }) => `changed:${id}` }
          : {}),
      };
      const trace: PipelineTrace = {
        noEffectDenials: [],
        events: [],
        approvalConsumer: null,
        intentWrites: 0,
        effectAdmissions: 0,
        approvalConsumes: 0,
        reconciliationRetry: {
          profile: retry.profile,
          registryProfileOverride: currentProfile,
          verifiedBinding: retry.verifiedBinding,
          attempt: retry.attempt,
          authority: retry.authority,
          result: retry.result,
          factId: retry.factId,
          settlementEvidence: retry.settlementEvidence,
        },
      };
      let executorCalls = 0;
      const outcome = await Effect.runPromise(
        Effect.provide(
          Effect.match(
            Effect.gen(function* () {
              const runtime = yield* ToolRuntimePort;
              return yield* runtime.invoke(
                {
                  ...intent(retry.argumentsJson),
                  toolName: "shell",
                  toolVersion: "2",
                  invocationId,
                  approvalId: null,
                } as never,
                retry.context,
              );
            }),
            {
              onFailure: (cause) => ({ _tag: "Failure" as const, cause }),
              onSuccess: (value) => ({ _tag: "Success" as const, value }),
            },
          ),
          app(
            false,
            {
              name: "shell",
              write: true,
              requiresApproval: () => false,
              execute: () => {
                executorCalls += 1;
                return Effect.succeed({
                  settlement: { _tag: "Success" as const },
                  observation: { text: "must not execute", truncated: false },
                  resultRef: null,
                });
              },
            },
            {},
            trace,
            undefined,
            false,
            retry.prior,
            "rev",
            trace.reconciliationRetry,
          ),
        ),
      );

      expect(outcome).toEqual({
        _tag: "Success",
        value: {
          _tag: "OutcomeUnknown",
          reconciliationRefs: [String(invocationId)],
        },
      });
      expect(trace.reconciliationCalls ?? 0).toBe(0);
      expect(trace.reconciliationFactWrites ?? 0).toBe(0);
      expect(trace.retryAttemptNumbers).toEqual(undefined);
      expect(trace.effectAdmissions).toBe(0);
      expect(trace.intentWrites).toBe(0);
      expect(executorCalls).toBe(0);
      expect(trace.noEffectDenials).toEqual([]);
    },
  );

  it.each(["NotOccurred", "Success", "ExpectedFailure"] as const)(
    "returns a terminal P40 %s receipt before current-region admission or reconciliation",
    async (terminalOutcome) => {
      const receipt = p39TerminalReceiptCase(terminalOutcome);
      const trace: PipelineTrace = {
        noEffectDenials: [],
        events: [],
        approvalConsumer: null,
        intentWrites: 0,
        effectAdmissions: 0,
        approvalConsumes: 0,
        workspaceBoundaryAddresses: [{ _tag: "GitWorktree", path: "/repo/b" }],
        workspaceRevisionSequence: [1, 1],
        p39SelectedEvidence: receipt.selected,
        p40WinnerEvidence: receipt.settlementEvidence,
        reconciliationRetry: {
          profile: receipt.profile,
          verifiedBinding: receipt.verifiedBinding,
          attempt: receipt.attempt,
          authority: receipt.authority,
          result: receipt.result,
          factId: receipt.factId,
          settlementEvidence: receipt.settlementEvidence,
        },
      };
      let executorCalls = 0;
      const outcome = await Effect.runPromise(
        Effect.provide(
          Effect.match(
            Effect.gen(function* () {
              const runtime = yield* ToolRuntimePort;
              return yield* runtime.invoke(
                {
                  ...intent(receipt.argumentsJson),
                  toolName: "shell",
                  toolVersion: "2",
                  invocationId,
                  approvalId: null,
                } as never,
                receipt.context,
              );
            }),
            {
              onFailure: (cause) => ({ _tag: "Failure" as const, cause }),
              onSuccess: (value) => ({ _tag: "Success" as const, value }),
            },
          ),
          app(
            false,
            {
              name: "shell",
              write: true,
              requiresApproval: () => false,
              execute: () => {
                executorCalls += 1;
                return Effect.die(
                  new Error("terminal receipt replay executed"),
                );
              },
            },
            {},
            trace,
            undefined,
            false,
            receipt.prior,
            "rev",
            trace.reconciliationRetry,
          ),
        ),
      );

      expect(outcome).toEqual({
        _tag: "Success",
        value: receipt.settlementEvidence.observation,
      });
      expect(trace.p40ReadInvocations).toEqual([
        expect.objectContaining({
          invocationId,
          executionId,
          workspaceId,
          toolName: "shell",
          toolVersion: "2",
          sideEffectSemantics: "Reconcilable",
          argumentsJson: receipt.argumentsJson,
          resolvedRegions: receipt.prior.resolvedRegions,
          approvalId: null,
        }),
      ]);
      expect(trace.p40ReadFences).toEqual([receipt.context.executionFence]);
      expect(trace.p40ReadFenceTimes).toEqual(["2026-01-01T00:00:00.000Z"]);
      expect(trace.p39SelectedReads).toBe(1);
      if (terminalOutcome === "ExpectedFailure") {
        expect(receipt.prior.resultRef).toBeNull();
        expect(receipt.selected.fact.resultRef).toBe(
          "art_p4_occurred_terminal_result",
        );
      }
      expect(trace.reconciliationCalls ?? 0).toBe(0);
      expect(trace.reconciliationFactWrites ?? 0).toBe(0);
      expect(trace.resourceAdmissionCalls ?? 0).toBe(0);
      expect(trace.effectAdmissions).toBe(0);
      expect(executorCalls).toBe(0);
    },
  );

  it("falls back to strict replay when a terminal Reconcilable Success has no P39 selected fact", async () => {
    const receipt = p39TerminalReceiptCase("Success");
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
      p40WinnerEvidence: receipt.settlementEvidence,
      reconciliationRetry: {
        profile: receipt.profile,
        verifiedBinding: receipt.verifiedBinding,
        attempt: receipt.attempt,
        authority: receipt.authority,
        result: receipt.result,
        factId: receipt.factId,
        settlementEvidence: receipt.settlementEvidence,
      },
    };
    let executorCalls = 0;
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* ToolRuntimePort;
          return yield* runtime.invoke(
            {
              ...intent(receipt.argumentsJson),
              toolName: "shell",
              toolVersion: "2",
              invocationId,
              approvalId: null,
            } as never,
            receipt.context,
          );
        }),
        app(
          false,
          {
            name: "shell",
            write: true,
            requiresApproval: () => false,
            execute: () => {
              executorCalls += 1;
              return Effect.die(new Error("ordinary receipt replay executed"));
            },
          },
          {},
          trace,
          undefined,
          false,
          receipt.prior,
          "rev",
          trace.reconciliationRetry,
        ),
      ),
    );

    expect(result).toEqual(receipt.settlementEvidence.observation);
    expect(trace.p40ReadInvocations).toHaveLength(2);
    expect(trace.resourceAdmissionCalls).toBe(1);
    expect(trace.reconciliationCalls ?? 0).toBe(0);
    expect(trace.effectAdmissions).toBe(0);
    expect(executorCalls).toBe(0);
  });

  it("keeps strict current-region identity for ordinary settled receipts", async () => {
    const receipt = p39TerminalReceiptCase();
    const ordinarySettled = {
      ...receipt.prior,
      settledAt: "2026-01-01T00:00:04.000Z",
      settlement: { _tag: "ExpectedFailure" as const },
    } satisfies ToolInvocationRecord;
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
      workspaceBoundaryAddresses: [{ _tag: "GitWorktree", path: "/repo/b" }],
      workspaceRevisionSequence: [1, 1],
      p40WinnerEvidence: receipt.settlementEvidence,
      reconciliationRetry: {
        profile: receipt.profile,
        verifiedBinding: receipt.verifiedBinding,
        attempt: receipt.attempt,
        authority: receipt.authority,
        result: receipt.result,
        factId: receipt.factId,
        settlementEvidence: receipt.settlementEvidence,
      },
    };
    const outcome = await Effect.runPromise(
      Effect.provide(
        Effect.match(
          Effect.gen(function* () {
            const runtime = yield* ToolRuntimePort;
            return yield* runtime.invoke(
              {
                ...intent(receipt.argumentsJson),
                toolName: "shell",
                toolVersion: "2",
                invocationId,
                approvalId: null,
              } as never,
              receipt.context,
            );
          }),
          {
            onFailure: (cause) => ({ _tag: "Failure" as const, cause }),
            onSuccess: (value) => ({ _tag: "Success" as const, value }),
          },
        ),
        app(
          false,
          {
            name: "shell",
            write: true,
            requiresApproval: () => false,
            execute: () =>
              Effect.die(new Error("ordinary receipt drift executed")),
          },
          {},
          trace,
          undefined,
          false,
          ordinarySettled,
          "rev",
          trace.reconciliationRetry,
        ),
      ),
    );

    expect(outcome._tag).toBe("Failure");
    if (outcome._tag === "Failure") {
      expect(outcome.cause).toMatchObject({
        _tag: "ToolRuntimeOperationalFailure",
        cause: { _tag: "ToolInvocationIdentityConflict" },
      });
    }
    expect(trace.p40ReadInvocations ?? []).toHaveLength(1);
    expect(trace.reconciliationCalls ?? 0).toBe(0);
    expect(trace.resourceAdmissionCalls ?? 0).toBe(0);
    expect(trace.effectAdmissions).toBe(0);
  });

  it.each([
    "model-identity",
    "callRef",
    "logicalAction",
    "approval-id",
    "missing-selected",
    "corrupt-selected",
    "corrupt-evidence",
    "fence-transition",
  ] as const)(
    "fails closed receipt-first when terminal %s is invalid",
    async (invalidReceipt) => {
      const receipt = p39TerminalReceiptCase();
      const trace: PipelineTrace = {
        noEffectDenials: [],
        events: [],
        approvalConsumer: null,
        intentWrites: 0,
        effectAdmissions: 0,
        approvalConsumes: 0,
        p40WinnerEvidence: receipt.settlementEvidence,
        ...(invalidReceipt === "corrupt-evidence"
          ? { p40ReadFailure: "HashMismatch" as const }
          : {}),
        ...(invalidReceipt === "missing-selected"
          ? {}
          : invalidReceipt === "corrupt-selected"
            ? {
                p39SelectedEvidence: {
                  ...receipt.selected,
                  fact: { ...receipt.selected.fact, factId: "wrong-fact-id" },
                },
              }
            : { p39SelectedEvidence: receipt.selected }),
        ...(invalidReceipt === "fence-transition"
          ? { p39SelectedFenceReject: true }
          : {}),
        ...(invalidReceipt === "missing-selected"
          ? {
              workspaceBoundaryAddresses: [
                { _tag: "GitWorktree" as const, path: "/repo/b" },
              ],
              workspaceRevisionSequence: [1, 1],
            }
          : {}),
        reconciliationRetry: {
          profile: receipt.profile,
          verifiedBinding: receipt.verifiedBinding,
          attempt: receipt.attempt,
          authority: receipt.authority,
          result: receipt.result,
          factId: receipt.factId,
          settlementEvidence: receipt.settlementEvidence,
        },
      };
      const eapId = "eap_terminal_receipt_context";
      const mismatchedPrior =
        invalidReceipt === "model-identity"
          ? { ...receipt.prior, argumentsJson: `${receipt.argumentsJson} ` }
          : invalidReceipt === "approval-id"
            ? { ...receipt.prior, approvalId: eapId }
            : receipt.prior;
      const sourceIdentity = receipt.context.recoveryBindingIdentity;
      if (sourceIdentity === undefined) {
        throw new Error("terminal receipt fixture lacks P3 source identity");
      }
      const contextWithMismatch =
        invalidReceipt === "callRef"
          ? {
              ...receipt.context,
              recoveryBindingIdentity: {
                ...sourceIdentity,
                callRef: "call_wrong_receipt",
              },
            }
          : invalidReceipt === "logicalAction"
            ? {
                ...receipt.context,
                recoveryBindingIdentity: {
                  ...sourceIdentity,
                  logicalActionId: "lac_wrong_receipt",
                },
              }
            : invalidReceipt === "approval-id"
              ? {
                  ...receipt.context,
                  executableApproval: {
                    approvalId: eapId,
                    expectedRevision: 1,
                    state: "Consumed",
                    binding: {
                      executionId,
                      logicalStepNo: 0,
                      repairAttempt: 0,
                      logicalActionId: sourceIdentity.logicalActionId,
                      actionIndex: 0,
                      callRef: "c",
                      toolInvocationId: invocationId,
                    },
                  } as never,
                }
              : receipt.context;
      const intentApprovalId =
        invalidReceipt === "approval-id" ? "iap_different_receipt" : null;
      let executorCalls = 0;
      const outcome = await Effect.runPromise(
        Effect.provide(
          Effect.match(
            Effect.gen(function* () {
              const runtime = yield* ToolRuntimePort;
              return yield* runtime.invoke(
                {
                  ...intent(receipt.argumentsJson),
                  toolName: "shell",
                  toolVersion: "2",
                  invocationId,
                  approvalId: intentApprovalId,
                } as never,
                contextWithMismatch,
              );
            }),
            {
              onFailure: (cause) => ({ _tag: "Failure" as const, cause }),
              onSuccess: (value) => ({ _tag: "Success" as const, value }),
            },
          ),
          app(
            false,
            {
              name: "shell",
              write: true,
              requiresApproval: () => false,
              execute: () => {
                executorCalls += 1;
                return Effect.succeed({
                  settlement: { _tag: "Success" as const },
                  observation: { text: "should not execute", truncated: false },
                  resultRef: null,
                });
              },
            },
            {},
            trace,
            undefined,
            false,
            mismatchedPrior,
            "rev",
            trace.reconciliationRetry,
          ),
        ),
      );

      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure") {
        expect(outcome.cause).toMatchObject({
          _tag:
            invalidReceipt === "fence-transition"
              ? "LeaseFencingRejected"
              : "ToolRuntimeOperationalFailure",
        });
      }
      const readCount =
        invalidReceipt === "model-identity" ||
        invalidReceipt === "callRef" ||
        invalidReceipt === "approval-id"
          ? 0
          : invalidReceipt === "missing-selected"
            ? 1
            : 1;
      expect(trace.p40ReadInvocations ?? []).toHaveLength(readCount);
      expect(trace.p40ReadFences ?? []).toHaveLength(readCount);
      expect(trace.reconciliationCalls ?? 0).toBe(0);
      expect(trace.reconciliationFactWrites ?? 0).toBe(0);
      expect(trace.resourceAdmissionCalls ?? 0).toBe(0);
      expect(trace.effectAdmissions).toBe(0);
      expect(executorCalls).toBe(0);
      expect(trace.environmentResolutions ?? 0).toBe(
        invalidReceipt === "missing-selected" ? 2 : 0,
      );
    },
  );

  it("distinguishes post-I/O authority denial from executable approval denial", () => {
    expect(
      reconciliationRetryDenialReasonCode("InvocationAuthorityDenied"),
    ).toBe("AuthoritySnapshotChanged");
    expect(
      reconciliationRetryDenialReasonCode("ApprovalNoLongerAuthorized"),
    ).toBe("ApprovalNoLongerAuthorized");
    expect(reconciliationRetryDenialReasonCode("ApprovalExpired")).toBe(
      "ApprovalNoLongerAuthorized",
    );
  });

  it("uses fixed P39 target-region digest vectors preserving emitted order and multiplicity", () => {
    const fileRegion = {
      resourceSpaceId: "filesystem",
      normalizedRegion: { kind: "FileTree", path: "/repo/a" },
    } as const;
    const databaseRegion = {
      resourceSpaceId: "database",
      normalizedRegion: { kind: "DatabaseNamespace", namespace: "arbor" },
    } as const;
    const gitAliasRegion = {
      resourceSpaceId: "filesystem",
      normalizedRegion: { kind: "GitWorktree", path: "/repo/a" },
    } as const;

    expect(canonicalRegionString(fileRegion)).toBe(
      '{"resourceSpaceId":"filesystem","kind":"FileTree","path":"/repo/a"}',
    );
    expect(canonicalRegionString(gitAliasRegion)).toBe(
      canonicalRegionString(fileRegion),
    );
    expect(canonicalRegionString(databaseRegion)).toBe(
      '{"resourceSpaceId":"database","kind":"DatabaseNamespace","namespace":"arbor"}',
    );
    expect(targetResourceIdentityDigestV1([])).toBe(
      "bbe6728ecb80f47e10b2735f040f13488a6b26fe040fcebced094c8449d5597b",
    );
    expect(targetResourceIdentityDigestV1([fileRegion])).toBe(
      "c8f8f405369396168ddc9f96bd592547d3d322c495942fd19e9bc04f95fa7763",
    );
    expect(targetResourceIdentityDigestV1([fileRegion, databaseRegion])).toBe(
      "e6f887f5c6144044926c6a0e3c13bdbd69a7bd830c1aabe3b761f69c6d6dbc31",
    );
    expect(targetResourceIdentityDigestV1([databaseRegion, fileRegion])).toBe(
      "2f23f23627a4891e053c2722f7e312927180c0bc87f7f6010fff8acfb0fd4e76",
    );
    expect(targetResourceIdentityDigestV1([fileRegion, fileRegion])).toBe(
      "f4d6c05c3cf0f50bd7a364cb7e462acc48f3b4a0fa245173d0e1ee13e54b0097",
    );
  });

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
      const shell = createShellExecutor();
      const result = await runShell(app(false, shell, {}, trace), command);

      expect(result._tag, command).toBe("ApprovalRequired");
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
      authority: {
        ...authority,
        sourceRevision: JSON.stringify({
          workspacePolicyRevision: 0,
          activeGrants: [],
          verifierId: null,
        }),
      },
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
      authority: {
        ...authority,
        sourceRevision: JSON.stringify({
          workspacePolicyRevision: 0,
          activeGrants: [],
          verifierId: null,
        }),
      },
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

  it("accepts a P39 environment revision only when the current persisted revision exactly matches", async () => {
    const p39Case = p39ApprovedCase("c4", "action-p39-exact-current");
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
      resolvedEnvironmentRevisionSequence: ["rev-exact", "rev-exact"],
      currentEnvironmentRevisionValues: ["rev-exact", "rev-exact"],
      resourceAdmissionCalls: 0,
      p39BindingCalls: 0,
    };
    const result = await run(
      app(false, p39Case.executor, {}, trace, p39Case.approval),
      p39Case.argumentsJson,
      p39Case.approvalId,
      p39Case.approvedContext,
    );

    expect(result).toMatchObject({ _tag: "Success" });
    expect(trace.environmentResolutions).toBe(2);
    expect(trace.resourceAdmissionCalls).toBe(1);
    expect(trace.intentWrites).toBe(1);
    expect(trace.approvalConsumes).toBe(1);
    expect(trace.p39BindingCalls).toBe(1);
    expect(trace.claimedBindings?.[0]?.environmentRevision).toBe("rev-exact");
    expectWorkspaceSnapshotPhases(trace, [
      {
        phase: "InitialBoundaryResolve",
        workspaceId,
        revision: 0,
        addresses: fixtureWorkspaceAddresses,
      },
      {
        phase: "FinalClaimFreshness",
        workspaceId,
        revision: 0,
        addresses: fixtureWorkspaceAddresses,
      },
    ]);
    expect(trace.claimedBindings?.[0]?.resourceBoundaryRevision).toBe(
      trace.workspaceSnapshots?.[0]?.revision,
    );
    expect(trace.effectAdmissions).toBe(1);
  });

  it("refreshes once when invocation and boundary environment revisions differ", async () => {
    const p39Case = p39ApprovedCase("c5", "action-p39-invocation-boundary");
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
      resolvedEnvironmentRevisionSequence: [
        "invocation-old",
        "boundary-old",
        "rev-fresh",
        "rev-fresh",
      ],
      currentEnvironmentRevisionValues: ["rev-fresh", "rev-fresh"],
      resourceAdmissionCalls: 0,
      p39BindingCalls: 0,
    };
    const result = await run(
      app(false, p39Case.executor, {}, trace, p39Case.approval),
      p39Case.argumentsJson,
      p39Case.approvalId,
      p39Case.approvedContext,
    );

    expect(result).toMatchObject({ _tag: "Success" });
    expect(trace.environmentResolutions).toBe(4);
    expect(trace.resourceAdmissionCalls).toBe(1);
    expect(trace.intentWrites).toBe(1);
    expect(trace.approvalConsumes).toBe(1);
    expect(trace.p39BindingCalls).toBe(1);
    expect(trace.claimedBindings?.[0]?.environmentRevision).toBe("rev-fresh");
    expectWorkspaceSnapshotPhases(trace, [
      {
        phase: "InitialBoundaryResolve",
        workspaceId,
        revision: 0,
        addresses: fixtureWorkspaceAddresses,
      },
      {
        phase: "RefreshedBoundaryResolve",
        workspaceId,
        revision: 0,
        addresses: fixtureWorkspaceAddresses,
      },
      {
        phase: "FinalClaimFreshness",
        workspaceId,
        revision: 0,
        addresses: fixtureWorkspaceAddresses,
      },
    ]);
    expect(trace.claimedBindings?.[0]?.resourceBoundaryRevision).toBe(
      trace.workspaceSnapshots?.[1]?.revision,
    );
    expect(trace.effectAdmissions).toBe(1);
  });

  it.each(["revision", "addresses"] as const)(
    "rolls back the approved P39 claim when Workspace %s changes at final claim validation after refresh was spent",
    async (changedWorkspaceField) => {
      const p39Case = p39ApprovedCase(
        changedWorkspaceField === "revision" ? "c4" : "c5",
        `action-p39-final-workspace-${changedWorkspaceField}`,
      );
      const originalAddresses = [
        { _tag: "GitWorktree", path: "/repo/a" },
      ] as const;
      const changedAddresses = [
        { _tag: "GitWorktree", path: "/repo/changed" },
      ] as const;
      const trace: PipelineTrace = {
        noEffectDenials: [],
        events: [],
        approvalConsumer: null,
        intentWrites: 0,
        effectAdmissions: 0,
        approvalConsumes: 0,
        resolvedEnvironmentRevisionSequence: [
          "invocation-old",
          "boundary-old",
          "rev-fresh",
          "rev-fresh",
        ],
        currentEnvironmentRevisionValues: ["rev-fresh", "rev-fresh"],
        workspaceRevisionSequence:
          changedWorkspaceField === "revision" ? [0, 0, 1] : [0, 0, 0],
        workspaceBoundaryAddressSequence:
          changedWorkspaceField === "addresses"
            ? [originalAddresses, originalAddresses, changedAddresses]
            : [originalAddresses, originalAddresses, originalAddresses],
        resourceAdmissionCalls: 0,
        p39BindingCalls: 0,
      };
      const failure = await Effect.runPromise(
        Effect.provide(
          Effect.match(
            Effect.gen(function* () {
              const runtime = yield* ToolRuntimePort;
              return yield* runtime.invoke(
                {
                  ...intent(p39Case.argumentsJson),
                  approvalId: p39Case.approvalId,
                } as never,
                p39Case.approvedContext,
              );
            }),
            {
              onFailure: (cause) => ({ _tag: "Failure" as const, cause }),
              onSuccess: (value) => ({ _tag: "Success" as const, value }),
            },
          ),
          app(false, p39Case.executor, {}, trace, p39Case.approval),
        ),
      );

      expect(failure._tag).toBe("Failure");
      if (failure._tag === "Failure") {
        expect(failure.cause).toMatchObject({
          _tag: "ToolRuntimeOperationalFailure",
          stage: "ResourceResolutionStale",
        });
      }
      expect(trace.environmentResolutions).toBe(4);
      expect(trace.workspaceSnapshots).toHaveLength(3);
      expectWorkspaceSnapshotPhases(trace, [
        {
          phase: "InitialBoundaryResolve",
          workspaceId,
          revision: 0,
          addresses: originalAddresses,
        },
        {
          phase: "RefreshedBoundaryResolve",
          workspaceId,
          revision: 0,
          addresses: originalAddresses,
        },
        {
          phase: "FinalClaimFreshness",
          workspaceId,
          revision: changedWorkspaceField === "revision" ? 1 : 0,
          addresses:
            changedWorkspaceField === "addresses"
              ? changedAddresses
              : originalAddresses,
        },
      ]);
      expect(trace.resourceAdmissionCalls).toBe(0);
      expect(trace.intentWrites).toBe(0);
      expect(trace.approvalConsumes).toBe(0);
      expect(trace.approvalConsumer).toBeNull();
      expect(trace.p39BindingCalls).toBe(0);
      expect(trace.effectAdmissions).toBe(0);
      expect(trace.noEffectDenials).toEqual([]);
    },
  );

  it("accepts P39 environment None only for observed revision zero and binds only the selected target region", async () => {
    const argumentsJson = '{"target":{"mount":"workspace","path":"."}}';
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
      resolvedEnvironmentRevisionSequence: ["0", "0"],
      currentEnvironmentRevisionValues: [null, null],
      workspaceBoundaryAddresses: [
        { _tag: "GitWorktree", path: "/repo/a" },
        { _tag: "ExternalResource", address: "https://example.test" },
      ],
    };
    const p39Context = {
      ...context,
      authority: {
        ...authority,
        sourceRevision: JSON.stringify({
          workspacePolicyRevision: 0,
          activeGrants: [],
          verifierId: null,
        }),
      },
      recoveryBindingIdentity: {
        executionId,
        providerTurnId: parse(ProviderTurnId)(
          "ptn_018f2b3c-4d5e-7abc-8def-0123456789c1",
        ),
        logicalStepNo: 10,
        repairAttempt: 0,
        logicalActionId: "action-p39-none-zero",
        actionIndex: 0,
        callRef: "c",
      },
      recoveryBindingPolicyRevisions: {
        workspacePolicyRevision: 0,
        projectPolicyRevision: 0,
      },
    } as import("@arbor/ports").ToolExecutionContext;

    const result = await run(
      app(false, okExecutor, {}, trace),
      argumentsJson,
      null,
      p39Context,
    );
    const targetRegions = trace.resourceAdmissionRegions?.[0];
    const boundaryRegions = trace.resourceAdmissionBoundaryRegions?.[0];
    const binding = trace.claimedBindings?.[0];

    expect(result).toMatchObject({ _tag: "Success" });
    expect(trace.environmentResolutions).toBe(2);
    expect(targetRegions).toHaveLength(1);
    expect(boundaryRegions).toHaveLength(2);
    expect(targetResourceIdentityDigestV1(targetRegions ?? [])).toBe(
      binding?.targetResourceIdentityDigest,
    );
    expect(targetResourceIdentityDigestV1(targetRegions ?? [])).not.toBe(
      targetResourceIdentityDigestV1(boundaryRegions ?? []),
    );
    expect(binding?.environmentRevision).toBe("0");
    expect(trace.intentWrites).toBe(1);
    expect(trace.p39BindingCalls).toBe(1);
    expect(trace.effectAdmissions).toBe(1);
  });

  it("refreshes exactly once after the first stale P39 revision, then consumes the fresh snapshot", async () => {
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
      resolvedEnvironmentRevisionSequence: ["rev1", "rev1", "rev2", "rev2"],
      currentEnvironmentRevisionValues: [null, "rev2", "rev2"],
      resourceAdmissionCalls: 0,
    };
    const p39Context = {
      ...context,
      authority: {
        ...authority,
        sourceRevision: JSON.stringify({
          workspacePolicyRevision: 0,
          activeGrants: [],
          verifierId: null,
        }),
      },
      recoveryBindingIdentity: {
        executionId,
        providerTurnId: parse(ProviderTurnId)(
          "ptn_018f2b3c-4d5e-7abc-8def-0123456789c2",
        ),
        logicalStepNo: 11,
        repairAttempt: 0,
        logicalActionId: "action-p39-refresh-once",
        actionIndex: 0,
        callRef: "c",
      },
      recoveryBindingPolicyRevisions: {
        workspacePolicyRevision: 0,
        projectPolicyRevision: 0,
      },
    } as import("@arbor/ports").ToolExecutionContext;
    const result = await run(
      app(false, okExecutor, {}, trace),
      '{"target":{"mount":"workspace","path":"."}}',
      null,
      p39Context,
    );

    expect(result).toMatchObject({ _tag: "Success" });
    expect(trace.environmentResolutions).toBe(4);
    expect(trace.resourceAdmissionCalls).toBe(1);
    expect(trace.intentWrites).toBe(1);
    expect(trace.approvalConsumes).toBe(0);
    expect(trace.p39BindingCalls).toBe(1);
    expect(trace.effectAdmissions).toBe(1);
  });

  it("fails closed after the single allowed P39 stale-snapshot refresh", async () => {
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
      resolvedEnvironmentRevisionSequence: ["rev1", "rev1", "rev2", "rev2"],
      currentEnvironmentRevisionValues: [null, "still-stale"],
      resourceAdmissionCalls: 0,
      p39BindingCalls: 0,
    };
    const p39Context = {
      ...context,
      authority: {
        ...authority,
        sourceRevision: JSON.stringify({
          workspacePolicyRevision: 0,
          activeGrants: [],
          verifierId: null,
        }),
      },
      recoveryBindingIdentity: {
        executionId,
        providerTurnId: parse(ProviderTurnId)(
          "ptn_018f2b3c-4d5e-7abc-8def-0123456789c3",
        ),
        logicalStepNo: 12,
        repairAttempt: 0,
        logicalActionId: "action-p39-stale-twice",
        actionIndex: 0,
        callRef: "c",
      },
      recoveryBindingPolicyRevisions: {
        workspacePolicyRevision: 0,
        projectPolicyRevision: 0,
      },
    } as import("@arbor/ports").ToolExecutionContext;
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
        app(false, okExecutor, {}, trace),
      ),
    );

    expect(outcome._tag).toBe("Failure");
    if (outcome._tag === "Failure") {
      expect(outcome.cause).toMatchObject({
        _tag: "ToolRuntimeOperationalFailure",
        stage: "ResourceResolutionStale",
      });
    }
    expect(trace.environmentResolutions).toBe(4);
    expect(trace.resourceAdmissionCalls).toBe(0);
    expect(trace.intentWrites).toBe(0);
    expect(trace.approvalConsumes).toBe(0);
    expect(trace.p39BindingCalls).toBe(0);
    expect(trace.effectAdmissions).toBe(0);
    expect(trace.noEffectDenials).toEqual([]);
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
    expect(trace).toMatchObject({
      noEffectDenials: ["ResourceAdmissionDenied"],
      events: ["denied"],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
    });
    expectWorkspaceSnapshotPhases(trace, [
      {
        phase: "InitialBoundaryResolve",
        workspaceId,
        revision: 0,
        addresses: fixtureWorkspaceAddresses,
      },
      {
        phase: "FinalClaimFreshness",
        workspaceId,
        revision: 0,
        addresses: fixtureWorkspaceAddresses,
      },
    ]);
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
    expect(trace).toMatchObject({
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
    });
    expectWorkspaceSnapshotPhases(trace, [
      {
        phase: "InitialBoundaryResolve",
        workspaceId,
        revision: 0,
        addresses: fixtureWorkspaceAddresses,
      },
    ]);
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
    expect(trace).toMatchObject({
      noEffectDenials: ["ApprovalNotFound"],
      events: ["denied"],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
    });
    expectWorkspaceSnapshotPhases(trace, [
      {
        phase: "InitialBoundaryResolve",
        workspaceId,
        revision: 0,
        addresses: fixtureWorkspaceAddresses,
      },
    ]);
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
