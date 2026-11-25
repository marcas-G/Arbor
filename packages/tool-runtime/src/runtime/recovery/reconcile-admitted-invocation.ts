import {
  reconciliationFactId,
  targetResourceIdentityDigestV1,
  validateToolReconciliationResult,
  executableApprovalBindingMatches,
  type ArtifactServiceService,
  type ClockService,
  type ExecutableApprovalStoreService,
  type P39RecoveryEvidenceStoreService,
  type RecoveryBindingV1,
  type ResourceAdmissionService,
  type ToolAuthorityResolverService,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolIntent,
  type ToolInvocationStoreService,
  type ToolObservationEvidenceStoreService,
  type ToolReconciliationFactStoreService,
  type ToolReconciliationPortService,
  type ToolReconciliationProfile,
  type ToolReconciliationRequest,
  type ToolReconciliationResult,
  type ToolRuntimeError,
  type TransactionPortService,
} from "@arbor/ports";
import { ArtifactId, parse } from "@arbor/domain";
import { Effect, Option } from "effect";
import { matchApproval } from "../../approval.js";
import { checkInvocationAuthority } from "../../authority.js";
import {
  bounded,
  isLeaseFencingRejected,
  isP39ResourceResolutionStale,
  operationalFailure,
  reconciliationRetryDenialReasonCode,
} from "../errors.js";
import type { ReconciliationProbe, ResourceCapture } from "../phase-contracts.js";
import type { PendingReconciliation, ToolExecutionResult, ToolExecutor } from "../types.js";

