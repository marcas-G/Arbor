import type {
  SandboxMountBinding,
  SandboxProcessPolicy,
  ToolObservationEvidence,
} from "@arbor/ports";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  authority,
  executionId,
  invocationId,
  p39ApprovedCase,
  processContext,
  processEpisode,
  processExecutor,
  processPolicy,
  sandboxCapability,
  workspaceId,
} from "./support.js";
import { app, run } from "./support-app.js";
import type { PipelineTrace } from "./support-harness.js";

describe("P4 tool runtime pipeline", () => {
  it("parks an unexpired process policy from an earlier Workspace authorization before effect admission", async () => {
    const p39Case = p39ApprovedCase(
      "c7",
      "action-p4-stale-workspace-authorization",
    );
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
    const policy = {
      ...processPolicy(processEpisode),
      workspaceAuthorizationRevision: 1,
    };
    let refreshes = 0;
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
      {
        ...p39Case.approvedContext,
        executionEpisodeBinding: processEpisode,
        authority: {
          ...authority,
          ...p39Case.approvedContext.authority,
          workspaceSandboxSources: [
            {
              workspaceId,
              parentWorkspaceId: null,
              lifecycle: "Active",
              resourceBoundaryRevision: 0,
              workspacePolicyRevision: 0,
              authorizationRevision: 2,
            },
          ],
        },
        sandboxProcessPolicy: policy,
        resolveSandboxProcessPolicy: () => {
          refreshes++;
          return Effect.succeed({ policy, mounts: [] });
        },
      },
    );
    expect(result._tag).toBe("SandboxPolicyRequiredInterruption");
    expect(refreshes).toBe(1);
    expect(trace.intentWrites).toBe(1);
    expect(trace.effectAdmissions).toBe(0);
    expect(trace.sandboxProcessPortRuns ?? 0).toBe(0);
    expect(trace.settlementWrites ?? 0).toBe(0);
  });

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
    const mismatchedEpisode = {
      ...processEpisode,
      entryKey: "different-entry",
    } as typeof processEpisode;
    const result = await run(
      app(false, processExecutor, {}, trace),
      '{"target":{"mount":"workspace","path":"."}}',
      null,
      processContext(policy, mismatchedEpisode),
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
              ? { qualificationEvidenceRef: `blob:sha256:${"c".repeat(64)}` }
              : {}),
            ...(caseName === "provider-rule-digest-mismatch"
              ? { enforcementRuleSetDigest: "c".repeat(64) }
              : {}),
          },
        ],
      };
      const policy = processPolicy(processEpisode);
      const selectedPolicy: Extract<
        SandboxProcessPolicy,
        { readonly kind: "OsEnforcedProcessPolicy" }
      > =
        caseName === "missing-policy-evidence"
          ? ({
              ...policy,
              qualificationEvidenceRef: undefined,
            } as unknown as typeof policy)
          : caseName === "missing-policy-rule-digest"
            ? ({
                ...policy,
                enforcementRuleSetDigest: undefined,
              } as unknown as typeof policy)
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
});
