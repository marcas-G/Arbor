import type { CanonicalResourceRegion, ResourceAddress } from "@arbor/domain";
import { ArtifactId, parse } from "@arbor/domain";
import {
  ArtifactService,
  type BoundedObservation,
  type CanonicalToolObservation,
  Clock,
  type ExecutableApprovalRecord,
  ExecutableApprovalStore,
  executableApprovalBindingMatches,
  type LeaseFencingRejected,
  type NoEffectDenialCode,
  ProjectEnvironmentPort,
  ResourceAdmission,
  type SandboxHandle,
  SandboxPort,
  ToolAuthorityResolver,
  type ToolDefinition,
  ToolDefinitionStore,
  type ToolExecutionContext,
  type ToolIntent,
  type ToolInvocationSettlement,
  ToolInvocationStore,
  type ToolRuntimeError,
  ToolRuntimePort,
  TransactionPort,
  WorkspaceRepository,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { actionDigestOf, matchApproval } from "./approval.js";
import { checkInvocationAuthority } from "./authority.js";
import { validateToolInput } from "./validation.js";

export interface ToolExecutionResult {
  readonly settlement: ToolInvocationSettlement;
  readonly observation: BoundedObservation;
  readonly resultRef: string | null;
}

export interface ToolExecutor {
  readonly name: string;
  readonly write: boolean;
  readonly requiresApproval: (intent: ToolIntent) => boolean;
  readonly execute: (input: {
    readonly intent: ToolIntent;
    readonly definition: ToolDefinition;
    readonly context: ToolExecutionContext;
    readonly sandbox: SandboxHandle;
    readonly regions: ReadonlyArray<CanonicalResourceRegion>;
  }) => Effect.Effect<ToolExecutionResult, ToolRuntimeError>;
}

export interface ToolRuntimeQualificationEvent {
  readonly boundary:
    | "AH7AfterToolIntentCommit"
    | "AH7BeforeEffectAdmission"
    | "AH7AfterEffectAdmissionCommit"
    | "AH7AfterToolEffectBeforeSettlement"
    | "AH7BeforeToolSettlementTransaction"
    | "AH7BeforeToolSettlementCommit"
    | "AH7AfterToolSettlementCommit"
    | "AH7ToolSettlementFenceRejected"
    | "AH7AfterEffectAuthorityResolvedBeforeAdmission";
  readonly executionId: string;
  readonly invocationId: string;
  readonly callRef: string;
}

export type ToolRuntimeQualificationProbe = (
  event: ToolRuntimeQualificationEvent,
) => Promise<void>;

const bounded = (text: string, limit = 2000): BoundedObservation => ({
  text: text.length > limit ? text.slice(0, limit) : text,
  truncated: text.length > limit,
});

const requestedMountRefs = (argumentsJson: string): ReadonlyArray<string> => {
  try {
    const parsed = JSON.parse(argumentsJson) as {
      target?: { readonly mount?: unknown };
      cwd?: { readonly mount?: unknown };
    };
    return [parsed.target?.mount, parsed.cwd?.mount].filter(
      (value): value is string => typeof value === "string",
    );
  } catch {
    return [];
  }
};

const legacyResourceArguments = (
  argumentsJson: string,
): ReadonlyArray<ResourceAddress> => {
  try {
    const parsed = JSON.parse(argumentsJson) as {
      path?: ResourceAddress;
      cwd?: ResourceAddress;
    };
    return [parsed.path, parsed.cwd].filter(
      (value): value is ResourceAddress => value !== undefined,
    );
  } catch {
    return [];
  }
};

type FilesystemAddress = Extract<
  ResourceAddress,
  { readonly _tag: "FileTree" | "GitWorktree" }
>;

const primaryFilesystemAddress = (
  addresses: ReadonlyArray<ResourceAddress>,
): FilesystemAddress | undefined => {
  const candidates = addresses.filter(
    (address): address is FilesystemAddress =>
      address._tag === "GitWorktree" || address._tag === "FileTree",
  );
  const paths = new Set(
    candidates.map((address) =>
      address.path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase(),
    ),
  );
  if (paths.size !== 1) return undefined;
  return (
    candidates.find((address) => address._tag === "GitWorktree") ??
    candidates[0]
  );
};

const denialReason = (reasonCode: NoEffectDenialCode): string => {
  switch (reasonCode) {
    case "InvocationAuthorityDenied":
      return "tool authority denied";
    case "ApprovalRequired":
      return "approval required";
    case "ApprovalRejected":
      return "approval rejected";
    case "ApprovalNotFound":
      return "approval not found";
    case "ApprovalMismatch":
      return "approval does not match this invocation";
    case "ApprovalExpired":
      return "approval expired";
    case "ApprovalConsumedByOtherInvocation":
      return "approval was consumed by another invocation";
    case "ResourceResolutionDenied":
      return "tool resource could not be resolved";
    case "ResourceAdmissionDenied":
      return "tool resource admission denied";
    case "ApprovalNoLongerAuthorized":
      return "approval is no longer authorized";
  }
};

/** Preserve an already-committed human Reject across later replay. Expiry is
 * a transition from Pending/Approved, never a reinterpretation of Rejected. */
export const executableApprovalTerminalDenial = (
  approval: Pick<ExecutableApprovalRecord, "state" | "expiresAt">,
  now: string,
): "ApprovalRejected" | "ApprovalExpired" | null => {
  if (approval.state === "Rejected") return "ApprovalRejected";
  if (approval.state === "Expired" || approval.expiresAt <= now) {
    return "ApprovalExpired";
  }
  return null;
};

const denied = (reasonCode: NoEffectDenialCode): CanonicalToolObservation => ({
  _tag: "Denied",
  reasonCode,
  reason: denialReason(reasonCode),
});

const approvalDenialCode = (reason: string): NoEffectDenialCode => {
  if (reason === "approval already consumed") {
    return "ApprovalConsumedByOtherInvocation";
  }
  if (reason === "approval expired") return "ApprovalExpired";
  return "ApprovalMismatch";
};

const isLeaseFencingRejected = (
  cause: unknown,
): cause is LeaseFencingRejected =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  cause._tag === "LeaseFencingRejected";

const hasCompleteExecutionFence = (fence: unknown): boolean => {
  if (typeof fence !== "object" || fence === null) return false;
  const value = fence as Record<string, unknown>;
  return (
    typeof value.executionId === "string" &&
    value.executionId.length > 0 &&
    typeof value.workerId === "string" &&
    value.workerId.length > 0 &&
    typeof value.workerIncarnationId === "string" &&
    value.workerIncarnationId.length > 0 &&
    typeof value.fencingGeneration === "number" &&
    Number.isInteger(value.fencingGeneration) &&
    value.fencingGeneration >= 0
  );
};

export const ToolRuntimeLive = (
  executors: ReadonlyArray<ToolExecutor>,
  options: {
    readonly maxDelegationDepth?: number;
    readonly now?: string;
    readonly qualificationProbe?: ToolRuntimeQualificationProbe;
  } = {},
): Layer.Layer<
  ToolRuntimePort,
  never,
  | ToolDefinitionStore
  | SandboxPort
  | ResourceAdmission
  | ToolInvocationStore
  | ProjectEnvironmentPort
  | TransactionPort
  | Clock
> =>
  Layer.effect(
    ToolRuntimePort,
    Effect.gen(function* () {
      const definitions = yield* ToolDefinitionStore;
      const sandbox = yield* SandboxPort;
      const admission = yield* ResourceAdmission;
      const store = yield* ToolInvocationStore;
      const executableApprovals = yield* Effect.serviceOption(
        ExecutableApprovalStore,
      );
      const tx = yield* TransactionPort;
      const clock = yield* Clock;
      const environment = yield* ProjectEnvironmentPort;
      const workspaces = yield* Effect.serviceOption(WorkspaceRepository);
      const authorityResolver = yield* Effect.serviceOption(
        ToolAuthorityResolver,
      );
      const artifactService = yield* Effect.serviceOption(ArtifactService);

      const operationalFailure =
        (
          stage: import("@arbor/ports").ToolRuntimeOperationalStage,
          invocationRef: string,
        ) =>
        (cause: unknown): ToolRuntimeError => ({
          _tag: "ToolRuntimeOperationalFailure",
          stage,
          effectDisposition:
            stage === "Executor" || stage === "SettlementJournal"
              ? "OutcomeUncertain"
              : "NotStarted",
          invocationRef,
          cause,
        });

      const invoke = (intent: ToolIntent, context: ToolExecutionContext) =>
        Effect.gen(function* () {
          if (!hasCompleteExecutionFence(context.executionFence)) {
            return yield* Effect.fail<ToolRuntimeError>(
              operationalFailure(
                "IntentJournal",
                String(intent.invocationId),
              )({ _tag: "ExecutionFenceUnavailable" }),
            );
          }
          const definitionOption = yield* definitions.definition(
            intent.toolName,
            intent.toolVersion,
          );
          if (Option.isNone(definitionOption)) {
            return denied("InvocationAuthorityDenied");
          }
          const definition = definitionOption.value;
          const executor = executors.find(
            (entry) => entry.name === intent.toolName,
          );
          if (executor === undefined) {
            return denied("InvocationAuthorityDenied");
          }

          const validation = validateToolInput(
            definition.inputSchemaJson,
            intent.argumentsJson,
          );
          if (validation._tag === "Invalid") {
            return {
              _tag: "ExpectedFailure" as const,
              observation: bounded(validation.reason),
            };
          }

          const now = options.now ?? (yield* clock.now());
          const recordNoEffectDenial = (
            sideEffectSemantics: ToolDefinition["sideEffectSemantics"],
            resolvedRegions: ReadonlyArray<CanonicalResourceRegion>,
            reasonCode: NoEffectDenialCode,
          ) =>
            Effect.gen(function* () {
              const settledAt = yield* clock.now();
              const current = yield* tx
                .transact(store.findById(intent.invocationId))
                .pipe(
                  Effect.mapError(
                    operationalFailure(
                      "IntentJournal",
                      String(intent.invocationId),
                    ),
                  ),
                );
              if (Option.isSome(current)) {
                const record = current.value;
                const exact =
                  record.executionId === context.executionId &&
                  record.workspaceId === context.workspaceId &&
                  record.toolName === intent.toolName &&
                  record.toolVersion === intent.toolVersion &&
                  record.sideEffectSemantics === sideEffectSemantics &&
                  record.argumentsJson === intent.argumentsJson &&
                  JSON.stringify(record.resolvedRegions) ===
                    JSON.stringify(resolvedRegions) &&
                  record.approvalId === intent.approvalId;
                if (exact && record.settlement !== null) {
                  if (record.settlement._tag === "Denied") {
                    return denied(record.settlement.reasonCode);
                  }
                  if (record.settlement._tag === "Interrupted") {
                    return { _tag: "Interrupted" as const };
                  }
                  if (
                    record.settlement._tag === "Success" &&
                    record.resultRef !== null &&
                    Option.isSome(artifactService)
                  ) {
                    let artifactId: ArtifactId;
                    try {
                      artifactId = parse(ArtifactId)(record.resultRef);
                    } catch {
                      return {
                        _tag: "OutcomeUnknown" as const,
                        reconciliationRefs: [String(intent.invocationId)],
                      };
                    }
                    const bytes = yield* tx
                      .transact(artifactService.value.load(artifactId))
                      .pipe(
                        Effect.mapError(
                          operationalFailure(
                            "SettlementJournal",
                            String(intent.invocationId),
                          ),
                        ),
                      );
                    if (Option.isSome(bytes)) {
                      return {
                        _tag: "Success" as const,
                        observation: bounded(
                          new TextDecoder().decode(bytes.value),
                        ),
                        resultRef: record.resultRef,
                      };
                    }
                  }
                  return {
                    _tag: "OutcomeUnknown" as const,
                    reconciliationRefs: [String(intent.invocationId)],
                  };
                }
                if (exact && record.effectAdmissionState !== "NotAdmitted") {
                  return {
                    _tag: "OutcomeUnknown" as const,
                    reconciliationRefs: [String(intent.invocationId)],
                  };
                }
              }
              const recorded = yield* tx
                .transact(
                  store.recordNoEffectDenial(
                    {
                      invocationId: intent.invocationId,
                      executionId: context.executionId,
                      workspaceId: context.workspaceId,
                      toolName: intent.toolName,
                      toolVersion: intent.toolVersion,
                      sideEffectSemantics,
                      argumentsJson: intent.argumentsJson,
                      resolvedRegions,
                      approvalId:
                        context.executableApproval?.approvalId ??
                        intent.approvalId,
                      intentAt: now,
                    },
                    reasonCode,
                    settledAt,
                    context.executionFence,
                    settledAt,
                  ),
                )
                .pipe(
                  Effect.mapError(
                    operationalFailure(
                      "IntentJournal",
                      String(intent.invocationId),
                    ),
                  ),
                );
              if (recorded === "ExecutionStopping") {
                const interrupted = yield* tx
                  .transact(
                    store.recordNoEffectInterruption(
                      intent.invocationId,
                      settledAt,
                      context.executionFence,
                      settledAt,
                    ),
                  )
                  .pipe(
                    Effect.mapError(
                      operationalFailure(
                        "IntentJournal",
                        String(intent.invocationId),
                      ),
                    ),
                  );
                if (!interrupted && Option.isSome(current)) {
                  return {
                    _tag: "OutcomeUnknown" as const,
                    reconciliationRefs: [String(intent.invocationId)],
                  };
                }
                return { _tag: "Interrupted" as const };
              }
              return denied(
                recorded.settlement?._tag === "Denied"
                  ? recorded.settlement.reasonCode
                  : reasonCode,
              );
            });
          const mountRefs = requestedMountRefs(intent.argumentsJson);
          let address: FilesystemAddress | undefined;
          let addresses: ReadonlyArray<ResourceAddress>;
          if (mountRefs.length > 0) {
            if (
              mountRefs.length !== 1 ||
              mountRefs.some((mount) => mount !== "workspace")
            ) {
              return yield* recordNoEffectDenial(
                definition.sideEffectSemantics,
                [],
                "ResourceResolutionDenied",
              );
            }
            if (Option.isNone(workspaces)) {
              return yield* recordNoEffectDenial(
                definition.sideEffectSemantics,
                [],
                "ResourceResolutionDenied",
              );
            }
            const workspace = yield* tx
              .transact(workspaces.value.findById(context.workspaceId))
              .pipe(
                Effect.mapError(
                  operationalFailure(
                    "WorkspaceLookup",
                    String(intent.invocationId),
                  ),
                ),
              );
            if (Option.isNone(workspace)) {
              return yield* recordNoEffectDenial(
                definition.sideEffectSemantics,
                [],
                "ResourceResolutionDenied",
              );
            }
            address = primaryFilesystemAddress(
              workspace.value.resourceBoundary.addresses,
            );
            if (address === undefined) {
              return yield* recordNoEffectDenial(
                definition.sideEffectSemantics,
                [],
                "ResourceResolutionDenied",
              );
            }
            addresses = [address];
          } else {
            addresses = legacyResourceArguments(intent.argumentsJson);
          }
          const resolved = yield* environment
            .resolve(context.projectId, addresses)
            .pipe(
              Effect.mapError(
                operationalFailure(
                  "EnvironmentResolution",
                  String(intent.invocationId),
                ),
              ),
            );
          const regions = resolved.regions;
          const region = regions[0];
          if (
            address !== undefined &&
            (region === undefined || regions.length !== 1)
          ) {
            return yield* recordNoEffectDenial(
              definition.sideEffectSemantics,
              [],
              "ResourceResolutionDenied",
            );
          }

          const resolvedAuthority = Option.isSome(authorityResolver)
            ? yield* authorityResolver.value
                .resolve({
                  intent,
                  definition,
                  context,
                  regions,
                  now,
                })
                .pipe(
                  Effect.mapError(
                    operationalFailure(
                      "AuthorityResolution",
                      String(intent.invocationId),
                    ),
                  ),
                )
            : context.authority;
          if (resolvedAuthority === undefined) {
            return yield* recordNoEffectDenial(
              definition.sideEffectSemantics,
              regions,
              "InvocationAuthorityDenied",
            );
          }
          const authority = checkInvocationAuthority({
            authority: resolvedAuthority,
            definition,
            intent,
            context,
            regions,
            now,
            maxDelegationDepth: options.maxDelegationDepth ?? 1,
          });
          if (authority._tag === "Denied") {
            return yield* recordNoEffectDenial(
              definition.sideEffectSemantics,
              regions,
              "InvocationAuthorityDenied",
            );
          }

          const needsApproval = executor.requiresApproval(intent);
          let approvalAlreadyConsumedBySelf = false;
          if (!needsApproval && context.executableApproval !== undefined) {
            return yield* recordNoEffectDenial(
              definition.sideEffectSemantics,
              regions,
              "ApprovalMismatch",
            );
          }
          if (needsApproval) {
            if (context.executableApproval === undefined) {
              const legacyApprovalId = intent.approvalId;
              if (legacyApprovalId === null) {
                return {
                  _tag: "ApprovalRequired" as const,
                  authority: resolvedAuthority,
                  targetResourceSpaceIds: regions.map(
                    (region) => region.resourceSpaceId,
                  ),
                  actionDigest: actionDigestOf(intent),
                  requestedCapabilities: definition.capabilityMetadata,
                  sideEffectSemantics: definition.sideEffectSemantics,
                  controlBasisDigest: context.controlBasisDigest,
                };
              }
              const legacyApproval = yield* tx
                .transact(store.findApproval(legacyApprovalId))
                .pipe(
                  Effect.mapError(
                    operationalFailure(
                      "ApprovalLookup",
                      String(intent.invocationId),
                    ),
                  ),
                );
              if (Option.isNone(legacyApproval)) {
                return yield* recordNoEffectDenial(
                  definition.sideEffectSemantics,
                  regions,
                  "ApprovalNotFound",
                );
              }
              if (legacyApproval.value.consumedBy === intent.invocationId) {
                const priorInvocation = yield* tx
                  .transact(store.findById(intent.invocationId))
                  .pipe(
                    Effect.mapError(
                      operationalFailure(
                        "ApprovalLookup",
                        String(intent.invocationId),
                      ),
                    ),
                  );
                if (Option.isNone(priorInvocation)) {
                  return yield* recordNoEffectDenial(
                    definition.sideEffectSemantics,
                    regions,
                    "ApprovalConsumedByOtherInvocation",
                  );
                }
                approvalAlreadyConsumedBySelf = true;
              }
              const matched = matchApproval({
                approval: legacyApproval.value,
                intent,
                definition,
                context,
                regions,
                now,
                replayOfRecordedInvocation: approvalAlreadyConsumedBySelf,
              });
              if (matched._tag === "Denied") {
                return yield* recordNoEffectDenial(
                  definition.sideEffectSemantics,
                  regions,
                  approvalDenialCode(matched.reason),
                );
              }
            } else {
              if (intent.approvalId !== context.executableApproval.approvalId) {
                return yield* recordNoEffectDenial(
                  definition.sideEffectSemantics,
                  regions,
                  "ApprovalMismatch",
                );
              }
              if (Option.isNone(executableApprovals)) {
                return yield* Effect.fail(
                  operationalFailure(
                    "ApprovalLookup",
                    String(intent.invocationId),
                  )({
                    _tag: "ExecutableApprovalStoreUnavailable",
                  }),
                );
              }
              const exactExecutableApproval = yield* tx
                .transact(
                  executableApprovals.value.findById(
                    context.executableApproval.approvalId,
                  ),
                )
                .pipe(
                  Effect.mapError(
                    operationalFailure(
                      "ApprovalLookup",
                      String(intent.invocationId),
                    ),
                  ),
                );
              if (Option.isSome(exactExecutableApproval)) {
                const currentApproval = exactExecutableApproval.value;
                if (currentApproval.state === "Pending") {
                  if (
                    context.executableApproval.state !== "Pending" ||
                    currentApproval.revision !==
                      context.executableApproval.expectedRevision ||
                    !executableApprovalBindingMatches(
                      currentApproval,
                      context.executableApproval.binding,
                    )
                  ) {
                    return yield* recordNoEffectDenial(
                      definition.sideEffectSemantics,
                      regions,
                      "ApprovalMismatch",
                    );
                  }
                  return {
                    _tag: "ApprovalRequired" as const,
                    authority: resolvedAuthority,
                    targetResourceSpaceIds: regions.map(
                      (region) => region.resourceSpaceId,
                    ),
                    actionDigest: actionDigestOf(intent),
                    requestedCapabilities: definition.capabilityMetadata,
                    sideEffectSemantics: definition.sideEffectSemantics,
                    controlBasisDigest: context.controlBasisDigest,
                  };
                }
                if (currentApproval.state === "Cancelled") {
                  return { _tag: "Interrupted" as const };
                }
                const terminalDenial = executableApprovalTerminalDenial(
                  currentApproval,
                  now,
                );
                if (terminalDenial !== null) {
                  return yield* recordNoEffectDenial(
                    definition.sideEffectSemantics,
                    regions,
                    terminalDenial,
                  );
                }
                if (
                  currentApproval.state === "Consumed" &&
                  currentApproval.consumedBy === intent.invocationId
                ) {
                  const priorInvocation = yield* tx
                    .transact(store.findById(intent.invocationId))
                    .pipe(
                      Effect.mapError(
                        operationalFailure(
                          "ApprovalLookup",
                          String(intent.invocationId),
                        ),
                      ),
                    );
                  if (Option.isSome(priorInvocation)) {
                    approvalAlreadyConsumedBySelf = true;
                  }
                }
              }
              if (
                Option.isNone(exactExecutableApproval) ||
                exactExecutableApproval.value.routeKind !== "Executable" ||
                (exactExecutableApproval.value.state !==
                  context.executableApproval.state &&
                  !approvalAlreadyConsumedBySelf) ||
                !(
                  (exactExecutableApproval.value.state === "Approved" &&
                    exactExecutableApproval.value.revision ===
                      context.executableApproval.expectedRevision) ||
                  (approvalAlreadyConsumedBySelf &&
                    exactExecutableApproval.value.state === "Consumed" &&
                    exactExecutableApproval.value.revision ===
                      context.executableApproval.expectedRevision + 1)
                ) ||
                exactExecutableApproval.value.expiresAt <= now ||
                !executableApprovalBindingMatches(
                  exactExecutableApproval.value,
                  context.executableApproval.binding,
                )
              ) {
                return yield* recordNoEffectDenial(
                  definition.sideEffectSemantics,
                  regions,
                  exactExecutableApproval._tag === "Some" &&
                    exactExecutableApproval.value.expiresAt <= now
                    ? "ApprovalExpired"
                    : "ApprovalMismatch",
                );
              }
              if (intent.approvalId !== context.executableApproval.approvalId) {
                return yield* recordNoEffectDenial(
                  definition.sideEffectSemantics,
                  regions,
                  "ApprovalMismatch",
                );
              }
            }
          }

          const admitted = yield* tx
            .transact(
              admission.admit({
                workspaceId: context.workspaceId,
                regions,
                write: executor.write,
              }),
            )
            .pipe(
              Effect.mapError(
                operationalFailure(
                  "ResourceAdmission",
                  String(intent.invocationId),
                ),
              ),
            );
          if (admitted._tag === "Denied") {
            return yield* recordNoEffectDenial(
              definition.sideEffectSemantics,
              regions,
              "ResourceAdmissionDenied",
            );
          }

          const prior = yield* tx
            .transact(store.findById(intent.invocationId))
            .pipe(
              Effect.mapError(
                operationalFailure(
                  "IntentJournal",
                  String(intent.invocationId),
                ),
              ),
            );
          if (Option.isSome(prior)) {
            const recorded = prior.value;
            const sameIntent =
              recorded.executionId === context.executionId &&
              recorded.workspaceId === context.workspaceId &&
              recorded.toolName === intent.toolName &&
              recorded.toolVersion === intent.toolVersion &&
              recorded.sideEffectSemantics === definition.sideEffectSemantics &&
              recorded.argumentsJson === intent.argumentsJson &&
              JSON.stringify(recorded.resolvedRegions) ===
                JSON.stringify(regions) &&
              recorded.approvalId === intent.approvalId;
            if (!sameIntent) {
              return yield* Effect.fail<ToolRuntimeError>(
                operationalFailure(
                  "IntentJournal",
                  String(intent.invocationId),
                )({
                  _tag: "ToolInvocationIdentityConflict",
                }),
              );
            }
            if (recorded.settlement !== null) {
              if (recorded.settlement._tag === "Denied") {
                return denied(recorded.settlement.reasonCode);
              }
              if (recorded.settlement._tag === "Interrupted") {
                return { _tag: "Interrupted" as const };
              }
              if (
                recorded.settlement._tag === "Success" &&
                recorded.resultRef !== null &&
                Option.isSome(artifactService)
              ) {
                let artifactId: ArtifactId;
                try {
                  artifactId = parse(ArtifactId)(recorded.resultRef);
                } catch {
                  return {
                    _tag: "OutcomeUnknown" as const,
                    reconciliationRefs: [String(intent.invocationId)],
                  };
                }
                const bytes = yield* tx
                  .transact(artifactService.value.load(artifactId))
                  .pipe(
                    Effect.mapError(
                      operationalFailure(
                        "SettlementJournal",
                        String(intent.invocationId),
                      ),
                    ),
                  );
                if (Option.isSome(bytes)) {
                  return {
                    _tag: "Success" as const,
                    observation: bounded(new TextDecoder().decode(bytes.value)),
                    resultRef: recorded.resultRef,
                  };
                }
              }
              return {
                _tag: "OutcomeUnknown" as const,
                reconciliationRefs: [String(intent.invocationId)],
              };
            }
            if (
              recorded.effectAdmissionState !== "NotAdmitted" &&
              (recorded.sideEffectSemantics === "NonIdempotent" ||
                recorded.sideEffectSemantics === "Reconcilable")
            ) {
              const reconciliationRefs = [String(intent.invocationId)];
              if (recorded.sideEffectSemantics === "NonIdempotent") {
                const settledAt = yield* clock.now();
                const unknownWrite = yield* Effect.match(
                  tx.transact(
                    Effect.gen(function* () {
                      const applied = yield* store.settle(
                        intent.invocationId,
                        { _tag: "OutcomeUnknown", reconciliationRefs },
                        null,
                        settledAt,
                        context.executionFence,
                        context.executionFence === undefined
                          ? undefined
                          : yield* clock.now(),
                      );
                      return {
                        applied,
                        current: applied
                          ? Option.none()
                          : yield* store.findById(intent.invocationId),
                      };
                    }),
                  ),
                  {
                    onFailure: (cause) => ({ ok: false as const, cause }),
                    onSuccess: (value) => ({ ok: true as const, value }),
                  },
                );
                if (!unknownWrite.ok) {
                  if (
                    isLeaseFencingRejected(unknownWrite.cause) &&
                    options.qualificationProbe !== undefined
                  ) {
                    yield* Effect.promise(
                      () =>
                        options.qualificationProbe?.({
                          boundary: "AH7ToolSettlementFenceRejected",
                          executionId: context.executionId,
                          invocationId: intent.invocationId,
                          callRef: intent.callRef,
                        }) ?? Promise.resolve(),
                    );
                  }
                  return yield* Effect.fail<ToolRuntimeError>(
                    isLeaseFencingRejected(unknownWrite.cause)
                      ? unknownWrite.cause
                      : operationalFailure(
                          "SettlementJournal",
                          String(intent.invocationId),
                        )(unknownWrite.cause),
                  );
                }
                if (!unknownWrite.value.applied) {
                  const canonical = unknownWrite.value.current;
                  if (
                    Option.isSome(canonical) &&
                    canonical.value.settlement?._tag === "OutcomeUnknown"
                  ) {
                    return {
                      _tag: "OutcomeUnknown" as const,
                      reconciliationRefs:
                        canonical.value.settlement.reconciliationRefs,
                    };
                  }
                }
              }
              return {
                _tag: "OutcomeUnknown" as const,
                reconciliationRefs,
              };
            }
            if (recorded.effectAdmissionState === "LegacyUnknown") {
              return {
                _tag: "OutcomeUnknown" as const,
                reconciliationRefs: [String(intent.invocationId)],
              };
            }
          } else {
            const invocation = {
              invocationId: intent.invocationId,
              executionId: context.executionId,
              workspaceId: context.workspaceId,
              toolName: intent.toolName,
              toolVersion: intent.toolVersion,
              sideEffectSemantics: definition.sideEffectSemantics,
              argumentsJson: intent.argumentsJson,
              resolvedRegions: regions,
              approvalId:
                context.executableApproval?.approvalId ?? intent.approvalId,
              intentAt: now,
            } as const;
            const claimStopped = { _tag: "AH7ClaimStopped" as const };
            const approvalClaimLost = { _tag: "AH7ApprovalClaimLost" as const };
            const claim = yield* Effect.match(
              tx.transact(
                Effect.gen(function* () {
                  const recordedIntent = yield* store.recordIntent(
                    invocation,
                    context.executionFence,
                    now,
                  );
                  if (recordedIntent === "ExecutionStopping") {
                    return "ExecutionStopping" as const;
                  }
                  if (
                    needsApproval &&
                    context.executableApproval !== undefined &&
                    Option.isSome(executableApprovals)
                  ) {
                    if (approvalAlreadyConsumedBySelf) {
                      return "Claimed" as const;
                    }
                    const consumed =
                      yield* executableApprovals.value.consumeApproved({
                        approvalId: context.executableApproval.approvalId,
                        expectedRevision:
                          context.executableApproval.expectedRevision,
                        consumedBy: intent.invocationId,
                        consumedAt: now,
                        binding: context.executableApproval.binding,
                        executionFence: context.executionFence,
                      });
                    if (consumed === "ExecutionStopping") {
                      return yield* Effect.fail(claimStopped);
                    }
                    if (!consumed) return yield* Effect.fail(approvalClaimLost);
                  } else if (
                    needsApproval &&
                    intent.approvalId !== null &&
                    !approvalAlreadyConsumedBySelf
                  ) {
                    const consumed = yield* store.consumeApproval(
                      intent.approvalId,
                      intent.invocationId,
                      context.executionFence,
                      now,
                    );
                    if (consumed === "ExecutionStopping") {
                      return yield* Effect.fail(claimStopped);
                    }
                    if (!consumed) {
                      return yield* Effect.fail(approvalClaimLost);
                    }
                  }
                  return "Claimed" as const;
                }),
              ),
              {
                onFailure: (cause) => ({ _tag: "Failed" as const, cause }),
                onSuccess: (value) => ({ _tag: "Succeeded" as const, value }),
              },
            );
            if (claim._tag === "Failed") {
              if (
                typeof claim.cause === "object" &&
                claim.cause !== null &&
                "_tag" in claim.cause &&
                claim.cause._tag === "AH7ApprovalClaimLost"
              ) {
                return yield* recordNoEffectDenial(
                  definition.sideEffectSemantics,
                  regions,
                  "ApprovalConsumedByOtherInvocation",
                );
              }
              if (
                typeof claim.cause === "object" &&
                claim.cause !== null &&
                "_tag" in claim.cause &&
                claim.cause._tag === "AH7ClaimStopped"
              ) {
                return { _tag: "Interrupted" as const };
              }
              return yield* Effect.fail<ToolRuntimeError>(
                isLeaseFencingRejected(claim.cause)
                  ? claim.cause
                  : operationalFailure(
                      "IntentJournal",
                      String(intent.invocationId),
                    )(claim.cause),
              );
            }
            if (claim.value === "ExecutionStopping") {
              return { _tag: "Interrupted" as const };
            }
            if (needsApproval) approvalAlreadyConsumedBySelf = true;
            if (options.qualificationProbe !== undefined) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "AH7AfterToolIntentCommit",
                    executionId: context.executionId,
                    invocationId: intent.invocationId,
                    callRef: intent.callRef,
                  }) ?? Promise.resolve(),
              );
            }
          }

          const effectGateNow = yield* clock.now();
          const effectAuthority = Option.isSome(authorityResolver)
            ? yield* authorityResolver.value
                .resolve({
                  intent,
                  definition,
                  context,
                  regions,
                  now: effectGateNow,
                })
                .pipe(
                  Effect.mapError(
                    operationalFailure(
                      "AuthorityResolution",
                      String(intent.invocationId),
                    ),
                  ),
                )
            : context.authority;
          if (effectAuthority === undefined) {
            return yield* recordNoEffectDenial(
              definition.sideEffectSemantics,
              regions,
              approvalAlreadyConsumedBySelf
                ? "ApprovalNoLongerAuthorized"
                : "InvocationAuthorityDenied",
            );
          }
          if (options.qualificationProbe !== undefined) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH7AfterEffectAuthorityResolvedBeforeAdmission",
                  executionId: context.executionId,
                  invocationId: intent.invocationId,
                  callRef: intent.callRef,
                }) ?? Promise.resolve(),
            );
          }
          if (effectAuthority.sourceRevision === undefined) {
            return yield* recordNoEffectDenial(
              definition.sideEffectSemantics,
              regions,
              approvalAlreadyConsumedBySelf
                ? "ApprovalNoLongerAuthorized"
                : "InvocationAuthorityDenied",
            );
          }
          const effectAuthorityCheck = checkInvocationAuthority({
            authority: effectAuthority,
            definition,
            intent,
            context,
            regions,
            now: effectGateNow,
            maxDelegationDepth: options.maxDelegationDepth ?? 1,
          });
          if (effectAuthorityCheck._tag === "Denied") {
            return yield* recordNoEffectDenial(
              definition.sideEffectSemantics,
              regions,
              approvalAlreadyConsumedBySelf
                ? "ApprovalNoLongerAuthorized"
                : "InvocationAuthorityDenied",
            );
          }
          if (
            needsApproval &&
            intent.approvalId !== null &&
            context.executableApproval === undefined
          ) {
            const approval = yield* tx
              .transact(store.findApproval(intent.approvalId))
              .pipe(
                Effect.mapError(
                  operationalFailure(
                    "ApprovalLookup",
                    String(intent.invocationId),
                  ),
                ),
              );
            const matched = Option.isSome(approval)
              ? matchApproval({
                  approval: approval.value,
                  intent,
                  definition,
                  context,
                  regions,
                  now: effectGateNow,
                  replayOfRecordedInvocation: approvalAlreadyConsumedBySelf,
                })
              : { _tag: "Denied" as const, reason: "approval not found" };
            if (matched._tag === "Denied") {
              return yield* recordNoEffectDenial(
                definition.sideEffectSemantics,
                regions,
                approvalAlreadyConsumedBySelf
                  ? "ApprovalNoLongerAuthorized"
                  : approvalDenialCode(matched.reason),
              );
            }
          }
          if (options.qualificationProbe !== undefined) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH7BeforeEffectAdmission",
                  executionId: context.executionId,
                  invocationId: intent.invocationId,
                  callRef: intent.callRef,
                }) ?? Promise.resolve(),
            );
          }
          const effectAdmission = yield* Effect.match(
            tx.transact(
              store.admitEffect(
                intent.invocationId,
                effectAuthority,
                effectGateNow,
                context.executionFence,
              ),
            ),
            {
              onFailure: (cause) => ({ _tag: "Failed" as const, cause }),
              onSuccess: (value) => ({ _tag: "Succeeded" as const, value }),
            },
          );
          if (effectAdmission._tag === "Failed") {
            return yield* Effect.fail<ToolRuntimeError>(
              isLeaseFencingRejected(effectAdmission.cause)
                ? effectAdmission.cause
                : operationalFailure(
                    "IntentJournal",
                    String(intent.invocationId),
                  )(effectAdmission.cause),
            );
          }
          if (effectAdmission.value._tag === "Denied") {
            return yield* recordNoEffectDenial(
              definition.sideEffectSemantics,
              regions,
              approvalAlreadyConsumedBySelf
                ? "ApprovalNoLongerAuthorized"
                : effectAdmission.value.reasonCode,
            );
          }
          if (effectAdmission.value._tag === "ExecutionStopping") {
            const settledAt = yield* clock.now();
            const interrupted = yield* tx
              .transact(
                store.recordNoEffectInterruption(
                  intent.invocationId,
                  settledAt,
                  context.executionFence,
                  settledAt,
                ),
              )
              .pipe(
                Effect.mapError(
                  operationalFailure(
                    "IntentJournal",
                    String(intent.invocationId),
                  ),
                ),
              );
            if (!interrupted) {
              const current = yield* tx
                .transact(store.findById(intent.invocationId))
                .pipe(
                  Effect.mapError(
                    operationalFailure(
                      "IntentJournal",
                      String(intent.invocationId),
                    ),
                  ),
                );
              if (
                Option.isSome(current) &&
                current.value.effectAdmissionState !== "NotAdmitted"
              ) {
                return {
                  _tag: "OutcomeUnknown" as const,
                  reconciliationRefs: [String(intent.invocationId)],
                };
              }
            }
            return { _tag: "Interrupted" as const };
          }

          if (options.qualificationProbe !== undefined) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH7AfterEffectAdmissionCommit",
                  executionId: context.executionId,
                  invocationId: intent.invocationId,
                  callRef: intent.callRef,
                }) ?? Promise.resolve(),
            );
          }

          const handle = yield* sandbox
            .open(
              address === undefined || region === undefined
                ? {
                    executionId: context.executionId,
                    workspaceId: context.workspaceId,
                    regions,
                  }
                : {
                    executionId: context.executionId,
                    workspaceId: context.workspaceId,
                    mounts: [
                      {
                        ref: "workspace",
                        address,
                        region,
                        access: executor.write ? "ReadWrite" : "ReadOnly",
                      },
                    ],
                  },
            )
            .pipe(
              Effect.mapError(
                operationalFailure("SandboxOpen", String(intent.invocationId)),
              ),
            );
          const executed = yield* Effect.match(
            executor.execute({
              intent,
              definition,
              context,
              sandbox: handle,
              regions,
            }),
            {
              onFailure: (cause) => ({ ok: false as const, cause }),
              onSuccess: (value) => ({ ok: true as const, value }),
            },
          );
          const closed = yield* Effect.match(sandbox.close(handle), {
            onFailure: (cause) => ({ ok: false as const, cause }),
            onSuccess: () => ({ ok: true as const }),
          });
          if (!closed.ok) {
            return yield* Effect.fail<ToolRuntimeError>({
              _tag: "ToolRuntimeCleanupFailure",
              stage: "SandboxClose",
              effectDisposition: "OutcomeUncertain",
              invocationRef: String(intent.invocationId),
              cause: closed.cause,
              ...(executed.ok
                ? {}
                : {
                    priorFailure: {
                      _tag: "ToolRuntimeOperationalFailure" as const,
                      stage: "Executor" as const,
                      effectDisposition: "OutcomeUncertain" as const,
                      invocationRef: String(intent.invocationId),
                      cause: executed.cause,
                    },
                  }),
            });
          }
          if (!executed.ok) {
            return yield* Effect.fail<ToolRuntimeError>({
              _tag: "ToolRuntimeOperationalFailure",
              stage: "Executor",
              effectDisposition: "OutcomeUncertain",
              invocationRef: String(intent.invocationId),
              cause: executed.cause,
            });
          }
          const outcome = executed.value;
          if (options.qualificationProbe !== undefined) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH7AfterToolEffectBeforeSettlement",
                  executionId: context.executionId,
                  invocationId: intent.invocationId,
                  callRef: intent.callRef,
                }) ?? Promise.resolve(),
            );
          }

          const resultRef =
            outcome.settlement._tag === "Success" &&
            outcome.resultRef === null &&
            Option.isSome(artifactService)
              ? String(
                  (yield* tx
                    .transact(
                      artifactService.value.store(
                        new TextEncoder().encode(outcome.observation.text),
                        `tool-result:${intent.toolName}`,
                        {
                          invocationId: intent.invocationId,
                          executionId: context.executionId,
                        },
                        now,
                      ),
                    )
                    .pipe(
                      Effect.mapError(
                        operationalFailure(
                          "SettlementJournal",
                          String(intent.invocationId),
                        ),
                      ),
                    )).artifactId,
                )
              : outcome.resultRef;

          const settledAt = yield* clock.now();
          if (options.qualificationProbe !== undefined) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH7BeforeToolSettlementTransaction",
                  executionId: context.executionId,
                  invocationId: intent.invocationId,
                  callRef: intent.callRef,
                }) ?? Promise.resolve(),
            );
          }
          const settlementWrite = yield* Effect.match(
            tx.transact(
              Effect.gen(function* () {
                const fenceNow = yield* clock.now();
                const applied = yield* store.settle(
                  intent.invocationId,
                  outcome.settlement,
                  resultRef,
                  settledAt,
                  context.executionFence,
                  fenceNow,
                );
                if (applied && options.qualificationProbe !== undefined) {
                  yield* Effect.promise(
                    () =>
                      options.qualificationProbe?.({
                        boundary: "AH7BeforeToolSettlementCommit",
                        executionId: context.executionId,
                        invocationId: intent.invocationId,
                        callRef: intent.callRef,
                      }) ?? Promise.resolve(),
                  );
                }
                return {
                  applied,
                  current: applied
                    ? Option.none()
                    : yield* store.findById(intent.invocationId),
                };
              }),
            ),
            {
              onFailure: (cause) => ({ ok: false as const, cause }),
              onSuccess: (value) => ({ ok: true as const, value }),
            },
          );
          if (!settlementWrite.ok) {
            if (
              isLeaseFencingRejected(settlementWrite.cause) &&
              options.qualificationProbe !== undefined
            ) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "AH7ToolSettlementFenceRejected",
                    executionId: context.executionId,
                    invocationId: intent.invocationId,
                    callRef: intent.callRef,
                  }) ?? Promise.resolve(),
              );
            }
            return yield* Effect.fail<ToolRuntimeError>(
              isLeaseFencingRejected(settlementWrite.cause)
                ? settlementWrite.cause
                : operationalFailure(
                    "SettlementJournal",
                    String(intent.invocationId),
                  )(settlementWrite.cause),
            );
          }
          if (!settlementWrite.value.applied) {
            const canonical = settlementWrite.value.current;
            if (
              Option.isSome(canonical) &&
              canonical.value.settlement?._tag === "OutcomeUnknown"
            ) {
              return {
                _tag: "OutcomeUnknown" as const,
                reconciliationRefs:
                  canonical.value.settlement.reconciliationRefs,
              };
            }
            return yield* Effect.fail<ToolRuntimeError>(
              operationalFailure(
                "SettlementJournal",
                String(intent.invocationId),
              )({
                _tag: "ToolInvocationSettlementNotApplied",
                canonicalSettlement: Option.isSome(canonical)
                  ? (canonical.value.settlement?._tag ?? "Unsettled")
                  : "Missing",
              }),
            );
          }
          if (options.qualificationProbe !== undefined) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH7AfterToolSettlementCommit",
                  executionId: context.executionId,
                  invocationId: intent.invocationId,
                  callRef: intent.callRef,
                }) ?? Promise.resolve(),
            );
          }

          const observation: CanonicalToolObservation = (() => {
            switch (outcome.settlement._tag) {
              case "Success":
                return {
                  _tag: "Success",
                  observation: outcome.observation,
                  resultRef,
                };
              case "ExpectedFailure":
                return {
                  _tag: "ExpectedFailure",
                  observation: outcome.observation,
                };
              case "Denied":
                return denied(outcome.settlement.reasonCode);
              case "Interrupted":
                return { _tag: "Interrupted" };
              case "OutcomeUnknown":
                return {
                  _tag: "OutcomeUnknown",
                  reconciliationRefs: outcome.settlement.reconciliationRefs,
                };
              case "RuntimeFailure":
                return {
                  _tag: "RuntimeFailure",
                  cause: outcome.settlement.cause,
                };
            }
          })();
          return observation;
        });

      return ToolRuntimePort.of({ invoke });
    }),
  );

export { bounded };