/** Reconcile one admitted external effect. Fact recording and retry admission remain atomic. */
export const reconcileAdmittedInvocation = (
  intent: ToolIntent,
  context: ToolExecutionContext,
  definition: ToolDefinition,
  executor: ToolExecutor,
  resources: ResourceCapture,
  needsApproval: boolean,
  trustedProfile: ToolReconciliationProfile | undefined,
  trustedEffectKey: string | null,
  replayBindingValue: RecoveryBindingV1 | undefined,
  replayBindingSha256: string | undefined,
  tx: TransactionPortService,
  clock: ClockService,
  store: ToolInvocationStoreService,
  admission: ResourceAdmissionService,
  p39Recovery: Option.Option<P39RecoveryEvidenceStoreService>,
  reconciliationPort: Option.Option<ToolReconciliationPortService>,
  reconciliationFacts: Option.Option<ToolReconciliationFactStoreService>,
  observationEvidence: Option.Option<ToolObservationEvidenceStoreService>,
  artifactService: Option.Option<ArtifactServiceService>,
  authorityResolver: Option.Option<ToolAuthorityResolverService>,
  executableApprovals: Option.Option<ExecutableApprovalStoreService>,
  options: { readonly maxDelegationDepth?: number },
  probeReconciliation: ReconciliationProbe,
) =>
  Effect.gen(function* () {
    const { regions, boundaryRegions, capturedWorkspace, resolved, validateCapturedSnapshot } = resources;
    let recoveredToolOutcome: ToolExecutionResult | undefined;
    let pendingReconciliation: PendingReconciliation | undefined;
    let retryAdmitted = false;
    if (
      trustedProfile === undefined ||
      replayBindingValue === undefined ||
      replayBindingSha256 === undefined ||
      !Option.isSome(p39Recovery) ||
      !Option.isSome(reconciliationPort) ||
      !Option.isSome(reconciliationFacts) ||
      !Option.isSome(observationEvidence)
    ) {
      return {
        _tag: "Terminal" as const,
        observation: {
          _tag: "OutcomeUnknown" as const,
          reconciliationRefs: [String(intent.invocationId)],
        },
      };
    }
    const latestAttempt = yield* tx
      .transact(
        Effect.gen(function* () {
          yield* observationEvidence.value.assertCurrentFence(
            context.executionFence,
            yield* clock.now(),
          );
          return yield* p39Recovery.value.findLatestAttempt(
            intent.invocationId,
          );
        }),
      )
      .pipe(
        Effect.mapError(
          operationalFailure(
            "RecoveryBinding",
            String(intent.invocationId),
          ),
        ),
      );
    if (Option.isNone(latestAttempt)) {
      return {
        _tag: "Terminal" as const,
        observation: {
          _tag: "OutcomeUnknown" as const,
          reconciliationRefs: [String(intent.invocationId)],
        },
      };
    }
    const attempt = latestAttempt.value;
    if (
      attempt.admissionState !== "MayHaveStarted" ||
      attempt.bindingSha256 !== replayBindingSha256 ||
      attempt.profileId !== trustedProfile.profileId ||
      attempt.profileVersion !== trustedProfile.profileVersion ||
      attempt.profileHash !== trustedProfile.profileHash ||
      attempt.profileProtocol !== trustedProfile.profileProtocol ||
      attempt.effectKey === null ||
      trustedEffectKey === null ||
      attempt.effectKey !== trustedEffectKey
    ) {
      return {
        _tag: "Terminal" as const,
        observation: {
          _tag: "OutcomeUnknown" as const,
          reconciliationRefs: [String(intent.invocationId)],
        },
      };
    }
    const request: ToolReconciliationRequest = {
      invocationId: intent.invocationId,
      attemptNo: attempt.attemptNo,
      bindingSha256: replayBindingSha256,
      profileHash: trustedProfile.profileHash,
      effectKey: attempt.effectKey,
      visibilityScopeSha256:
        replayBindingValue.targetResourceIdentityDigest,
    };
    yield* tx
      .transact(
        observationEvidence.value.assertCurrentFence(
          context.executionFence,
          yield* clock.now(),
        ),
      )
      .pipe(
        Effect.mapError(
          operationalFailure(
            "RecoveryBinding",
            String(intent.invocationId),
          ),
        ),
      );
    const portResult = yield* Effect.match(
      reconciliationPort.value.reconcile(request),
      {
        onFailure: () => ({
          _tag: "StillUnknown" as const,
          reasonCode: "ExternalSourceUnavailable" as const,
          evidenceRef: null,
        }),
        onSuccess: (value) =>
          validateToolReconciliationResult(request, value)
            ? value
            : {
                _tag: "StillUnknown" as const,
                reasonCode: "EvidenceBindingMismatch" as const,
                evidenceRef: null,
              },
      },
    );
    const persistUnknownFact = (
      result: Extract<
        ToolReconciliationResult,
        { readonly _tag: "StillUnknown" }
      >,
      observedAt: string,
    ) =>
      tx.transact(
        Effect.gen(function* () {
          const fenceNow = yield* clock.now();
          yield* observationEvidence.value.assertCurrentFence(
            context.executionFence,
            fenceNow,
          );
          yield* probeReconciliation(
            "AH7BeforeReconciliationFactCommit",
            {
              attemptNo: request.attemptNo,
              outcomeTag: result._tag,
            },
          );
          yield* reconciliationFacts.value.record(
            request,
            result,
            observedAt,
          );
        }),
      );
    if (portResult._tag === "StillUnknown") {
      const observedAt = yield* clock.now();
      yield* persistUnknownFact(portResult, observedAt).pipe(
        Effect.mapError(
          operationalFailure(
            "SettlementJournal",
            String(intent.invocationId),
          ),
        ),
      );
      yield* probeReconciliation("AH7AfterReconciliationFactCommit", {
        attemptNo: request.attemptNo,
        outcomeTag: portResult._tag,
      });
      return {
        _tag: "Terminal" as const,
        observation: {
          _tag: "OutcomeUnknown" as const,
          reconciliationRefs: [String(intent.invocationId)],
        },
      };
    }
    const observedAt = portResult.proof.observedAt;
    const factId = reconciliationFactId({
      request,
      result: portResult,
      factDisposition: "RecoveryInput",
      evidenceSha256: portResult.proof.evidenceSha256,
    });
    if (portResult._tag === "NotOccurred") {
      if (attempt.attemptNo === 0) {
        const retryGate = yield* tx
          .transact(
            Effect.gen(function* () {
              const gateNow = yield* clock.now();
              yield* observationEvidence.value.assertCurrentFence(
                context.executionFence,
                gateNow,
              );
              yield* probeReconciliation(
                "AH7BeforeReconciliationFactCommit",
                {
                  attemptNo: request.attemptNo,
                  outcomeTag: portResult._tag,
                  factId,
                },
              );
              const fact = yield* reconciliationFacts.value.record(
                request,
                portResult,
                observedAt,
              );
              if (fact.factId !== factId) {
                return yield* Effect.fail({
                  _tag: "P39ReconciliationFactIdentityMismatch",
                });
              }

              const snapshotAdmission = yield* Effect.match(
                Effect.gen(function* () {
                  yield* validateCapturedSnapshot();
                  if (
                    replayBindingValue === undefined ||
                    targetResourceIdentityDigestV1(regions) !==
                      replayBindingValue.targetResourceIdentityDigest ||
                    capturedWorkspace.resourceBoundaryRevision !==
                      replayBindingValue.resourceBoundaryRevision ||
                    resolved.observedEnvironmentRevision !==
                      replayBindingValue.environmentRevision
                  ) {
                    return {
                      _tag: "Denied" as const,
                      reason: "RecoveryBindingSnapshotChanged",
                    };
                  }
                  return yield* admission.admit({
                    workspaceId: context.workspaceId,
                    regions,
                    resolvedBoundaryRegions: boundaryRegions,
                    write: executor.write,
                  });
                }),
                {
                  onFailure: (cause) =>
                    isP39ResourceResolutionStale(cause)
                      ? { _tag: "ResourceSnapshotChanged" as const }
                      : { _tag: "Failure" as const, cause },
                  onSuccess: (value) =>
                    value._tag === "Denied"
                      ? { _tag: "ResourceSnapshotChanged" as const }
                      : { _tag: "Admitted" as const },
                },
              );
              if (snapshotAdmission._tag === "Failure") {
                return yield* Effect.fail(
                  operationalFailure(
                    "ResourceAdmission",
                    String(intent.invocationId),
                  )(snapshotAdmission.cause),
                );
              }
              if (snapshotAdmission._tag !== "Admitted") {
                return snapshotAdmission;
              }

              const currentAuthority = Option.isSome(
                authorityResolver,
              )
                ? yield* authorityResolver.value
                    .resolve({
                      intent,
                      definition,
                      context,
                      regions,
                      now: gateNow,
                    })
                    .pipe(
                      Effect.catchTag("ToolAuthorityDenied", () =>
                        Effect.succeed(undefined),
                      ),
                      Effect.mapError(
                        operationalFailure(
                          "AuthorityResolution",
                          String(intent.invocationId),
                        ),
                      ),
                    )
                : context.authority;
              if (
                currentAuthority === undefined ||
                checkInvocationAuthority({
                  authority: currentAuthority,
                  definition,
                  intent,
                  context,
                  regions,
                  now: gateNow,
                  maxDelegationDepth: options.maxDelegationDepth ?? 1,
                })._tag === "Denied"
              ) {
                return {
                  _tag: "AuthoritySnapshotChanged" as const,
                };
              }

              if (
                needsApproval &&
                intent.approvalId !== null &&
                context.executableApproval !== undefined
              ) {
                if (Option.isNone(executableApprovals)) {
                  return {
                    _tag: "ApprovalNoLongerAuthorized" as const,
                  };
                }
                const currentApproval =
                  yield* executableApprovals.value
                    .findById(context.executableApproval.approvalId)
                    .pipe(
                      Effect.mapError(
                        operationalFailure(
                          "ApprovalLookup",
                          String(intent.invocationId),
                        ),
                      ),
                    );
                if (
                  Option.isNone(currentApproval) ||
                  currentApproval.value.state !== "Consumed" ||
                  currentApproval.value.consumedBy !==
                    intent.invocationId ||
                  currentApproval.value.revision !==
                    context.executableApproval.expectedRevision + 1 ||
                  currentApproval.value.expiresAt <= gateNow ||
                  !executableApprovalBindingMatches(
                    currentApproval.value,
                    context.executableApproval.binding,
                  )
                ) {
                  return {
                    _tag: "ApprovalNoLongerAuthorized" as const,
                  };
                }
              } else if (
                needsApproval &&
                intent.approvalId !== null &&
                context.executableApproval === undefined
              ) {
                const approval = yield* store
                  .findApproval(intent.approvalId)
                  .pipe(
                    Effect.mapError(
                      operationalFailure(
                        "ApprovalLookup",
                        String(intent.invocationId),
                      ),
                    ),
                  );
                if (
                  Option.isNone(approval) ||
                  matchApproval({
                    approval: approval.value,
                    intent,
                    definition,
                    context,
                    regions,
                    now: gateNow,
                    replayOfRecordedInvocation: true,
                  })._tag === "Denied"
                ) {
                  return {
                    _tag: "ApprovalNoLongerAuthorized" as const,
                  };
                }
              }

              const admitted = yield* store.admitEffect(
                intent.invocationId,
                currentAuthority,
                gateNow,
                context.executionFence,
              );
              if (admitted._tag === "ExecutionStopping") {
                return admitted;
              }
              if (admitted._tag === "Denied") {
                return {
                  _tag: reconciliationRetryDenialReasonCode(
                    admitted.reasonCode,
                  ),
                };
              }
              yield* p39Recovery.value.admitRetryAttempt({
                invocationId: intent.invocationId,
                factId,
                admittedAt: gateNow,
              });
              return { _tag: "Admitted" as const };
            }),
          )
          .pipe(
            Effect.tapError((cause) =>
              isLeaseFencingRejected(cause)
                ? probeReconciliation(
                    "AH7ReconciliationResultFenceRejected",
                    {
                      attemptNo: request.attemptNo,
                      outcomeTag: portResult._tag,
                      factId,
                    },
                  ).pipe(Effect.catchCause(() => Effect.void))
                : Effect.void,
            ),
            Effect.mapError(
              operationalFailure(
                "RecoveryBinding",
                String(intent.invocationId),
              ),
            ),
          );
        yield* probeReconciliation(
          "AH7AfterReconciliationFactCommit",
          {
            attemptNo: request.attemptNo,
            outcomeTag: portResult._tag,
            factId,
          },
        );
        if (retryGate._tag === "Admitted") {
          retryAdmitted = true;
        } else {
          recoveredToolOutcome = {
            settlement: {
              _tag: "ReconciledNoEffect",
              reasonCode:
                retryGate._tag === "ExecutionStopping"
                  ? "StopRequested"
                  : retryGate._tag,
              reconciliationFactRef: factId,
            },
            observation: bounded(
              "authoritative source confirmed that the effect attempt did not occur",
            ),
            resultRef: null,
          };
          pendingReconciliation = {
            request,
            result: portResult,
            observedAt,
            selection: { attemptNo: attempt.attemptNo, factId },
          };
        }
      } else {
        const fact = yield* tx
          .transact(
            Effect.gen(function* () {
              yield* observationEvidence.value.assertCurrentFence(
                context.executionFence,
                yield* clock.now(),
              );
              yield* probeReconciliation(
                "AH7BeforeReconciliationFactCommit",
                {
                  attemptNo: request.attemptNo,
                  outcomeTag: portResult._tag,
                  factId,
                },
              );
              return yield* reconciliationFacts.value.record(
                request,
                portResult,
                observedAt,
              );
            }),
          )
          .pipe(
            Effect.mapError(
              operationalFailure(
                "SettlementJournal",
                String(intent.invocationId),
              ),
            ),
          );
        yield* probeReconciliation(
          "AH7AfterReconciliationFactCommit",
          {
            attemptNo: request.attemptNo,
            outcomeTag: portResult._tag,
            factId,
          },
        );
        if (fact.factId !== factId) {
          return yield* Effect.fail<ToolRuntimeError>(
            operationalFailure(
              "SettlementJournal",
              String(intent.invocationId),
            )({ _tag: "P39ReconciliationFactIdentityMismatch" }),
          );
        }
        recoveredToolOutcome = {
          settlement: {
            _tag: "ReconciledNoEffect",
            reasonCode: "ReplayLimitReached",
            reconciliationFactRef: factId,
          },
          observation: bounded(
            "authoritative source confirmed that the single retry did not occur",
          ),
          resultRef: null,
        };
        pendingReconciliation = {
          request,
          result: portResult,
          observedAt,
          selection: { attemptNo: attempt.attemptNo, factId },
        };
      }
    } else {
      let resultBytes: Uint8Array | undefined;
      if (Option.isSome(artifactService)) {
        try {
          const resultArtifactId = parse(ArtifactId)(
            portResult.resultRef,
          );
          const loaded = yield* tx
            .transact(artifactService.value.load(resultArtifactId))
            .pipe(
              Effect.mapError(
                operationalFailure(
                  "SettlementJournal",
                  String(intent.invocationId),
                ),
              ),
            );
          if (Option.isSome(loaded)) resultBytes = loaded.value;
        } catch {
          resultBytes = undefined;
        }
      }
      const reconstructed =
        resultBytes === undefined
          ? null
          : trustedProfile.reconstructOccurred({
              bytes: resultBytes,
              settlement: portResult.settlement,
            });
      if (
        reconstructed === null ||
        reconstructed.settlement !== portResult.settlement
      ) {
        const unknown = {
          _tag: "StillUnknown" as const,
          reasonCode: "ResultEvidenceUnavailable" as const,
          evidenceRef: portResult.proof.evidenceRef,
        };
        const unknownAt = yield* clock.now();
        yield* persistUnknownFact(unknown, unknownAt).pipe(
          Effect.mapError(
            operationalFailure(
              "SettlementJournal",
              String(intent.invocationId),
            ),
          ),
        );
        return {
          _tag: "Terminal" as const,
          observation: {
            _tag: "OutcomeUnknown" as const,
            reconciliationRefs: [String(intent.invocationId)],
          },
        };
      }
      recoveredToolOutcome = {
        settlement:
          portResult.settlement === "Success"
            ? { _tag: "Success" }
            : { _tag: "ExpectedFailure" },
        observation: reconstructed.observation,
        resultRef:
          portResult.settlement === "Success"
            ? portResult.resultRef
            : null,
      };
      const fact = yield* tx
        .transact(
          Effect.gen(function* () {
            yield* observationEvidence.value.assertCurrentFence(
              context.executionFence,
              yield* clock.now(),
            );
            yield* probeReconciliation(
              "AH7BeforeReconciliationFactCommit",
              {
                attemptNo: request.attemptNo,
                outcomeTag: portResult._tag,
                factId,
              },
            );
            return yield* reconciliationFacts.value.record(
              request,
              portResult,
              observedAt,
            );
          }),
        )
        .pipe(
          Effect.mapError(
            operationalFailure(
              "SettlementJournal",
              String(intent.invocationId),
            ),
          ),
        );
      yield* probeReconciliation("AH7AfterReconciliationFactCommit", {
        attemptNo: request.attemptNo,
        outcomeTag: portResult._tag,
        factId,
      });
      if (fact.factId !== factId) {
        return yield* Effect.fail<ToolRuntimeError>(
          operationalFailure(
            "SettlementJournal",
            String(intent.invocationId),
          )({ _tag: "P39ReconciliationFactIdentityMismatch" }),
        );
      }
      pendingReconciliation = {
        request,
        result: portResult,
        observedAt,
        selection: { attemptNo: attempt.attemptNo, factId },
      };
    }
    return {
      _tag: "Ready" as const,
      recoveredToolOutcome,
      pendingReconciliation,
      retryAdmitted,
    };
  });
