import {
  Actor,
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
  canonicalArgumentsDigestV1,
  canonicalizeRecoveryBindingV1,
  type ExecutableApprovalRecord,
  type RecoveryBindingV1,
  reconciliationFactId,
  recoveryBindingV1Digest,
  type SandboxProcessPolicy,
  type SelectedP39EffectAttempt,
  type SelectedP39ReconciliationFact,
  type SelectedP39RecoveryEvidence,
  type ToolInvocationRecord,
  type ToolObservationEvidence,
  type ToolReconciliationProfile,
  type ToolReconciliationResult,
  targetResourceIdentityDigestV1,
  toolDefinitionIdentityDigestV1,
  verifyRecoveryBindingV1,
} from "@arbor/ports";
import { Effect } from "effect";
import { expect } from "vitest";
import {
  actionDigestOf,
  LEGACY_SHELL_DEFINITION,
  type ToolExecutor,
} from "../../src/index.js";
import type { PipelineTrace } from "./support-harness.js";

export const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
export const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
export const projectId = parse(ProjectId)(
  "prj_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
export const sessionId = parse(SessionId)(
  "ses_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
export const principal = parse(Principal)("worker:a");
export const actor = parse(Actor)("worker:a");
export const invocationId = parse(ToolInvocationId)(
  "tin_018f2b3c-4d5e-7abc-8def-0123456789a1",
);

export const authority = {
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
export const context = {
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
export const intent = (argumentsJson: string) => ({
  callRef: "c",
  toolName: "read",
  toolVersion: "2",
  argumentsJson,
  invocationId,
  approvalId: null,
});

export const okExecutor: ToolExecutor = {
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

/** A shell executor whose execution is a defect: retry-replay paths must
 * never reach it, so a die pins that invariant louder than a stub result. */
export const mustNotExecuteShellExecutor = (reason: string): ToolExecutor => ({
  name: "shell",
  write: true,
  requiresApproval: () => false,
  execute: () => Effect.die(new Error(reason)),
});

/** The recovery-bound context every P39 environment-freshness test builds:
 * the JSON authority snapshot plus a distinct recovery-binding identity. */
export const p39RecoveryContext = (
  providerTurnId: string,
  logicalStepNo: number,
  logicalActionId: string,
): import("@arbor/ports").ToolExecutionContext => ({
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
    providerTurnId: parse(ProviderTurnId)(providerTurnId),
    logicalStepNo,
    repairAttempt: 0,
    logicalActionId,
    actionIndex: 0,
    callRef: "c",
  },
  recoveryBindingPolicyRevisions: {
    workspacePolicyRevision: 0,
    projectPolicyRevision: 0,
  },
});

export const p39ApprovedCase = (
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
        `ptn_${executionId}_13_r${Number.parseInt(suffix, 16)}`,
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

export const p39NotOccurredRetryCase = (
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

export const p39TerminalReceiptCase = (
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

export const fixtureWorkspaceAddresses = [
  { _tag: "GitWorktree", path: "/repo/a" },
] as const satisfies ReadonlyArray<import("@arbor/domain").ResourceAddress>;

export const expectWorkspaceSnapshotPhases = (
  trace: PipelineTrace,
  expected: NonNullable<PipelineTrace["workspaceSnapshots"]>,
) => {
  expect(trace.workspaceSnapshots).toEqual(expected);
};

export const processEpisode: ExecutionEpisodeBinding = {
  _tag: "InboxEpisode",
  entryKey: "p4-sandbox-process-entry",
  inputKind: "HumanMessage",
};

export const processPolicy = (
  episodeBinding: ExecutionEpisodeBinding,
  providerId = "bwrap",
  providerVersion = "0.8.0",
): Extract<
  SandboxProcessPolicy,
  { readonly kind: "OsEnforcedProcessPolicy" }
> => ({
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

export const processContext = (
  policy: Exclude<
    SandboxProcessPolicy,
    { readonly kind: "IndependentVerificationProcessPolicyV1" }
  >,
  currentEpisode: ExecutionEpisodeBinding = policy.episodeBinding,
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

export const processExecutor: ToolExecutor = {
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

export const sandboxCapability = (
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
