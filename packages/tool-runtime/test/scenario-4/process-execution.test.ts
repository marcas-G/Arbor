import type { SandboxProcessPolicy } from "@arbor/ports";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { ToolExecutor } from "../../src/index.js";
import {
  executionId,
  fixtureWorkspaceAddresses,
  invocationId,
  processContext,
  processEpisode,
  processExecutor,
  processPolicy,
  projectId,
  sandboxCapability,
  workspaceId,
} from "./support.js";
import { app, run } from "./support-app.js";
import type { PipelineTrace } from "./support-harness.js";

describe("tool runtime pipeline", () => {
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

  it("rejects a newly received process action before writing intent when Disabled", async () => {
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
      processExecutionMode: "Disabled",
      sandboxCapabilities: [
        sandboxCapability("bwrap", "Supported", "0.8.0"),
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
      _tag: "Denied",
      reasonCode: "ProcessExecutionDisabled",
      reason:
        "Process execution is disabled for this daemon; the action was not started.",
    });
    expect(trace.sandboxProcessPortRuns ?? 0).toBe(0);
    expect(trace.trustedLocalProcessRuns ?? 0).toBe(0);
    expect(trace.intentWrites).toBe(0);
    expect(trace.effectAdmissions).toBe(0);
    expect(trace.settlementWrites ?? 0).toBe(0);
  });

  it("rejects a newly received process action when Native mode has no qualified tuple", async () => {
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
      processExecutionMode: "NativeOsSupportedOnly",
      nativeOsSupportedTupleAvailable: false,
    };
    const result = await run(
      app(false, processExecutor, {}, trace),
      '{"target":{"mount":"workspace","path":"."}}',
      null,
      processContext(processPolicy(processEpisode)),
    );
    expect(result).toMatchObject({
      _tag: "Denied",
      reasonCode: "NativeOsTupleUnavailable",
      reason:
        "No qualified Native OS process tuple is available; the action was not started.",
    });
    expect(trace.intentWrites).toBe(0);
    expect(trace.effectAdmissions).toBe(0);
    expect(trace.sandboxProcessPortRuns ?? 0).toBe(0);
    expect(trace.trustedLocalProcessRuns ?? 0).toBe(0);
  });

  it.each([
    {
      processExecutionMode: "Disabled" as const,
      nativeOsSupportedTupleAvailable: true,
      reasonCode: "ProcessExecutionDisabled" as const,
    },
    {
      processExecutionMode: "NativeOsSupportedOnly" as const,
      nativeOsSupportedTupleAvailable: false,
      reasonCode: "NativeOsTupleUnavailable" as const,
    },
  ])(
    "terminalizes an already durable NotAdmitted process action before effect admission ($reasonCode)",
    async ({
      processExecutionMode,
      nativeOsSupportedTupleAvailable,
      reasonCode,
    }) => {
      const trace: PipelineTrace = {
        noEffectDenials: [],
        events: [],
        approvalConsumer: null,
        intentWrites: 0,
        effectAdmissions: 0,
        approvalConsumes: 0,
        processExecutionMode,
        nativeOsSupportedTupleAvailable,
        persistSandboxInvocations: true,
        sandboxCapabilities: [
          sandboxCapability("bwrap", "Supported", "0.8.0"),
          sandboxCapability("TrustedLocal", "Supported", "builtin-v1"),
        ],
        persistedSandboxInvocation: {
          invocationId,
          executionId,
          workspaceId,
          toolName: "read",
          toolVersion: "2",
          sideEffectSemantics: "ReadOnly",
          argumentsJson: '{"target":{"mount":"workspace","path":"."}}',
          resolvedRegions: [
            {
              resourceSpaceId: "filesystem",
              normalizedRegion: fixtureWorkspaceAddresses[0],
            },
          ],
          approvalId: null,
          effectAdmissionState: "NotAdmitted",
          intentAt: "2026-01-01T00:00:00.000Z",
          settledAt: null,
          settlement: null,
          resultRef: null,
        },
      };
      const result = await run(
        app(false, processExecutor, {}, trace),
        '{"target":{"mount":"workspace","path":"."}}',
        null,
        processContext(processPolicy(processEpisode)),
      );
      expect(result).toMatchObject({
        _tag: "Denied",
        reasonCode,
      });
      expect(trace.sandboxProcessPortRuns ?? 0).toBe(0);
      expect(trace.trustedLocalProcessRuns ?? 0).toBe(0);
      expect(trace.intentWrites).toBe(0);
      expect(trace.effectAdmissions).toBe(0);
      expect(trace.settlementWrites).toBe(1);
      expect(trace.persistedSandboxInvocation?.settlement).toEqual({
        _tag: "Denied",
        reasonCode,
      });
      expect(trace.persistedSandboxInvocation?.effectAdmissionState).toBe(
        "NotAdmitted",
      );
      const replay = await run(
        app(false, processExecutor, {}, trace),
        '{"target":{"mount":"workspace","path":"."}}',
        null,
        processContext(processPolicy(processEpisode)),
      );
      expect(replay).toMatchObject({
        _tag: "Denied",
        reasonCode,
      });
      expect(trace.effectAdmissions).toBe(0);
      expect(trace.settlementWrites).toBe(1);
      expect(trace.persistedSandboxInvocation?.effectAdmissionState).toBe(
        "NotAdmitted",
      );
    },
  );

  it("does not use TrustedLocal as a Native mode fallback", async () => {
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
    expect(result).toMatchObject({
      _tag: "SandboxProviderUnavailable",
      failureCode: "NativeOsProviderRequired",
      providerId: "TrustedLocal",
    });
    expect(trace.trustedLocalProcessRuns ?? 0).toBe(0);
    expect(trace.sandboxProcessPortRuns ?? 0).toBe(0);
  });

  it("uses TrustedLocal only when the test harness explicitly injects it", async () => {
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
      processExecutionMode: "Disabled",
      nativeOsSupportedTupleAvailable: false,
      testOnlyAllowTrustedLocalProcessExecution: true,
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
});
