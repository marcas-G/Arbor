import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { expect } from "vitest";
import { loadSandboxAuthorityBundleSnapshotCurrent } from "../../../../apps/single-workspace/src/sandbox-authority-bundle.js";
import {
  type EffectivePolicySummaryV1,
  encodeEffectivePolicySummaryV1,
} from "../../../../packages/domain/src/index.js";
import {
  SANDBOX_ENV_ALLOWLIST,
  sha256Hex,
} from "../../../../packages/ports/src/index.js";
import { functionalId, waitForPublic } from "../../support/public-client.js";
import {
  commitSandboxPolicyV3HighWater,
  sandboxPolicyV3TestPair,
  writeSandboxPolicyV3SourceFirst,
} from "../../support/sandbox-policy-v3-source.js";
import {
  isP9SandboxUnavailableTerminal,
  postDecisionExpectedFailureProbeForInvocation,
  readP9OutcomeSourceForProbe,
} from "./p9-oracle.js";
import {
  child,
  decodeToolObservation,
  durableSandboxRead,
  freshExecutionDiagnosticSnapshot,
  operatorCommand,
  p1OwnedDomainSnapshot,
  policyPayload,
  sandboxDecisionDebug,
  type V6eScenarioState,
  type WorkspaceDetailForSandbox,
} from "./support.js";

