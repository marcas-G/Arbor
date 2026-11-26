import { ArtifactId, parse } from "@arbor/domain";
import {
  reconciliationFactId,
  type SandboxMountBinding,
  type SandboxProcessPolicy,
  type ToolInvocationRecord,
  type ToolReconciliationProfile,
  type ToolReconciliationResult,
  ToolRuntimePort,
} from "@arbor/ports";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { ToolExecutor } from "../../src/index.js";
import {
  executionId,
  intent,
  invocationId,
  okExecutor,
  p39NotOccurredRetryCase,
  processEpisode,
  processExecutor,
  processPolicy,
  workspaceId,
} from "./support.js";
import { app, runShell } from "./support-app.js";
import type { PipelineTrace } from "./support-harness.js";

describe("P4 tool runtime pipeline", () => {
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
});
