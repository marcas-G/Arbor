import { createHash } from "node:crypto";
import {
  ExecutionId,
  parse,
  providerTurnInferenceId,
} from "@arbor/domain";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { makeExecutableToolHandler } from "../src/executable-tool-handler.js";

const invocation = {
  providerTurnId: providerTurnInferenceId(
    parse(ExecutionId)("exe_018f2b3c-4d5e-7abc-8def-0123456789a1"),
    0,
  ),
  outputPosition: 0,
  callRef: "same-provider-call-ref",
  toolName: "read",
  argumentsJson: "{}",
};

const executionFor = (executionId: string) =>
  ({
    executionId: executionId as ExecutionId,
    projectId: "prj_identity-test" as never,
    workspaceId: "ws_identity-test" as never,
    sessionId: "ses_identity-test" as never,
    binding: {
      _tag: "WorkspaceExecution",
      workspaceId: "ws_identity-test" as never,
      focus: { _tag: "Coordination" },
    },
    admittedAt: "2026-10-05T00:00:00.000Z",
    stopRequestedAt: null,
    state: { status: "Active", settlement: null },
  }) as never;

const episodeExecutionFor = (executionId: string, episode: never) => ({
  executionId: executionId as ExecutionId,
  projectId: "prj_identity-test" as never,
  workspaceId: "ws_identity-test" as never,
  sessionId: "ses_identity-test" as never,
  binding: {
    _tag: "WorkspaceExecution" as const,
    workspaceId: "ws_identity-test" as never,
    episode,
  },
  admittedAt: "2026-10-05T00:00:00.000Z",
  stopRequestedAt: null,
  state: { status: "Active" as const, settlement: null },
});

const contextFor = (executionId: string) =>
  ({
    _tag: "ExecutionOrigin",
    principal: "worker:identity-test" as never,
    executionId: executionId as ExecutionId,
    workerId: "worker:identity-test",
    workerIncarnationId: "incarnation:identity-test",
    fencingGeneration: 0 as never,
  }) as never;