export const v6ePhaseFreshRootDriftVerdict = async (
  s: V6eScenarioState,
): Promise<void> => {
  const { executableProbeLines, schedulerProbeLines } = s;
  const fixture = s.fixture!;
  const client = s.client!;
  const providerCallsBeforeFreshRoot = s.providerCallsBeforeFreshRoot;
  const freshProjectRootDirectory = s.freshProjectRootDirectory;
  const freshProject = s.freshProject!;
  const freshExecutionId = s.freshExecutionId;
  const freshPreDriftRead = s.freshPreDriftRead!;
  const freshExecutableApproval = s.freshExecutableApproval!;
  const preDriftCandidate = s.preDriftCandidate!;
  const freshPreIntentState = s.freshPreIntentState!;
  const freshPreIntentApproval = s.freshPreIntentApproval;
  const p1GrantExpiresAt = s.p1GrantExpiresAt;
  const freshOldPayload = s.freshOldPayload;
  const driftPid = fixture.daemonProcessSnapshot()?.pid;
  await fixture.crash();
  if (s.sourceFilename === undefined)
    throw new Error("schema-50 V3 source path disappeared before drift");
  const driftedPair = sandboxPolicyV3TestPair({
    bundleRevision: 2,
    registryRevision: 2,
    includeRegistryDrift: true,
  });
  writeSandboxPolicyV3SourceFirst(s.sourceFilename, driftedPair);
  const sourceFirstPair = JSON.parse(
    readFileSync(s.sourceFilename, "utf8"),
  ) as {
    readonly sourceIdentity: string;
    readonly bundleCanonicalJson: string;
    readonly highWaterCanonicalJson: string;
  };
  const sourceFirst = await Effect.runPromise(
    loadSandboxAuthorityBundleSnapshotCurrent(
      {
        readVerifiedSandboxAuthorityBundle: () =>
          Effect.succeed({
            sourceIdentity: sourceFirstPair.sourceIdentity,
            canonicalJson: sourceFirstPair.bundleCanonicalJson,
          }),
        readSandboxAuthorityHighWater: () =>
          Effect.succeed(sourceFirstPair.highWaterCanonicalJson),
        commitSandboxAuthorityHighWater: () => Effect.succeed(false),
        appendSandboxAuthorityAudit: () => Effect.succeed(true),
      },
      new Date().toISOString(),
      SANDBOX_ENV_ALLOWLIST,
    ),
  );
  expect(sourceFirst).toMatchObject({ _tag: "Unavailable" });
  commitSandboxPolicyV3HighWater(s.sourceFilename, driftedPair);
  await fixture.restart({
    entry: child,
    projectRootDirectory: freshProjectRootDirectory,
    daemonEnvironment: {
      ARBOR_AH_BOUNDARY: "disabled",
      ARBOR_TICK_INTERVAL_MS: "25",
      ARBOR_SCHEDULER_PROBE: "1",
    },
  });
  expect(fixture.daemonProcessSnapshot()?.pid).not.toBe(driftPid);

  const refreshedFreshDetail = await waitForPublic(
    () =>
      client.view<WorkspaceDetailForSandbox>("workspace-detail", {
        workspaceId: freshProject.rootWorkspaceId,
      }),
    (detail) =>
      detail.sandboxPolicyCandidateRead?.commonPreconditions
        .authorityBundleRevision === 2,
  );
  const refreshedFreshRead = refreshedFreshDetail.sandboxPolicyCandidateRead;
  if (refreshedFreshRead === undefined)
    throw new Error("fresh CandidateRead was absent after restart");
  expect(refreshedFreshRead.commonPreconditions.authorityBundleDigest).not.toBe(
    freshPreDriftRead.commonPreconditions.authorityBundleDigest,
  );
  const refreshedCandidate = refreshedFreshRead.candidates.find(
    (candidate) =>
      candidate.kind === "OsEnforced" &&
      candidate.providerId === "windows-restricted-appcontainer-job" &&
      candidate.profile === "ReadOnly" &&
      candidate.networkMode === "Disabled",
  );
  if (refreshedCandidate?.kind !== "OsEnforced")
    throw new Error("fresh post-drift Supported candidate was absent");
  expect(refreshedCandidate.providerRegistryRevision).toBe(2);
  expect(refreshedCandidate.providerRegistryDigest).not.toBe(
    preDriftCandidate.providerRegistryDigest,
  );
  expect(refreshedCandidate.profile).toBe(preDriftCandidate.profile);
  expect(refreshedCandidate.networkMode).toBe(preDriftCandidate.networkMode);
  expect(refreshedCandidate.providerVersion).toBe(
    preDriftCandidate.providerVersion,
  );
  expect(refreshedCandidate.capabilityRevision).toBe(
    preDriftCandidate.capabilityRevision,
  );

  const beforeStaleOwnedSnapshot = p1OwnedDomainSnapshot(
    fixture.databaseFile,
    freshExecutionId,
  );
  expect(beforeStaleOwnedSnapshot.decisions).toEqual([]);
  expect(beforeStaleOwnedSnapshot.decisionEvents).toEqual([]);
  expect(beforeStaleOwnedSnapshot.invocations).toEqual([]);
  expect(beforeStaleOwnedSnapshot.recoveryBindings).toEqual([]);
  expect(beforeStaleOwnedSnapshot.executableApprovals).toHaveLength(1);
  expect(beforeStaleOwnedSnapshot.executableApprovals[0]).toMatchObject({
    approval_id: freshExecutableApproval.approvalId,
    route_kind: "Executable",
    execution_id: freshExecutionId,
    state: "Pending",
    revision: freshExecutableApproval.revision,
    consumed_by: null,
  });
  expect(beforeStaleOwnedSnapshot.actions).toEqual(
    freshPreIntentState.actions.map((action) => ({
      logical_step_no: action.logical_step_no,
      repair_attempt: action.repair_attempt,
      action_index: action.action_index,
      logical_action_id: action.logical_action_id,
      call_ref: action.call_ref,
      state: action.state,
      result_ref: action.result_ref,
      settlement_ref: action.settlement_ref,
      disposition_json: action.disposition_json,
      observation_source_ref: action.observation_source_ref,
      revision: action.revision,
    })),
  );
  expect(beforeStaleOwnedSnapshot.steps).toEqual(
    freshPreIntentState.steps.map((step) => ({
      logical_step_no: step.logical_step_no,
      repair_attempt: step.repair_attempt,
      provider_turn_id: step.provider_turn_id,
      state: step.state,
      revision: step.revision,
      next_action_index: step.next_action_index,
      settlement_json: step.settlement_json,
    })),
  );
  const staleFreshCommandId = functionalId("cmd");
  const staleFresh = await operatorCommand(
    fixture.baseUrl,
    freshProject.projectId,
    "DecideSandboxPolicy",
    freshOldPayload,
    staleFreshCommandId,
  );
  expect(staleFresh).toMatchObject({
    body: {
      resolution: "TerminalRejected",
      rejection: "StaleSandboxPolicyInputs",
    },
  });
  const afterStaleOwnedSnapshot = p1OwnedDomainSnapshot(
    fixture.databaseFile,
    freshExecutionId,
  );
  expect(afterStaleOwnedSnapshot).toEqual(beforeStaleOwnedSnapshot);
  const freshReadAfterStale = await client.view<WorkspaceDetailForSandbox>(
    "workspace-detail",
    {
      workspaceId: freshProject.rootWorkspaceId,
    },
  );
  expect(
    freshReadAfterStale.sandboxPolicyCandidateRead?.commonPreconditions,
  ).toEqual(refreshedFreshRead.commonPreconditions);
  expect(
    freshReadAfterStale.sandboxPolicyCandidateRead?.candidates.find(
      (candidate) =>
        candidate.kind === "OsEnforced" &&
        candidate.providerId === "windows-restricted-appcontainer-job" &&
        candidate.profile === "ReadOnly" &&
        candidate.networkMode === "Disabled",
    ),
  ).toEqual(refreshedCandidate);
  const untouchedFresh = durableSandboxRead(
    fixture.databaseFile,
    freshExecutionId,
  );
  expect(untouchedFresh.decisions).toEqual({ count: 0 });
  expect(untouchedFresh.decisionEvents).toEqual({ count: 0 });
  expect(untouchedFresh.actions).toHaveLength(1);
  expect(untouchedFresh.actions[0]).toMatchObject({
    state: "Pending",
    action_index: 0,
  });
  expect(untouchedFresh.invocation).toBeUndefined();

  const freshPayload = policyPayload({
    read: refreshedFreshRead,
    projectId: freshProject.projectId,
    workspaceId: freshProject.rootWorkspaceId,
    executionId: freshExecutionId,
    expiresAt: p1GrantExpiresAt,
  });
  expect(freshPayload.profile).toBe(preDriftCandidate.profile);
  expect(freshPayload.networkPolicy).toEqual({
    kind: "OsEnforced",
    policy: { version: 1, mode: "Disabled", destinations: [] },
  });
  const acceptedFresh = await operatorCommand(
    fixture.baseUrl,
    freshProject.projectId,
    "DecideSandboxPolicy",
    freshPayload,
  );
  expect(acceptedFresh).toMatchObject({
    body: { resolution: "Committed" },
  });
  const afterFreshP1State = freshExecutionDiagnosticSnapshot(
    fixture.databaseFile,
    freshExecutionId,
  );
  expect(afterFreshP1State.sandboxDecisions).toHaveLength(1);
  expect(afterFreshP1State.invocations).toEqual([]);
  expect(afterFreshP1State.recoveryBindings).toEqual([]);
  expect(afterFreshP1State.executableApprovals).toHaveLength(1);
  expect(afterFreshP1State.executableApprovals[0]).toMatchObject({
    approval_id: freshExecutableApproval.approvalId,
    state: "Pending",
    revision: freshExecutableApproval.revision,
    consumed_by: null,
  });
  const freshInvocationId = String(
    freshPreIntentApproval?.tool_invocation_id ?? "",
  );
  expect(freshInvocationId).toMatch(/^tin_/u);
  const freshP4ProbeStartIndex = executableProbeLines.length;
  const freshApprovalResolution = await client.command(
    freshProject.projectId,
    "ResolveExecutableApproval",
    {
      approvalId: freshExecutableApproval.approvalId,
      expectedRevision: freshExecutableApproval.revision,
      decision: "Approve",
      reason: "V6 fresh P1 committed before exact shell approval",
    },
  );
  expect(freshApprovalResolution).toMatchObject({
    body: { resolution: "Committed" },
  });
  const postApprovalSchedulerProbeStartIndex = schedulerProbeLines.length;
  const acceptedFreshP4Outcome = await waitForPublic(
    async () => {
      const probeRecord = postDecisionExpectedFailureProbeForInvocation({
        probes: executableProbeLines,
        startIndex: freshP4ProbeStartIndex,
        executionId: freshExecutionId,
        invocationId: freshInvocationId,
      });
      const postApprovalSchedulerDispatchObserved = schedulerProbeLines
        .slice(postApprovalSchedulerProbeStartIndex)
        .some(
          (event) =>
            event.boundary === "PreDispatchLeaseCheck" &&
            event.executionId === freshExecutionId &&
            event.dispatchable === true,
        );
      return {
        postApprovalSchedulerDispatchObserved,
        probe: probeRecord,
        source:
          probeRecord === undefined
            ? undefined
            : readP9OutcomeSourceForProbe(fixture.databaseFile, probeRecord),
      };
    },
    (value) =>
      value?.postApprovalSchedulerDispatchObserved === true &&
      value.probe !== undefined &&
      value.source !== undefined &&
      value.source.invocation?.settled_at !== null &&
      value.source.invocation?.settlement_kind === "ExpectedFailure" &&
      value.source.invocation.recovery_binding_state === "Bound" &&
      value.source.action?.state === "TerminalRejected" &&
      ["StepEffectsCommitted", "NextStepReady", "SettlementProposed"].includes(
        value.source.step?.state ?? "",
      ) &&
      isP9SandboxUnavailableTerminal({
        probe: value.probe,
        invocation: value.source.invocation,
        action: value.source.action,
        step: value.source.step,
        unavailableFact: value.source.unavailableFact,
        effectAttempts: value.source.effectAttempts,
        artifacts: value.source.artifacts,
      }),
    45_000,
  );
  if (acceptedFreshP4Outcome === undefined)
    throw new Error("fresh P4 no-effect settlement was absent");
  if (
    acceptedFreshP4Outcome.probe === undefined ||
    acceptedFreshP4Outcome.source === undefined
  )
    throw new Error("fresh P4 probe source was incomplete");
  if (
    acceptedFreshP4Outcome.source.invocation === undefined ||
    acceptedFreshP4Outcome.source.action === undefined ||
    acceptedFreshP4Outcome.source.step === undefined ||
    acceptedFreshP4Outcome.source.unavailableFact === undefined
  )
    throw new Error("fresh P4 terminal evidence was incomplete");
  expect(acceptedFreshP4Outcome.probe).toMatchObject({
    outcomeTag: "ExpectedFailure",
    invocationId: freshInvocationId,
    executionId: freshExecutionId,
  });
  expect(acceptedFreshP4Outcome.source.invocation).toMatchObject({
    effect_admission_state: "MayHaveStarted",
    recovery_binding_state: "Bound",
    settlement_kind: "ExpectedFailure",
    result_ref: null,
  });
  expect(acceptedFreshP4Outcome.source.unavailableFact).toMatchObject({
    execution_id: freshExecutionId,
    policy_revision: 1,
    profile_id: preDriftCandidate.profile,
    provider_id: preDriftCandidate.providerId,
    provider_version: preDriftCandidate.providerVersion,
    failure_code: "ProviderVersionMismatch",
  });
  expect(acceptedFreshP4Outcome.source.effectAttempts).toHaveLength(1);
  expect(acceptedFreshP4Outcome.source.effectAttempts[0]).toMatchObject({
    invocation_id: freshInvocationId,
    attempt_no: 0,
    admission_state: "MayHaveStarted",
    admission_source: "P39Admission",
    binding_sha256:
      acceptedFreshP4Outcome.source.invocation.recovery_binding_sha256,
  });
  expect(acceptedFreshP4Outcome.source.artifacts).toEqual([]);
  expect(
    decodeToolObservation(
      acceptedFreshP4Outcome.source.invocation.observation_json,
    ),
  ).toMatchObject({
    _tag: "ExpectedFailure",
    observation: {
      text: expect.stringContaining("execution did not start"),
    },
    sandboxProviderUnavailable: {
      failureCode: "ProviderVersionMismatch",
      effectDisposition: "NoEffect",
    },
  });
  expect(acceptedFreshP4Outcome.source.action).toMatchObject({
    state: "TerminalRejected",
    action_index: acceptedFreshP4Outcome.probe.actionIndex,
    logical_action_id: acceptedFreshP4Outcome.probe.logicalActionId,
    call_ref: acceptedFreshP4Outcome.probe.callRef,
  });
  const postDecisionP9Evidence = freshExecutionDiagnosticSnapshot(
    fixture.databaseFile,
    freshExecutionId,
  );
  expect(postDecisionP9Evidence.executableApprovals).toHaveLength(1);
  expect(postDecisionP9Evidence.executableApprovals[0]).toMatchObject({
    approval_id: freshExecutableApproval.approvalId,
    state: "Consumed",
    consumed_by: freshInvocationId,
    tool_invocation_id: freshInvocationId,
  });
  expect(postDecisionP9Evidence.providerUnavailableFacts).toHaveLength(1);
  expect(postDecisionP9Evidence.providerUnavailableFacts[0]).toMatchObject({
    policy_revision: 1,
    profile_id: preDriftCandidate.profile,
    provider_id: preDriftCandidate.providerId,
    provider_version: preDriftCandidate.providerVersion,
    failure_code: "ProviderVersionMismatch",
  });
  const freshDecision = sandboxDecisionDebug(
    fixture.databaseFile,
    freshExecutionId,
  ) as
    | {
        readonly policy_digest?: string;
        readonly profile_id?: string;
        readonly provider_id?: string;
        readonly result_json?: string;
      }
    | undefined;
  if (freshDecision?.result_json === undefined)
    throw new Error("fresh committed P1 effective summary is absent");
  const freshDecisionResult = JSON.parse(freshDecision.result_json) as {
    readonly policyDigest?: string;
    readonly effectivePolicySnapshot?: Record<string, unknown>;
  };
  const effectiveSnapshot = freshDecisionResult.effectivePolicySnapshot;
  if (effectiveSnapshot === undefined)
    throw new Error("fresh P1 effective summary payload is missing");
  expect(freshDecision.policy_digest).toMatch(/^[0-9a-f]{64}$/u);
  expect(freshDecisionResult.policyDigest).toBe(freshDecision.policy_digest);
  expect(
    sha256Hex(
      encodeEffectivePolicySummaryV1(
        effectiveSnapshot as unknown as EffectivePolicySummaryV1,
      ),
    ),
  ).toBe(freshDecision.policy_digest);
  expect(effectiveSnapshot).toMatchObject({
    kind: "OsEnforced",
    profile: preDriftCandidate.profile,
    providerId: preDriftCandidate.providerId,
    providerVersion: preDriftCandidate.providerVersion,
    capabilityRevision: preDriftCandidate.capabilityRevision,
    providerRegistryRevision: refreshedCandidate.providerRegistryRevision,
    providerRegistryDigest: refreshedCandidate.providerRegistryDigest,
    sandboxHandleBindingDigest: refreshedCandidate.sandboxHandleBindingDigest,
    authorityBundleRevision:
      refreshedFreshRead.commonPreconditions.authorityBundleRevision,
    authorityBundleDigest:
      refreshedFreshRead.commonPreconditions.authorityBundleDigest,
    networkPolicy: {
      version: 1,
      mode: "Disabled",
      destinations: [],
    },
  });
  expect(freshDecision).toMatchObject({
    profile_id: preDriftCandidate.profile,
    provider_id: preDriftCandidate.providerId,
  });
  expect(refreshedCandidate).toMatchObject({
    providerVersion: effectiveSnapshot.providerVersion,
    capabilityRevision: effectiveSnapshot.capabilityRevision,
    profile: effectiveSnapshot.profile,
    networkMode: "Disabled",
    providerRegistryRevision: effectiveSnapshot.providerRegistryRevision,
    providerRegistryDigest: effectiveSnapshot.providerRegistryDigest,
    sandboxHandleBindingDigest: effectiveSnapshot.sandboxHandleBindingDigest,
  });
  expect(refreshedFreshRead.commonPreconditions).toMatchObject({
    authorityBundleRevision: effectiveSnapshot.authorityBundleRevision,
    authorityBundleDigest: effectiveSnapshot.authorityBundleDigest,
  });
  expect(s.providerCalls).toBe(providerCallsBeforeFreshRoot + 1);
  expect(fixture.daemonErrors).toEqual([]);
};
