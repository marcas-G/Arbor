import {
  ArtifactService,
  canonicalizeRecoveryBindingV1,
  EnvironmentRevisionStore,
  ExecutableApprovalStore,
  type ExecutableApprovalStoreService,
  makeToolReconciliationProfileRegistry,
  type RecoveryBindingV1,
  RecoveryEvidenceStore,
  recoveryBindingV1Digest,
  ToolAuthorityResolver,
  type ToolInvocationIntent,
  type ToolInvocationRecord,
  type ToolObservationEvidence,
  type ToolObservationEvidenceCandidate,
  ToolObservationEvidenceStore,
  ToolReconciliationFactStore,
  ToolReconciliationPort,
  ToolReconciliationProfileRegistry,
  type ToolReconciliationRequest,
  type ToolReconciliationResult,
  verifyRecoveryBindingV1,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { type ToolExecutor, ToolRuntimeLive } from "../../src/index.js";
import { executionId, invocationId } from "./support.js";
import type {
  HarnessRetry,
  MutableState,
  PipelineTrace,
} from "./support-harness.js";

// biome-ignore lint/suspicious/noExplicitAny: test helper erases the app layer type
type AppLayer = Layer.Layer<any, any, never>;

export const evidenceDepsBuilder = (
  baseDeps: AppLayer,
  trace: PipelineTrace | undefined,
) => {
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
  return evidenceDeps;
};

export const authorityResolverLayerBuilder = (
  reconciliationRetry: HarnessRetry | undefined,
  authorityDenied: boolean,
  trace: PipelineTrace | undefined,
) => {
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
  return authorityResolverLayer;
};

export const executableApprovalDepsBuilder = (
  deps: AppLayer,
  s: MutableState,
  trace: PipelineTrace | undefined,
) => {
  const executableApprovalDeps =
    s.executableApproval.value === undefined
      ? deps
      : Layer.mergeAll(
          deps,
          Layer.succeed(ExecutableApprovalStore, {
            findById: () =>
              Effect.succeed(
                s.executableApproval.value === undefined
                  ? Option.none()
                  : Option.some(s.executableApproval.value),
              ),
            consumeApproved: (
              input: Parameters<
                ExecutableApprovalStoreService["consumeApproved"]
              >[0],
            ) => {
              if (
                s.executableApproval.value === undefined ||
                s.executableApproval.value.state !== "Approved" ||
                s.executableApproval.value.revision !==
                  input.expectedRevision ||
                input.consumedBy !== invocationId
              ) {
                return Effect.succeed(false);
              }
              const before = s.executableApproval.value;
              const consumedRevision = before.revision + 1;
              s.executableApproval.value = {
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
  return executableApprovalDeps;
};

export const p39DepsBuilder = (
  executableApprovalDeps: AppLayer,
  p39BindingEnabled: boolean,
  s: MutableState,
  trace: PipelineTrace | undefined,
  reconciliationRetry: HarnessRetry | undefined,
  p39CurrentEnvironmentRevision: string | undefined,
  p39DeniedReplay: ToolInvocationRecord | undefined,
) => {
  const p39Deps = !p39BindingEnabled
    ? executableApprovalDeps
    : Layer.mergeAll(
        executableApprovalDeps,
        Layer.succeed(EnvironmentRevisionStore, {
          current: () => {
            const value =
              trace?.currentEnvironmentRevisionValues?.[
                s.environmentRevisionReadIndex.value
              ];
            s.environmentRevisionReadIndex.value += 1;
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
        Layer.succeed(RecoveryEvidenceStore, {
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
  return p39Deps;
};

export const toolRuntimeBuilder = (
  executor: ToolExecutor,
  trace: PipelineTrace | undefined,
) => {
  const toolRuntime = ToolRuntimeLive([executor], {
    processExecutionMode:
      trace?.processExecutionMode ?? "NativeOsSupportedOnly",
    nativeOsSupportedTupleAvailable:
      trace?.nativeOsSupportedTupleAvailable ?? true,
    testOnlyAllowTrustedLocalProcessExecution:
      trace?.testOnlyAllowTrustedLocalProcessExecution ?? false,
    ...(trace === undefined
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
        }),
  });
  return toolRuntime;
};

export const reconciliationDepsBuilder = (
  p39Deps: AppLayer,
  reconciliationRetry: HarnessRetry | undefined,
  trace: PipelineTrace | undefined,
) => {
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
  return reconciliationDeps;
};

export const artifactDepsBuilder = (
  reconciliationRetry: HarnessRetry | undefined,
) => {
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
  return artifactDeps;
};