describe("executable tool invocation identity scope", () => {
  it("separates executions that reuse a provider callRef and stabilizes retries within one execution", async () => {
    const observed: Array<{
      readonly executionId: string;
      readonly invocationId: string;
    }> = [];
    const handler = makeExecutableToolHandler(
      {
        invoke: (toolIntent, toolContext) => {
          observed.push({
            executionId: String(toolContext.executionId),
            invocationId: String(toolIntent.invocationId),
          });
          return Effect.succeed({
            _tag: "Success" as const,
            observation: { text: "ok", truncated: false },
            resultRef: null,
          });
        },
      },
      { now: () => Effect.succeed("2026-10-05T00:00:00.000Z") },
      {
        visibleRefs: () =>
          Effect.succeed([{ name: "read", version: "1", hash: "read-v1" }]),
        resolveForModel: () => Effect.die("unused"),
      },
    );

    const invokeFor = (executionId: string) =>
      Effect.runPromise(
        handler.handle({
          invocation,
          execution: executionFor(executionId),
          context: contextFor(executionId),
          controlBasis: {} as never,
        }),
      );

    await invokeFor("exe_identity_a");
    await invokeFor("exe_identity_b");
    await invokeFor("exe_identity_a");

    expect(observed).toHaveLength(3);
    expect(observed[0]?.executionId).toBe("exe_identity_a");
    expect(observed[1]?.executionId).toBe("exe_identity_b");
    expect(observed[2]?.executionId).toBe("exe_identity_a");
    expect(observed[0]?.invocationId).not.toBe(observed[1]?.invocationId);
    expect(observed[0]?.invocationId).toBe(observed[2]?.invocationId);
  });

  it("adopts only an exact pre-AH7 invocation from the same Execution", async () => {
    const legacyId = `tin_018f2b3c-4d5e-7abc-8def-${createHash("sha256")
      .update(invocation.callRef)
      .digest("hex")
      .slice(0, 12)}`;
    const ids: string[] = [];
    const handler = makeExecutableToolHandler(
      {
        invoke: (intent) => {
          ids.push(intent.invocationId);
          return Effect.succeed({
            _tag: "Success" as const,
            observation: { text: "ok", truncated: false },
            resultRef: null,
          });
        },
      },
      { now: () => Effect.succeed("2026-10-05T00:00:00.000Z") },
      {
        visibleRefs: () =>
          Effect.succeed([{ name: "read", version: "1", hash: "read-v1" }]),
        resolveForModel: () => Effect.die("unused"),
      },
      () =>
        Effect.succeed(
          Option.some({
            invocationId: legacyId as never,
            executionId: "exe_identity_a" as never,
            workspaceId: "ws_identity-test" as never,
            toolName: "read",
            toolVersion: "1",
            sideEffectSemantics: "ReadOnly",
            argumentsJson: invocation.argumentsJson,
            resolvedRegions: [],
            approvalId: null,
            effectAdmissionState: "LegacyUnknown",
            intentAt: "2026-10-04T00:00:00.000Z",
            settledAt: null,
            settlement: null,
            resultRef: null,
          }),
        ),
    );
    for (const id of ["exe_identity_a", "exe_identity_b"]) {
      await Effect.runPromise(
        handler.handle({
          invocation,
          execution: executionFor(id),
          context: contextFor(id),
          controlBasis: {} as never,
        }),
      );
    }
    expect(ids[0]).toBe(legacyId);
    expect(ids[1]).not.toBe(legacyId);
  });

  it("passes only the exact trusted P3 tuple and policy revisions into ToolRuntime", async () => {
    let observedContext:
      | import("@arbor/ports").ToolExecutionContext
      | undefined;
    const handler = makeExecutableToolHandler(
      {
        invoke: (_toolIntent, toolContext) => {
          observedContext = toolContext;
          return Effect.succeed({
            _tag: "Success" as const,
            observation: { text: "ok", truncated: false },
            resultRef: null,
          });
        },
      },
      { now: () => Effect.succeed("2026-10-05T00:00:00.000Z") },
      {
        visibleRefs: () =>
          Effect.succeed([{ name: "read", version: "1", hash: "read-v1" }]),
        resolveForModel: () => Effect.die("unused"),
      },
    );
    const trustedIdentity = {
      executionId: "exe_identity_a" as ExecutionId,
      providerTurnId: providerTurnInferenceId(
        parse(ExecutionId)("exe_018f2b3c-4d5e-7abc-8def-0123456789a2"),
        4,
      ),
      logicalStepNo: 4,
      repairAttempt: 1,
      logicalActionId: "action-persisted",
      actionIndex: 3,
      callRef: invocation.callRef,
    };
    const policyRevisions = {
      workspacePolicyRevision: 17,
      projectPolicyRevision: 29,
    };
    await Effect.runPromise(
      handler.handle({
        invocation,
        execution: executionFor("exe_identity_a"),
        context: contextFor("exe_identity_a"),
        controlBasis: {
          workspacePolicyRevision: 17,
          projectPolicyRevision: 29,
        } as never,
        recoveryBindingIdentity: trustedIdentity,
        recoveryBindingPolicyRevisions: policyRevisions,
      } as never),
    );
    expect(observedContext?.recoveryBindingIdentity).toBe(trustedIdentity);
    expect(observedContext?.recoveryBindingPolicyRevisions).toBe(
      policyRevisions,
    );
  });

  it("does not reconstruct absent RecoveryBinding inputs from execution or model data", async () => {
    let observedContext:
      | import("@arbor/ports").ToolExecutionContext
      | undefined;
    const handler = makeExecutableToolHandler(
      {
        invoke: (_toolIntent, toolContext) => {
          observedContext = toolContext;
          return Effect.succeed({
            _tag: "Success" as const,
            observation: { text: "ok", truncated: false },
            resultRef: null,
          });
        },
      },
      { now: () => Effect.succeed("2026-10-05T00:00:00.000Z") },
      {
        visibleRefs: () =>
          Effect.succeed([{ name: "read", version: "1", hash: "read-v1" }]),
        resolveForModel: () => Effect.die("unused"),
      },
    );
    await Effect.runPromise(
      handler.handle({
        invocation,
        execution: executionFor("exe_identity_a"),
        context: contextFor("exe_identity_a"),
        controlBasis: {
          workspacePolicyRevision: 17,
          projectPolicyRevision: 29,
        } as never,
      }),
    );
    expect(observedContext?.recoveryBindingIdentity).toBeUndefined();
    expect(observedContext?.recoveryBindingPolicyRevisions).toBeUndefined();
  });

  it("injects the exact runtime-only current sandbox policy and full mount set for shell", async () => {
    let observedContext:
      | import("@arbor/ports").ToolExecutionContext
      | undefined;
    let observedResolution:
      | import("@arbor/ports").SandboxProcessPolicyResolution
      | undefined;
    const episode = {
      _tag: "WorkEpisode" as const,
      workId: "wrk_identity-test" as never,
      targetWorkRevision: 1 as never,
    };
    const execution = episodeExecutionFor(
      "exe_identity_policy",
      episode as never,
    );
    const policy = {
      kind: "TrustedLocalUnconfinedRuntimePolicy",
      executionId: "exe_identity_policy",
      episodeBinding: episode,
      sandboxHandleId: "sbx_exe_identity_policy",
      policyRevision: 3,
      profile: "FullAccess",
      providerId: "TrustedLocal",
      providerVersion: "builtin-v1",
      capabilityRevision: "builtin-v1",
      boundary: "TrustedLocal",
      trustedRuntimeIdentity: "TrustedLocal",
      trustedRuntimeVersion: "builtin-v1",
      networkBoundary: "Unconfined",
      policyDigest: "a".repeat(64),
      admittedMounts: [
        {
          ref: "workspace",
          rootPath: "C:/runtime/workspace",
          access: "ReadWrite",
        },
        {
          ref: "resource-2",
          rootPath: "C:/runtime/other",
          access: "ReadWrite",
        },
      ],
      environmentAllowlist: ["PATH"],
      limits: {
        wallTimeMs: 5000,
        stdoutBytes: 1024,
        stderrBytes: 1024,
        processCount: 1,
        memoryBytes: 1_000_000,
        cpuTimeMs: 5000,
      },
      auditRefs: ["cmd_exact_policy"],
    };
    const mounts = [
      {
        ref: "workspace",
        address: { _tag: "GitWorktree", path: "C:/runtime/workspace" },
        region: {
          resourceSpaceId: "filesystem",
          normalizedRegion: {
            kind: "GitWorktree",
            path: "C:/runtime/workspace",
          },
        },
        access: "ReadWrite",
      },
      {
        ref: "resource-2",
        address: { _tag: "FileTree", path: "C:/runtime/other" },
        region: {
          resourceSpaceId: "filesystem",
          normalizedRegion: { kind: "FileTree", path: "C:/runtime/other" },
        },
        access: "ReadWrite",
      },
    ];
    const handler = makeExecutableToolHandler(
      {
        invoke: (_toolIntent, toolContext) =>
          Effect.gen(function* () {
            observedContext = toolContext;
            if (toolContext.resolveSandboxProcessPolicy === undefined)
              throw new Error("lazy policy resolver was not provided");
            observedResolution = yield* toolContext.resolveSandboxProcessPolicy(
              {
                now: "2026-10-19T00:00:00.000Z",
              },
            );
            return {
              _tag: "Success" as const,
              observation: { text: "ok", truncated: false },
              resultRef: null,
            };
          }),
      },
      { now: () => Effect.succeed("2026-10-19T00:00:00.000Z") },
      {
        visibleRefs: () =>
          Effect.succeed([{ name: "shell", version: "1", hash: "shell-v1" }]),
        resolveForModel: () => Effect.die("unused"),
      },
      undefined,
      undefined,
      undefined,
      () => Effect.succeed({ policy, mounts } as never),
    );
    await Effect.runPromise(
      handler.handle({
        invocation: { ...invocation, toolName: "shell" },
        execution,
        context: contextFor("exe_identity_policy"),
        controlBasis: {} as never,
      } as never),
    );
    expect(observedContext?.executionEpisodeBinding).toEqual(episode);
    expect(observedContext?.sandboxProcessPolicy).toBeUndefined();
    expect(observedContext?.sandboxProcessMountBindings).toBeUndefined();
    expect(observedResolution?.policy).toBe(policy);
    expect(observedResolution?.mounts).toBe(mounts);
  });

  it("hands missing shell policy to ToolRuntime instead of parking before durable intent", async () => {
    let invocationCalls = 0;
    const handler = makeExecutableToolHandler(
      {
        invoke: () => {
          invocationCalls += 1;
          return Effect.succeed({
            _tag: "SandboxPolicyRequiredInterruption" as const,
          });
        },
      },
      { now: () => Effect.succeed("2026-10-19T00:00:00.000Z") },
      {
        visibleRefs: () =>
          Effect.succeed([{ name: "shell", version: "1", hash: "shell-v1" }]),
        resolveForModel: () => Effect.die("unused"),
      },
      undefined,
      undefined,
      undefined,
      () => Effect.succeed(undefined),
    );
    const execution = episodeExecutionFor("exe_identity_policy_missing", {
      _tag: "WorkEpisode",
      workId: "wrk_identity-test" as never,
      targetWorkRevision: 1 as never,
    } as never);
    const result = await Effect.runPromise(
      handler.handle({
        invocation: { ...invocation, toolName: "shell" },
        execution,
        context: contextFor("exe_identity_policy_missing"),
        controlBasis: {} as never,
      } as never),
    );
    expect(result._tag).toBe("SandboxPolicyRequiredInterruption");
    expect(invocationCalls).toBe(1);
  });

  it("fails closed before ToolRuntime when an active ExecutionOrigin lacks the lease holder triple", async () => {
    let invocationCalls = 0;
    const handler = makeExecutableToolHandler(
      {
        invoke: () => {
          invocationCalls += 1;
          return Effect.succeed({
            _tag: "Success" as const,
            observation: { text: "must not run", truncated: false },
            resultRef: null,
          });
        },
      },
      { now: () => Effect.succeed("2026-10-05T00:00:00.000Z") },
      {
        visibleRefs: () =>
          Effect.succeed([{ name: "read", version: "1", hash: "read-v1" }]),
        resolveForModel: () => Effect.die("unused"),
      },
    );
    const error = await Effect.runPromise(
      Effect.flip(
        handler.handle({
          invocation,
          execution: executionFor("exe_missing_execution_fence"),
          context: {
            _tag: "ExecutionOrigin",
            principal: "worker:identity-test" as never,
            executionId: "exe_missing_execution_fence" as never,
            fencingGeneration: 0 as never,
          } as never,
          controlBasis: {} as never,
        }),
      ),
    );
    expect(error).toMatchObject({
      _tag: "AgentActionOperationalFailure",
      operation: "ToolRuntime.LeaseFenceUnavailable",
    });
    expect(invocationCalls).toBe(0);
  });
});
