import { ProviderTurnId, parse } from "@arbor/domain";
import {
  type ToolInvocationRecord,
  ToolRuntimePort,
  targetResourceIdentityDigestV1,
} from "@arbor/ports";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import type { ToolExecutor } from "../../src/index.js";
import {
  authority,
  context,
  executionId,
  expectWorkspaceSnapshotPhases,
  fixtureWorkspaceAddresses,
  intent,
  invocationId,
  okExecutor,
  p39ApprovedCase,
  workspaceId,
} from "./support.js";
import { app, run } from "./support-app.js";
import type { PipelineTrace } from "./support-harness.js";

describe("tool runtime pipeline", () => {
  it("fails closed when does not return authenticated selected evidence for RNO", async () => {
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

  it("fails a stale environment snapshot before intent, approval, admission, or effect writes", async () => {
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

  it("accepts a environment revision only when the current persisted revision exactly matches", async () => {
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

  it("accepts environment None only for observed revision zero and binds only the selected target region", async () => {
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

  it("refreshes exactly once after the first stale revision, then consumes the fresh snapshot", async () => {
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

  it("fails closed after the single allowed stale-snapshot refresh", async () => {
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
});
