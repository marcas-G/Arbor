import type {
  AgentBinding,
  AgentExecutionState,
  Execution,
  ExecutionSettlement,
  LeaseGeneration,
} from "@arbor/domain";
import {
  ContextEpochNumber,
  conversationResponseEpisode,
  executionEpisode,
  providerTurnOverflowReplacementId as makeOverflowReplacementProviderTurnId,
  ProviderTurnId,
  parse,
  providerTurnInferenceId,
  providerTurnNativeCompactionId,
  providerTurnRepairInferenceId,
  providerTurnSummaryCompactionId,
  workEpisode,
} from "@arbor/domain";
import {
  type ControlBasis,
  decideSessionProjection,
  decodeTurn,
  GENERIC_COGNITION_PROGRAM,
  type InstructionFragment,
  latestSessionInputIndex,
  type ModelContextService,
  projectCompressibleHistory,
  projectSessionTimeline,
  SESSION_TIMELINE_ENTRY_LIMIT,
  type SessionTimelineProjection,
  type TurnProfileResolverService,
} from "@arbor/model-context";
import type {
  AgentLoopStepActionRecord,
  AgentLoopStepFence,
  AgentLoopStepProviderTurnLink,
  AgentLoopStepRecord,
  AgentLoopStepStoreService,
  BlobStorePortService,
  ConversationAttemptStoreService,
  ConversationCheckpointOwner,
  ConversationCheckpointStoreService,
  ConversationResponseJob,
  ConversationResponseJobStoreService,
  DecisionRequestStoreService,
  ExecutionActivity,
  ExecutionDriverError,
  ExecutionRepositoryService,
  HumanMessageStoreService,
  LocalPlanStoreService,
  ModelCapability,
  PortableInputItem,
  PortableModelRequestV2,
  ProviderExecutionPolicyOverrides,
  ProviderRunInput,
  ProviderRuntimeProgress,
  ProviderRuntimeService,
  ProviderTurnStoreService,
  RecoveryAttentionFactStoreService,
  RuntimeSafetyObservation,
  SecretRef,
  SessionEntryRecord,
  SessionRepositoryService,
  TransactionPortService,
  WorkRepositoryService,
  WorkspaceKnowledgePortService,
  WorkspacePlacementPortService,
  WorkspaceRepositoryService,
} from "@arbor/ports";
import {
  canonicalizeLegacyAdoptionEvidenceV1,
  isValidConversationCheckpointBinding,
  LEGACY_ADOPTION_MISSING,
  sha256Hex,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import {
  isProviderExecutionTimeout,
  isProviderFailure,
  isProviderTurnBindingChanged,
  MAX_TURNS,
  type ModelDecisionOutcome,
  providerExecutionTimeoutSettlement,
  providerFailureSettlement,
  providerTurnBindingChangedSettlement,
  REPAIR_POLICY,
  runtimeSafetyFragment,
  safetyStop,
} from "./agent-loop-policy.js";
import {
  decodeExhaustedRepairDisposition,
  hasValidCompiledInferenceRequestHash,
  isP20OverflowReplacementManifestBound,
  resolveP20OverflowReplacementChain,
} from "./agent-loop-step-recovery.js";
import {
  commitRecoveredNativeCompaction,
  commitRecoveredSummaryCompaction,
  runCompaction,
  runSummaryCompaction,
} from "./compaction-coordinator.js";
import { conversationCheckpointBindingUse } from "./conversation-checkpoint-binding.js";
import { runConversationCheckpointCompaction } from "./conversation-checkpoint-compaction.js";
import {
  type ConversationCheckpointProjection,
  projectConversationCheckpointHistory,
} from "./conversation-checkpoint-projection.js";
import {
  GENERIC_INSTRUCTION_ASSETS,
  instructionAssetFragment,
  workExecutionLoopFragmentsFor,
} from "./prompt-assets.js";
import type { AgentLoopQualificationProbe } from "./qualification-probe.js";
import { decideRepair } from "./repair.js";
import { makeAgentStepContext } from "./step-context.js";
import { assembleWorkContext } from "./work-context.js";

export interface ModelDecisionOptions {
  readonly secretRef?: SecretRef;
  readonly executionPolicyOverrides?: ProviderExecutionPolicyOverrides;
  readonly providerRef?: string;
  readonly onProviderProgress?:
    | ((executionId: string, event: ProviderRuntimeProgress) => void)
    | undefined;
  readonly qualificationProbe?: AgentLoopQualificationProbe;
}

export interface ModelDecisionDependencies {
  readonly input: {
    readonly execution: Execution;
    readonly agentExecutionState: AgentExecutionState;
  };
  readonly agentBinding: AgentBinding;
  readonly capability: ModelCapability;
  readonly currentControlBasis: () => Effect.Effect<
    ControlBasis,
    ExecutionDriverError
  >;
  readonly modelContext: ModelContextService;
  readonly providerRuntime: ProviderRuntimeService;
  readonly tx: TransactionPortService;
  readonly loopSteps?: AgentLoopStepStoreService;
  readonly loopStepFence?: AgentLoopStepFence;
  readonly providerTurns?: ProviderTurnStoreService;
  readonly recoveryAttentionFacts?: RecoveryAttentionFactStoreService;
  readonly sessions: SessionRepositoryService;
  readonly humanMessages: HumanMessageStoreService;
  readonly conversationCheckpoints?: ConversationCheckpointStoreService;
  readonly blobs?: Pick<BlobStorePortService, "put" | "get">;
  readonly turnProfileResolver: TurnProfileResolverService;
  readonly responseJobs?: Pick<
    ConversationResponseJobStoreService,
    "findByExecution" | "listForWorkspace"
  >;
  readonly responseAttempts?: Pick<ConversationAttemptStoreService, "list">;
  readonly executions?: Pick<ExecutionRepositoryService, "findById">;
  readonly works: WorkRepositoryService;
  readonly localPlans?: Pick<LocalPlanStoreService, "findByWork">;
  readonly decisionRequests?: Pick<DecisionRequestStoreService, "findById">;
  readonly workspaces: WorkspaceRepositoryService;
  readonly workspaceKnowledge?: WorkspaceKnowledgePortService;
  readonly workspacePlacement?: WorkspacePlacementPortService;
  readonly options: ModelDecisionOptions;
  readonly admit: (
    activity: ExecutionActivity,
    observation: RuntimeSafetyObservation,
  ) => Effect.Effect<"Continue" | "Stop">;
  readonly failure: (cause: unknown) => ExecutionDriverError;
  readonly now: () => Effect.Effect<string>;
  readonly leaseGeneration?: LeaseGeneration;
}

interface SubmittedDecisionReplayInput {
  readonly executionWorkspaceId: string;
  readonly episode: {
    readonly decisionId: string;
    readonly requestRevision: number;
  };
  readonly request: {
    readonly workspaceId: string;
    readonly candidateWorkIds: ReadonlyArray<string>;
    readonly workspaceRevision: number;
    readonly revision: number;
    readonly state:
      | { readonly _tag: "Pending" }
      | { readonly _tag: "Submitted"; readonly selectedWorkId: string };
  };
  readonly workspace:
    | {
        readonly currentWorkId: string | null;
        readonly revision: number;
      }
    | undefined;
  readonly step:
    | (Omit<
        Pick<
          AgentLoopStepRecord,
          | "providerTurnId"
          | "state"
          | "nextActionIndex"
          | "manifestId"
          | "decodedOutputHash"
          | "modelOutputSessionSequence"
        >,
        "providerTurnId"
      > & { readonly providerTurnId: string })
    | undefined;
  readonly pendingAction:
    | Pick<
        AgentLoopStepActionRecord,
        "actionIndex" | "routeKind" | "actionKind" | "state"
      >
    | undefined;
  readonly providerTurnId: string;
  readonly providerResult:
    | { readonly _tag: "SettledSuccess"; readonly manifestId: string }
    | undefined;
}

export type SubmittedDecisionBindingFailureCode =
  | "DecisionRequestWorkspaceMismatch"
  | "StepManifestMismatch";

/** Classifies only the two frozen AH10 integrity failures. Other invalid or
 * incomplete replay evidence remains on the existing fail-closed path. */
export const classifySubmittedDecisionBindingFailure = (
  input: SubmittedDecisionReplayInput,
): SubmittedDecisionBindingFailureCode | undefined => {
  const { request, step, pendingAction, providerResult } = input;
  if (
    request.state._tag !== "Submitted" ||
    step === undefined ||
    step.providerTurnId !== input.providerTurnId ||
    step.state !== "ActionsInProgress" ||
    pendingAction === undefined ||
    pendingAction.actionIndex !== step.nextActionIndex ||
    pendingAction.routeKind !== "Control" ||
    pendingAction.actionKind !== "select_current_work" ||
    pendingAction.state !== "Pending"
  ) {
    return undefined;
  }
  if (request.workspaceId !== input.executionWorkspaceId) {
    return "DecisionRequestWorkspaceMismatch";
  }
  if (
    step.manifestId !== undefined &&
    providerResult?._tag === "SettledSuccess" &&
    providerResult.manifestId !== step.manifestId
  ) {
    return "StepManifestMismatch";
  }
  return undefined;
};

/** A terminal DecisionRequest may be reused only to recover this exact
 * already-pinned SelectCurrentWork action. All new or otherwise ambiguous
 * DecisionEpisodes remain Pending-only. */
export const isPinnedSubmittedDecisionReplay = (
  input: SubmittedDecisionReplayInput,
): boolean => {
  const { request, episode, workspace, step, pendingAction, providerResult } =
    input;
  const selectedWorkId =
    request.state._tag === "Submitted"
      ? request.state.selectedWorkId
      : undefined;
  return (
    request.state._tag === "Submitted" &&
    request.workspaceId === input.executionWorkspaceId &&
    request.revision === episode.requestRevision + 1 &&
    selectedWorkId !== undefined &&
    request.candidateWorkIds.includes(selectedWorkId) &&
    workspace?.currentWorkId === selectedWorkId &&
    workspace.revision === request.workspaceRevision + 1 &&
    step !== undefined &&
    step.providerTurnId === input.providerTurnId &&
    step.state === "ActionsInProgress" &&
    step.manifestId !== undefined &&
    step.decodedOutputHash !== undefined &&
    step.modelOutputSessionSequence !== undefined &&
    pendingAction !== undefined &&
    pendingAction.actionIndex === step.nextActionIndex &&
    pendingAction.routeKind === "Control" &&
    pendingAction.actionKind === "select_current_work" &&
    pendingAction.state === "Pending" &&
    providerResult?._tag === "SettledSuccess" &&
    providerResult.manifestId === step.manifestId
  );
};

export const isValidOverflowCompactionLinkPair = (
  links: ReadonlyArray<AgentLoopStepProviderTurnLink>,
  inferenceProviderTurnId: string,
  expectedCompactionProviderTurnId: string | ReadonlyArray<string>,
): boolean => {
  const inferenceLinks = links.filter((link) => link.role === "Inference");
  const compactionLinks = links.filter(
    (link) => link.role === "OverflowCompaction",
  );
  const inference = inferenceLinks[0];
  const compaction = compactionLinks[0];
  return (
    inferenceLinks.length === 1 &&
    compactionLinks.length === 1 &&
    inference !== undefined &&
    compaction !== undefined &&
    inference.providerTurnId === inferenceProviderTurnId &&
    inference.state === "SettledFailure" &&
    compaction.state === "Prepared" &&
    inference.contextEpoch === compaction.contextEpoch &&
    (typeof expectedCompactionProviderTurnId === "string"
      ? compaction.providerTurnId === expectedCompactionProviderTurnId
      : expectedCompactionProviderTurnId.includes(compaction.providerTurnId)) &&
    compaction.predecessorProviderTurnId === inferenceProviderTurnId
  );
};

const nativeCompactionProviderTurnId = (value: string): ProviderTurnId | null =>
  (() => {
    try {
      const decoded = parse(ProviderTurnId)(value);
      return /_native_compact_(?:0|[1-9][0-9]*)$/u.test(decoded)
        ? decoded
        : null;
    } catch {
      return null;
    }
  })();

const decodedProviderTurnId = (value: unknown): ProviderTurnId | null => {
  if (typeof value !== "string") return null;
  try {
    return parse(ProviderTurnId)(value);
  } catch {
    return null;
  }
};

interface NativePortableFrontier {
  readonly manifest: Record<string, unknown>;
  readonly request: PortableModelRequestV2;
  readonly inputFrontier: {
    readonly firstSequence: number | null;
    readonly lastSequence: number | null;
  };
  readonly contextRefs: ReadonlyArray<string>;
  readonly inputItems: ReadonlyArray<PortableInputItem>;
}

const containsNativeCheckpointInput = (
  inputItems: ReadonlyArray<unknown>,
): boolean =>
  inputItems.some(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      "_tag" in item &&
      item._tag === "CompactionCheckpoint" &&
      "implementation" in item &&
      item.implementation === "ProviderNative",
  );

const portableRequestHasNativeCheckpoint = (portableRequestJson: string) => {
  try {
    const value = JSON.parse(portableRequestJson) as unknown;
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !("inputItems" in value) ||
      !Array.isArray(value.inputItems)
    ) {
      return false;
    }
    return containsNativeCheckpointInput(value.inputItems);
  } catch {
    return false;
  }
};

const decodeUniqueNativePortableFrontier = (
  manifestJson: string,
  portableRequestJson: string,
): NativePortableFrontier | null => {
  try {
    const manifestValue = JSON.parse(manifestJson) as unknown;
    const requestValue = JSON.parse(portableRequestJson) as unknown;
    if (
      typeof manifestValue !== "object" ||
      manifestValue === null ||
      Array.isArray(manifestValue) ||
      typeof requestValue !== "object" ||
      requestValue === null ||
      Array.isArray(requestValue)
    ) {
      return null;
    }
    const manifest = manifestValue as Record<string, unknown>;
    const request = requestValue as Record<string, unknown>;
    const frontierValue = manifest.inputFrontier;
    const contextRefsValue = manifest.contextRefs;
    const inputItemsValue = request.inputItems;
    if (
      typeof frontierValue !== "object" ||
      frontierValue === null ||
      Array.isArray(frontierValue) ||
      !Array.isArray(contextRefsValue) ||
      !contextRefsValue.every(
        (ref): ref is string => typeof ref === "string" && ref.length > 0,
      ) ||
      contextRefsValue.length === 0 ||
      new Set(contextRefsValue).size !== contextRefsValue.length ||
      !Array.isArray(inputItemsValue) ||
      inputItemsValue.length === 0 ||
      !Array.isArray(request.instructions) ||
      !Array.isArray(request.toolDefinitions) ||
      typeof request.budget !== "object" ||
      request.budget === null ||
      typeof (request.budget as Record<string, unknown>).maxOutputTokens !==
        "number" ||
      !Array.isArray(request.cacheHints)
    ) {
      return null;
    }
    if (containsNativeCheckpointInput(inputItemsValue)) {
      return null;
    }
    const frontier = frontierValue as Record<string, unknown>;
    const firstSequence = frontier.firstSequence;
    const lastSequence = frontier.lastSequence;
    const emptyFrontier = firstSequence === null && lastSequence === null;
    const validNonEmptyFrontier =
      typeof firstSequence === "number" &&
      Number.isSafeInteger(firstSequence) &&
      firstSequence >= 0 &&
      typeof lastSequence === "number" &&
      Number.isSafeInteger(lastSequence) &&
      lastSequence >= firstSequence;
    if (
      (!emptyFrontier && !validNonEmptyFrontier) ||
      request.requestVersion !== 2 ||
      request.operationKind !== "CompactionNative" ||
      request.outputContractRef !== "provider-native-compaction-v1" ||
      typeof manifest.compiledRequestHash !== "string" ||
      manifest.compiledRequestHash !== sha256Hex(portableRequestJson)
    ) {
      return null;
    }
    return {
      manifest,
      request: request as unknown as PortableModelRequestV2,
      inputFrontier: emptyFrontier
        ? { firstSequence: null, lastSequence: null }
        : {
            firstSequence: firstSequence as number,
            lastSequence: lastSequence as number,
          },
      contextRefs: contextRefsValue,
      inputItems: inputItemsValue as ReadonlyArray<PortableInputItem>,
    };
  } catch {
    return null;
  }
};

/** Root conversation shares the Workspace primary Session with Work episodes.
 * Only timeline items causally written by the exact conversation execution may
 * re-enter its next turn; all historical Work/tool traffic stays excluded. */
const belongsToConversationExecution = (
  entry: SessionEntryRecord,
  executionId: string,
): boolean => {
  const source = entry.source;
  if (source === undefined) return false;
  const providerTurnPrefix = `ptn_${executionId}_`;
  if (
    (source.kind === "ProviderTurn" ||
      source.kind === "ProviderTurnCall" ||
      source.kind === "CompactionTurn") &&
    (() => {
      const [providerTurnRef, ...sourceSuffix] = source.ref.split(":");
      if (
        providerTurnRef === undefined ||
        !providerTurnRef.startsWith(providerTurnPrefix)
      ) {
        return false;
      }
      try {
        parse(ProviderTurnId)(providerTurnRef);
      } catch {
        return false;
      }
      switch (source.kind) {
        case "ProviderTurn":
          return (
            sourceSuffix.length === 0 ||
            (sourceSuffix.length === 1 && sourceSuffix[0] === "assistant")
          );
        case "ProviderTurnCall":
          return (
            sourceSuffix.length === 1 &&
            sourceSuffix[0] !== undefined &&
            sourceSuffix[0].length > 0
          );
        case "CompactionTurn":
          return sourceSuffix.length === 0;
      }
    })()
  ) {
    return true;
  }
  return (
    source.kind === "AgentLoopAction" &&
    source.ref.startsWith(`observation_${executionId}_`)
  );
};

const validateConversationCheckpointReceipt = (input: {
  readonly owner: ConversationCheckpointOwner;
  readonly execution: Execution;
  readonly providerTurns: ProviderTurnStoreService | undefined;
  readonly tx: TransactionPortService;
  readonly failure: (cause: unknown) => ExecutionDriverError;
}): Effect.Effect<void, ExecutionDriverError> =>
  Effect.gen(function* () {
    const { owner, execution, providerTurns, tx, failure } = input;
    if (
      owner.checkpointKind === null ||
      owner.producerProviderTurnId === null ||
      owner.producerExecutionId === null ||
      owner.sourceManifestJson === null ||
      owner.checkpointRef === null ||
      providerTurns === undefined
    ) {
      return yield* Effect.fail(
        failure({ _tag: "ConversationCheckpointEvidenceMissing" }),
      );
    }
    let sourceManifest: Record<string, unknown>;
    try {
      const value = JSON.parse(owner.sourceManifestJson) as unknown;
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("source manifest is not an object");
      }
      sourceManifest = value as Record<string, unknown>;
    } catch {
      return yield* Effect.fail(
        failure({ _tag: "ConversationCheckpointEvidenceInvalid" }),
      );
    }
    const [storedManifest, settled] = yield* Effect.all(
      [
        tx.transact(
          providerTurns.findManifestByTurn(owner.producerProviderTurnId),
        ),
        tx.transact(
          providerTurns.findSettledResult(owner.producerProviderTurnId),
        ),
      ],
      { concurrency: 1 },
    ).pipe(Effect.mapError(failure));
    if (
      storedManifest === null ||
      settled._tag !== "SettledSuccess" ||
      settled.evidenceVersion !== "provider-success-v1" ||
      settled.finishReason !== "Stop" ||
      settled.manifestId !== storedManifest.manifestId ||
      sourceManifest.producerManifestId !== storedManifest.manifestId ||
      settled.manifestJson !== storedManifest.manifestJson ||
      settled.turn.providerTurnId !== owner.producerProviderTurnId ||
      settled.turn.executionId !== owner.producerExecutionId ||
      settled.turn.sessionId !== execution.sessionId ||
      Number(settled.turn.contextEpoch) !== Number(sourceManifest.fromEpoch) ||
      Number(sourceManifest.toEpoch) !== Number(owner.contextEpoch) ||
      sourceManifest.producerProviderTurnId !== owner.producerProviderTurnId ||
      sourceManifest.producerExecutionId !== owner.producerExecutionId
    ) {
      return yield* Effect.fail(
        failure({ _tag: "ConversationCheckpointEvidenceInvalid" }),
      );
    }
    let manifest: Record<string, unknown>;
    let request: Record<string, unknown>;
    try {
      const parsedManifest = JSON.parse(storedManifest.manifestJson) as unknown;
      const parsedRequest = JSON.parse(
        storedManifest.portableRequestJson,
      ) as unknown;
      if (
        typeof parsedManifest !== "object" ||
        parsedManifest === null ||
        Array.isArray(parsedManifest) ||
        typeof parsedRequest !== "object" ||
        parsedRequest === null ||
        Array.isArray(parsedRequest)
      ) {
        throw new Error("provider manifest/request shape invalid");
      }
      manifest = parsedManifest as Record<string, unknown>;
      request = parsedRequest as Record<string, unknown>;
    } catch {
      return yield* Effect.fail(
        failure({ _tag: "ConversationCheckpointEvidenceInvalid" }),
      );
    }
    const expectedOperation =
      owner.checkpointKind === "Summary"
        ? "CompactionSummary"
        : "CompactionNative";
    const expectedContract =
      owner.checkpointKind === "Summary"
        ? "compaction-result-v1"
        : "provider-native-compaction-v1";
    if (
      manifest.providerTurnId !== owner.producerProviderTurnId ||
      manifest.executionId !== owner.producerExecutionId ||
      manifest.sessionId !== execution.sessionId ||
      manifest.modelRef !== settled.turn.modelRef ||
      Number(manifest.contextEpoch) !== Number(sourceManifest.fromEpoch) ||
      manifest.operationKind !== expectedOperation ||
      manifest.outputContractRef !== expectedContract ||
      request.operationKind !== expectedOperation ||
      request.outputContractRef !== expectedContract ||
      typeof manifest.compiledRequestHash !== "string" ||
      manifest.compiledRequestHash !== sha256Hex(JSON.stringify(request)) ||
      manifest.resolvedModelBindingFingerprint === undefined ||
      typeof manifest.resolvedModelBindingFingerprint !== "string" ||
      manifest.resolvedModelBindingFingerprint.length === 0 ||
      (owner.checkpointKind === "ProviderNative" &&
        manifest.resolvedModelBindingFingerprint !== owner.bindingFingerprint)
    ) {
      return yield* Effect.fail(
        failure({ _tag: "ConversationCheckpointEvidenceInvalid" }),
      );
    }
    const nested = manifest.conversationCheckpoint;
    if (
      typeof nested !== "object" ||
      nested === null ||
      Array.isArray(nested) ||
      JSON.stringify(nested) !==
        JSON.stringify({
          rootWorkspaceId: sourceManifest.rootWorkspaceId,
          fromEpoch: sourceManifest.fromEpoch,
          toEpoch: sourceManifest.toEpoch,
          fromFrontier: sourceManifest.fromFrontier,
          coveredThrough: sourceManifest.coveredThrough,
          coveredSources: sourceManifest.coveredSources,
          currentMessageId: sourceManifest.currentMessageId,
          currentRunningJobRevision: sourceManifest.currentRunningJobRevision,
          currentRunningAttemptNo: sourceManifest.currentRunningAttemptNo,
          currentAdmissionJobRevision:
            sourceManifest.currentAdmissionJobRevision,
        })
    ) {
      return yield* Effect.fail(
        failure({ _tag: "ConversationCheckpointEvidenceInvalid" }),
      );
    }
    if (owner.checkpointKind === "ProviderNative") {
      const continuationStates = settled.canonicalEvents.filter(
        (event) => event._tag === "ContinuationState",
      );
      if (
        continuationStates.length !== 1 ||
        continuationStates[0]?._tag !== "ContinuationState" ||
        continuationStates[0].stateRef !== owner.checkpointRef
      ) {
        return yield* Effect.fail(
          failure({ _tag: "ConversationCheckpointEvidenceInvalid" }),
        );
      }
    }
  });

export const runModelDecision = (
  dependencies: ModelDecisionDependencies,
  turn: number,
  activity: ExecutionActivity,
  initialRepairAttempt = 0,
): Effect.Effect<ModelDecisionOutcome, ExecutionDriverError> => {
  const {
    input,
    agentBinding,
    capability,
    currentControlBasis,
    modelContext,
    providerRuntime,
    tx,
    loopSteps,
    loopStepFence,
    providerTurns,
    sessions,
    humanMessages,
    turnProfileResolver,
    responseJobs,
    works,
    localPlans,
    decisionRequests,
    workspaces,
    workspaceKnowledge,
    workspacePlacement,
    options,
    admit,
    failure,
    now,
    leaseGeneration,
  } = dependencies;
  const currentBindingFingerprint =
    capability.bindingFingerprint ??
    `legacy:${capability.providerRef ?? options.providerRef ?? "provider"}:${capability.modelRef}`;
  const providerNativeSupported =
    capability.portableRequestCompatibility?.operationKinds.includes(
      "CompactionNative",
    ) === true;
  const isConversationResponseExecution =
    conversationResponseEpisode(input.execution) !== null;
  return Effect.gen(function* () {
    let repairAttempt = initialRepairAttempt;
    let compactionAttempts = 0;
    let overflowRecoveryAttempt = 0;
    let replayPersistedContextLimit = false;
    let resumeOverflowCompactionProviderTurnId:
      | import("@arbor/domain").ProviderTurnId
      | undefined;
    let resumeOverflowNativeCompaction = false;
    let resumeOverflowNativeCompactionInput:
      | {
          readonly manifestJson: string;
          readonly request: PortableModelRequestV2;
        }
      | undefined;
    let overflowReplacementProviderTurnId:
      | import("@arbor/domain").ProviderTurnId
      | undefined;
    let repairFragments: ReadonlyArray<InstructionFragment> = [];
    const readExecutionTimeline = () =>
      executionEpisode(input.execution)?._tag === "WorkEpisode"
        ? sessions.listWorkActiveFrontier(input.execution.sessionId)
        : sessions.listRecentEntries(
            input.execution.sessionId,
            SESSION_TIMELINE_ENTRY_LIMIT,
          );
    const loadWorkCompactionPinning = () =>
      Effect.gen(function* () {
        if (executionEpisode(input.execution)?._tag !== "WorkEpisode") {
          return {};
        }
        const boundWork = workEpisode(input.execution);
        if (boundWork === null) return {};
        const [workspace, work] = yield* Effect.all(
          [
            tx.transact(workspaces.findById(input.execution.workspaceId)),
            tx.transact(works.findById(boundWork.workId)),
          ],
          { concurrency: 1 },
        ).pipe(Effect.mapError(failure));
        if (Option.isNone(workspace)) {
          return yield* Effect.fail(
            failure({
              _tag: "WorkspaceContextMissing",
              workspaceId: input.execution.workspaceId,
            }),
          );
        }
        if (Option.isNone(work)) {
          return yield* Effect.fail(
            failure({
              _tag: "WorkContextMissing",
              workId: boundWork.workId,
            }),
          );
        }
        const workContext = assembleWorkContext(
          workspace.value,
          work.value,
          input.execution,
        );
        const controlBasis = yield* currentControlBasis();
        return {
          pinnedInstructions: workContext.fragments.map((fragment) => ({
            slotId: fragment.scope,
            authorityRole: fragment.authorityRole,
            text:
              workContext.contents.get(fragment.contentRef) ??
              fragment.contentRef,
          })),
          pinnedInstructionFragments: workContext.fragments.map((fragment) => ({
            identity: fragment.identity,
            revision: fragment.revision,
            hash: fragment.hash,
            source: fragment.source,
            scope: fragment.scope,
          })),
          controlBasis,
        };
      });
    // A Work checkpoint may have been committed after the process-local loop
    // cursor was last observed. Resolve its durable source before creating a
    // fresh Prepared step so restart cannot accidentally create/replay step 0.
    if (
      executionEpisode(input.execution)?._tag === "WorkEpisode" &&
      providerTurns !== undefined &&
      loopSteps !== undefined
    ) {
      const startupTimeline = yield* tx
        .transact(readExecutionTimeline())
        .pipe(Effect.mapError(failure));
      const startupProjection = projectSessionTimeline(
        startupTimeline,
        currentBindingFingerprint,
        providerNativeSupported,
      );
      const startupCheckpoint = startupProjection.nativeCheckpoint;
      const startupSession = yield* tx
        .transact(sessions.findById(input.execution.sessionId))
        .pipe(Effect.mapError(failure));
      if (
        startupCheckpoint === undefined &&
        Option.isSome(startupSession) &&
        loopStepFence !== undefined
      ) {
        const pendingNative = yield* tx
          .transact(
            providerTurns.findNativeCompactionsBySessionEpoch({
              sessionId: input.execution.sessionId,
              contextEpoch: startupSession.value.contextEpoch,
            }),
          )
          .pipe(Effect.mapError(failure));
        if (pendingNative.length > 1) {
          if (options.qualificationProbe !== undefined) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH19NativeCheckpointRecovery",
                  stage: `NativeCompactionCandidateAmbiguity:count=${pendingNative.length}`,
                  executionId: String(input.execution.executionId),
                  providerTurnId: pendingNative[0]?.providerTurnId ?? "unknown",
                }) ?? Promise.resolve(),
            );
          }
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        const candidate = pendingNative[0];
        const candidateSourceLinkOption =
          candidate === undefined
            ? Option.none()
            : yield* tx
                .transact(
                  loopSteps.findProviderTurnLinkByProviderTurnId(
                    candidate.providerTurnId,
                  ),
                )
                .pipe(Effect.mapError(failure));
        if (
          Option.isSome(candidateSourceLinkOption) &&
          candidateSourceLinkOption.value.role !== "OverflowCompaction"
        ) {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        // P20 owns every Native ProviderTurn with an OverflowCompaction link.
        // Only unlinked ordinary compactions may use this Session/epoch scan.
        if (
          candidate !== undefined &&
          !Option.isSome(candidateSourceLinkOption)
        ) {
          const frontier = decodeUniqueNativePortableFrontier(
            candidate.manifestJson,
            candidate.portableRequestJson,
          );
          const manifest = frontier?.manifest;
          const sourceValue = manifest?.sourceAgentLoopStep;
          if (
            frontier === null ||
            manifest === undefined ||
            typeof sourceValue !== "object" ||
            sourceValue === null ||
            Array.isArray(sourceValue)
          ) {
            return yield* Effect.fail(
              failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
            );
          }
          const sourceRecord = sourceValue as Record<string, unknown>;
          if (
            sourceRecord.executionId !== input.execution.executionId ||
            !Number.isSafeInteger(sourceRecord.logicalStepNo) ||
            !Number.isSafeInteger(sourceRecord.repairAttempt) ||
            typeof sourceRecord.providerTurnId !== "string" ||
            candidate.executionId !== input.execution.executionId ||
            candidate.sessionId !== input.execution.sessionId ||
            Number(candidate.contextEpoch) !==
              Number(startupSession.value.contextEpoch) ||
            candidate.modelRef !== capability.modelRef ||
            candidate.outputContractRef !== "provider-native-compaction-v1" ||
            manifest.providerTurnId !== candidate.providerTurnId ||
            manifest.executionId !== input.execution.executionId ||
            manifest.sessionId !== input.execution.sessionId ||
            manifest.contextEpoch !== candidate.contextEpoch ||
            manifest.logicalStepNo !== sourceRecord.logicalStepNo ||
            manifest.operationKind !== "CompactionNative" ||
            manifest.outputContractRef !== "provider-native-compaction-v1" ||
            manifest.compiledRequestHash !==
              sha256Hex(candidate.portableRequestJson)
          ) {
            return yield* Effect.fail(
              failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
            );
          }
          const sourceIdentity = {
            executionId: input.execution.executionId,
            logicalStepNo: Number(sourceRecord.logicalStepNo),
            repairAttempt: Number(sourceRecord.repairAttempt),
          };
          const sourceStepOption = yield* tx
            .transact(loopSteps.find(sourceIdentity))
            .pipe(Effect.mapError(failure));
          if (
            !Option.isSome(sourceStepOption) ||
            sourceStepOption.value.providerTurnId !==
              sourceRecord.providerTurnId
          ) {
            return yield* Effect.fail(
              failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
            );
          }
          const sourceStep = sourceStepOption.value;
          if (
            sourceStep.state === "Prepared" ||
            sourceStep.state === "ProviderResultAvailable" ||
            sourceStep.state === "OutputRejected" ||
            sourceStep.state === "OutputAccepted" ||
            sourceStep.state === "ActionsInProgress"
          ) {
            turn = sourceIdentity.logicalStepNo;
            repairAttempt = sourceIdentity.repairAttempt;
          } else if (
            (sourceStep.state === "StepEffectsCommitted" ||
              sourceStep.state === "NextStepReady") &&
            sourceStep.successor !== undefined
          ) {
            turn = sourceStep.successor.logicalStepNo;
            repairAttempt = sourceStep.successor.repairAttempt;
          } else {
            return yield* Effect.fail(
              failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
            );
          }
          const priorReceipt = yield* tx
            .transact(providerTurns.findSettledResult(candidate.providerTurnId))
            .pipe(Effect.mapError(failure));
          const sourceAgentLoopStep = {
            executionId: String(sourceIdentity.executionId),
            logicalStepNo: sourceIdentity.logicalStepNo,
            repairAttempt: sourceIdentity.repairAttempt,
            providerTurnId: String(sourceStep.providerTurnId),
          };
          if (
            manifest.resolvedModelBindingFingerprint ===
              currentBindingFingerprint &&
            priorReceipt._tag === "SettledSuccess"
          ) {
            const continuationEvents = priorReceipt.canonicalEvents.filter(
              (event) => event._tag === "ContinuationState",
            );
            if (
              priorReceipt.evidenceVersion !== "provider-success-v1" ||
              priorReceipt.finishReason !== "Stop" ||
              priorReceipt.manifestJson !== candidate.manifestJson ||
              priorReceipt.turn.providerTurnId !== candidate.providerTurnId ||
              priorReceipt.turn.manifestId !== candidate.manifestId ||
              priorReceipt.turn.executionId !== input.execution.executionId ||
              priorReceipt.turn.sessionId !== input.execution.sessionId ||
              priorReceipt.turn.contextEpoch !== candidate.contextEpoch ||
              priorReceipt.turn.modelRef !== capability.modelRef ||
              priorReceipt.turn.outputContractRef !==
                "provider-native-compaction-v1" ||
              continuationEvents.length !== 1 ||
              continuationEvents[0]?._tag !== "ContinuationState" ||
              continuationEvents[0].stateRef.length === 0
            ) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            yield* commitRecoveredNativeCompaction(
              {
                execution: input.execution,
                providerTurnId: candidate.providerTurnId,
                expectedEpoch: startupSession.value.contextEpoch,
                bindingFingerprint: currentBindingFingerprint,
                opaqueItemRef: continuationEvents[0].stateRef,
                fence: loopStepFence,
              },
              { sessions, tx },
            ).pipe(Effect.mapError(failure));
          } else if (
            manifest.resolvedModelBindingFingerprint ===
              currentBindingFingerprint &&
            priorReceipt._tag === "Unsettled"
          ) {
            yield* runCompaction(
              {
                execution: input.execution,
                logicalStepNo: sourceIdentity.logicalStepNo,
                sourceAgentLoopStep,
                currentEpoch: startupSession.value.contextEpoch,
                modelRef: capability.modelRef,
                ...(options.secretRef === undefined
                  ? {}
                  : { secretRef: options.secretRef }),
                bindingFingerprint: currentBindingFingerprint,
                inputFrontier: frontier.inputFrontier,
                contextRefs: frontier.contextRefs,
                inputItems: frontier.inputItems,
                ...(yield* loadWorkCompactionPinning()),
                fence: loopStepFence,
                nativeSupported: true,
                nativeRecovery: {
                  manifestJson: candidate.manifestJson,
                  request: frontier.request,
                },
              },
              { providerRuntime, sessions, tx },
            ).pipe(Effect.mapError(failure));
          } else if (
            priorReceipt._tag === "SettledFailure" ||
            priorReceipt._tag === "SettledSuccess" ||
            priorReceipt._tag === "Unsettled"
          ) {
            yield* runSummaryCompaction(
              {
                execution: input.execution,
                logicalStepNo: sourceIdentity.logicalStepNo,
                sourceAgentLoopStep,
                currentEpoch: startupSession.value.contextEpoch,
                modelRef: capability.modelRef,
                ...(options.secretRef === undefined
                  ? {}
                  : { secretRef: options.secretRef }),
                bindingFingerprint: currentBindingFingerprint,
                inputFrontier: frontier.inputFrontier,
                contextRefs: frontier.contextRefs,
                inputItems: frontier.inputItems,
                fence: loopStepFence,
              },
              { providerRuntime, sessions, tx },
            ).pipe(Effect.mapError(failure));
          } else {
            return yield* Effect.fail(
              failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
            );
          }
        }
      }
      if (
        startupCheckpoint?.providerTurnId !== undefined &&
        startupCheckpoint.fromEpoch !== undefined &&
        Option.isSome(startupSession) &&
        startupCheckpoint.toEpoch === Number(startupSession.value.contextEpoch)
      ) {
        const startupNativeTurnId = nativeCompactionProviderTurnId(
          startupCheckpoint.providerTurnId,
        );
        if (startupNativeTurnId === null) {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        const startupManifest = yield* tx
          .transact(providerTurns.findManifestByTurn(startupNativeTurnId))
          .pipe(Effect.mapError(failure));
        if (startupManifest === null) {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        let startupManifestValue: Record<string, unknown>;
        try {
          const parsed = JSON.parse(startupManifest.manifestJson) as unknown;
          if (
            typeof parsed !== "object" ||
            parsed === null ||
            Array.isArray(parsed)
          ) {
            return yield* Effect.fail(
              failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
            );
          }
          startupManifestValue = parsed as Record<string, unknown>;
        } catch {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        const startupSource = startupManifestValue.sourceAgentLoopStep;
        if (
          typeof startupSource !== "object" ||
          startupSource === null ||
          Array.isArray(startupSource)
        ) {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        const startupSourceRecord = startupSource as Record<string, unknown>;
        if (options.qualificationProbe !== undefined) {
          const sourceIdentityValid =
            startupSourceRecord.executionId === input.execution.executionId &&
            Number.isSafeInteger(startupSourceRecord.logicalStepNo) &&
            Number(startupSourceRecord.logicalStepNo) >= 0 &&
            Number.isSafeInteger(startupSourceRecord.repairAttempt) &&
            Number(startupSourceRecord.repairAttempt) >= 0 &&
            typeof startupSourceRecord.providerTurnId === "string";
          const sourceStepOption = sourceIdentityValid
            ? yield* tx
                .transact(
                  loopSteps.find({
                    executionId: input.execution.executionId,
                    logicalStepNo: Number(startupSourceRecord.logicalStepNo),
                    repairAttempt: Number(startupSourceRecord.repairAttempt),
                  }),
                )
                .pipe(Effect.mapError(failure))
            : Option.none();
          const sourceStep = Option.isSome(sourceStepOption)
            ? sourceStepOption.value
            : undefined;
          const sourceLinkOption = yield* tx
            .transact(
              loopSteps.findProviderTurnLinkByProviderTurnId(
                startupNativeTurnId,
              ),
            )
            .pipe(Effect.mapError(failure));
          const startupReceipt = yield* tx
            .transact(providerTurns.findSettledResult(startupNativeTurnId))
            .pipe(Effect.mapError(failure));
          let startupRequestValue: Record<string, unknown> | undefined;
          try {
            const parsed = JSON.parse(
              startupManifest.portableRequestJson,
            ) as unknown;
            if (
              typeof parsed === "object" &&
              parsed !== null &&
              !Array.isArray(parsed)
            ) {
              startupRequestValue = parsed as Record<string, unknown>;
            }
          } catch {
            startupRequestValue = undefined;
          }
          const frontierValue = startupManifestValue.inputFrontier;
          const frontierRecord =
            typeof frontierValue === "object" &&
            frontierValue !== null &&
            !Array.isArray(frontierValue)
              ? (frontierValue as Record<string, unknown>)
              : undefined;
          const firstSequence = frontierRecord?.firstSequence;
          const lastSequence = frontierRecord?.lastSequence;
          const contextRefs = startupManifestValue.contextRefs;
          const inputItems = startupRequestValue?.inputItems;
          const frontierValid =
            typeof firstSequence === "number" &&
            Number.isSafeInteger(firstSequence) &&
            firstSequence >= 0 &&
            typeof lastSequence === "number" &&
            Number.isSafeInteger(lastSequence) &&
            lastSequence >= firstSequence &&
            lastSequence < startupCheckpoint.sequence &&
            Array.isArray(contextRefs) &&
            contextRefs.length > 0 &&
            contextRefs.every(
              (ref): ref is string => typeof ref === "string" && ref.length > 0,
            ) &&
            new Set(contextRefs).size === contextRefs.length &&
            Array.isArray(inputItems) &&
            inputItems.length > 0 &&
            !containsNativeCheckpointInput(inputItems);
          const receiptValid =
            startupReceipt._tag === "SettledSuccess" &&
            startupReceipt.evidenceVersion === "provider-success-v1" &&
            startupReceipt.finishReason === "Stop" &&
            startupReceipt.manifestId === startupManifest.manifestId &&
            startupReceipt.manifestJson === startupManifest.manifestJson &&
            startupReceipt.turn.providerTurnId === startupNativeTurnId &&
            startupReceipt.turn.executionId === input.execution.executionId &&
            startupReceipt.turn.sessionId === input.execution.sessionId &&
            startupReceipt.turn.contextEpoch === startupCheckpoint.fromEpoch &&
            startupReceipt.turn.modelRef === capability.modelRef &&
            startupReceipt.turn.outputContractRef ===
              "provider-native-compaction-v1" &&
            startupReceipt.canonicalEvents.filter(
              (event) =>
                event._tag === "ContinuationState" &&
                event.stateRef === startupCheckpoint.opaqueItemRef,
            ).length === 1;
          const startupChecks = {
            checkpoint:
              startupCheckpoint.providerTurnId === startupNativeTurnId &&
              startupCheckpoint.fromEpoch !== undefined &&
              startupCheckpoint.toEpoch === startupCheckpoint.fromEpoch + 1 &&
              startupCheckpoint.toEpoch ===
                Number(startupSession.value.contextEpoch) &&
              startupCheckpoint.opaqueItemRef !== undefined &&
              startupCheckpoint.bindingFingerprint !== undefined &&
              startupCheckpoint.bindingMatches,
            providerTurn:
              startupManifestValue.providerTurnId === startupNativeTurnId,
            execution:
              startupManifestValue.executionId === input.execution.executionId,
            session:
              startupManifestValue.sessionId === input.execution.sessionId,
            source: sourceIdentityValid,
            step: sourceStep !== undefined,
            sourceProviderTurn:
              sourceStep?.providerTurnId === startupSourceRecord.providerTurnId,
            stepState:
              sourceStep !== undefined &&
              (sourceStep.state === "Prepared" ||
                sourceStep.state === "ProviderResultAvailable" ||
                sourceStep.state === "OutputRejected" ||
                sourceStep.state === "OutputAccepted" ||
                sourceStep.state === "ActionsInProgress" ||
                sourceStep.state === "StepEffectsCommitted" ||
                (sourceStep.state === "NextStepReady" &&
                  sourceStep.successor !== undefined)),
            sourceLinkAbsent: !Option.isSome(sourceLinkOption),
            frontier: frontierValid,
            receipt: receiptValid,
            operation:
              startupManifestValue.operationKind === "CompactionNative" &&
              startupManifestValue.outputContractRef ===
                "provider-native-compaction-v1",
            bindingFingerprint:
              startupManifestValue.resolvedModelBindingFingerprint ===
              startupCheckpoint.bindingFingerprint,
            contextEpoch:
              startupManifestValue.contextEpoch === startupCheckpoint.fromEpoch,
            compiledRequestHash:
              startupManifestValue.compiledRequestHash ===
              sha256Hex(startupManifest.portableRequestJson),
          };
          yield* Effect.promise(
            () =>
              options.qualificationProbe?.({
                boundary: "AH19NativeCheckpointRecovery",
                stage: `NativeStartupManifestChecks:${Object.entries(
                  startupChecks,
                )
                  .map(([key, value]) => `${key}=${String(value)}`)
                  .join(",")}`,
                executionId: String(input.execution.executionId),
                providerTurnId: startupNativeTurnId,
              }) ?? Promise.resolve(),
          );
        }
        if (
          startupSourceRecord.executionId !== input.execution.executionId ||
          !Number.isSafeInteger(startupSourceRecord.logicalStepNo) ||
          !Number.isSafeInteger(startupSourceRecord.repairAttempt) ||
          typeof startupSourceRecord.providerTurnId !== "string" ||
          startupManifestValue.providerTurnId !== startupNativeTurnId ||
          startupManifestValue.executionId !== input.execution.executionId ||
          startupManifestValue.sessionId !== input.execution.sessionId ||
          startupManifestValue.contextEpoch !== startupCheckpoint.fromEpoch ||
          startupManifestValue.operationKind !== "CompactionNative" ||
          startupManifestValue.resolvedModelBindingFingerprint !==
            startupCheckpoint.bindingFingerprint ||
          startupManifestValue.compiledRequestHash !==
            sha256Hex(startupManifest.portableRequestJson)
        ) {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        const startupIdentity = {
          executionId: input.execution.executionId,
          logicalStepNo: Number(startupSourceRecord.logicalStepNo),
          repairAttempt: Number(startupSourceRecord.repairAttempt),
        };
        const startupStepOption = yield* tx
          .transact(loopSteps.find(startupIdentity))
          .pipe(Effect.mapError(failure));
        if (!Option.isSome(startupStepOption)) {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        const startupStep = startupStepOption.value;
        if (startupStep.providerTurnId !== startupSourceRecord.providerTurnId) {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        if (
          startupStep.state === "NextStepReady" &&
          startupStep.successor === undefined
        ) {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        if (
          startupStep.state === "Prepared" ||
          startupStep.state === "ProviderResultAvailable" ||
          startupStep.state === "OutputRejected" ||
          startupStep.state === "OutputAccepted" ||
          startupStep.state === "ActionsInProgress"
        ) {
          turn = startupIdentity.logicalStepNo;
          repairAttempt = startupIdentity.repairAttempt;
        } else if (
          startupStep.state === "StepEffectsCommitted" ||
          startupStep.state === "NextStepReady"
        ) {
          if (
            !startupCheckpoint.bindingMatches ||
            startupStep.successor === undefined
          ) {
            // Rebase must settle the persisted checkpoint owner before its
            // successor can inspect the old Native frontier.
            turn = startupIdentity.logicalStepNo;
            repairAttempt = startupIdentity.repairAttempt;
          } else {
            turn = startupStep.successor.logicalStepNo;
            repairAttempt = startupStep.successor.repairAttempt;
          }
        }
        if (options.qualificationProbe !== undefined) {
          yield* Effect.promise(
            () =>
              options.qualificationProbe?.({
                boundary: "AH19NativeCheckpointRecovery",
                stage: `StartupCheckpointCursor:bindingMatches=${startupCheckpoint.bindingMatches}:source=${startupIdentity.logicalStepNo}:repair=${startupIdentity.repairAttempt}:state=${startupStep.state}:successor=${startupStep.successor?.providerTurnId ?? "none"}:cursor=${turn}`,
                executionId: String(input.execution.executionId),
                providerTurnId: startupCheckpoint.providerTurnId ?? "unknown",
              }) ?? Promise.resolve(),
          );
        }
      }
    }
    while (true) {
      const controlBasis = yield* currentControlBasis();
      const providerTurnId =
        overflowReplacementProviderTurnId ??
        (repairAttempt === 0
          ? providerTurnInferenceId(input.execution.executionId, turn)
          : providerTurnRepairInferenceId(
              input.execution.executionId,
              turn,
              repairAttempt,
            ));
      const loopStepIdentity = {
        executionId: input.execution.executionId,
        logicalStepNo: turn,
        repairAttempt,
      } as const;
      let loopStep: AgentLoopStepRecord | undefined;
      if (loopSteps !== undefined && loopStepFence !== undefined) {
        loopStep = yield* tx
          .transact(
            Effect.gen(function* () {
              const existing = yield* loopSteps.find(loopStepIdentity);
              if (Option.isSome(existing)) return existing.value;
              return yield* loopSteps.createPrepared(
                {
                  identity: loopStepIdentity,
                  providerTurnId,
                  state: "Prepared",
                  nextActionIndex: 0,
                  revision: 0,
                  updatedAt: yield* now(),
                },
                loopStepFence,
              );
            }),
          )
          .pipe(Effect.mapError(failure));
        if (loopStep.state === "OutputRejected") {
          const settlement = decodeExhaustedRepairDisposition(
            loopStep.repairDisposition,
          );
          if (
            settlement === undefined ||
            loopStep.successor !== undefined ||
            loopStep.providerTurnId !== providerTurnId ||
            loopStep.identity.logicalStepNo !== turn ||
            loopStep.identity.repairAttempt !== repairAttempt
          ) {
            return yield* Effect.fail(
              failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
            );
          }
          const exhaustedStep = loopStep;
          loopStep = yield* tx
            .transact(
              loopSteps.transition(
                {
                  identity: exhaustedStep.identity,
                  expectedRevision: exhaustedStep.revision,
                  expectedState: "OutputRejected",
                  next: {
                    ...exhaustedStep,
                    state: "SettlementProposed",
                    settlement,
                    revision: exhaustedStep.revision + 1,
                    updatedAt: yield* now(),
                  },
                },
                loopStepFence,
              ),
            )
            .pipe(Effect.mapError(failure));
          return { _tag: "Settle", settlement };
        }
        if (
          overflowRecoveryAttempt === 0 &&
          loopStep.state === "Prepared" &&
          providerTurns !== undefined &&
          resumeOverflowCompactionProviderTurnId === undefined
        ) {
          const activeLoopStep = loopStep;
          // Overflow recovery is relevant only when the original inference
          // already has durable ContextLimitExceeded failure evidence. This
          // keeps ordinary Prepared steps from requiring the v1.23 chain
          // table, while a real overflow with missing chain storage still
          // fails closed when the chain read below is attempted.
          const originalInference = yield* tx
            .transact(providerTurns.findSettledResult(loopStep.providerTurnId))
            .pipe(Effect.mapError(failure));
          if (
            originalInference._tag === "SettledFailure" &&
            originalInference.failureKind === "ContextLimitExceeded"
          ) {
            const providerTurnLinks = yield* tx
              .transact(loopSteps.listProviderTurnLinks(loopStepIdentity))
              .pipe(Effect.mapError(failure));
            const inferenceLinks = providerTurnLinks.filter(
              (link) => link.role === "Inference",
            );
            const compactionLinks = providerTurnLinks.filter(
              (link) => link.role === "OverflowCompaction",
            );
            const replacementLinks = providerTurnLinks.filter(
              (link) => link.role === "OverflowReplacement",
            );
            if (isConversationResponseExecution) {
              if (
                dependencies.conversationCheckpoints === undefined ||
                loopStepFence === undefined
              ) {
                return yield* Effect.fail(
                  failure({
                    _tag: "ConversationCheckpointRuntimeUnavailable",
                  }),
                );
              }
              const ownerOption = yield* tx
                .transact(
                  dependencies.conversationCheckpoints.findOwner(
                    input.execution.workspaceId,
                  ),
                )
                .pipe(Effect.mapError(failure));
              const owner = Option.isSome(ownerOption)
                ? ownerOption.value
                : undefined;
              const ownerEpoch = Number(owner?.contextEpoch ?? 0);
              const inference = originalInference.turn;
              if (
                inference.providerTurnId !== loopStep.providerTurnId ||
                inference.executionId !== input.execution.executionId ||
                inference.sessionId !== input.execution.sessionId ||
                inference.modelRef !== capability.modelRef ||
                ownerEpoch < Number(inference.contextEpoch) ||
                ownerEpoch > Number(inference.contextEpoch) + 1
              ) {
                return yield* Effect.fail(
                  failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                );
              }
              const nativeSupported =
                capability.portableRequestCompatibility?.operationKinds.includes(
                  "CompactionNative",
                ) === true;
              let linkedCompactionProviderTurnId: ProviderTurnId;
              if (providerTurnLinks.length === 0) {
                if (ownerEpoch !== Number(inference.contextEpoch)) {
                  return yield* Effect.fail(
                    failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                  );
                }
                const compactionProviderTurnId = nativeSupported
                  ? providerTurnNativeCompactionId(
                      input.execution.executionId,
                      turn,
                      inference.contextEpoch,
                    )
                  : providerTurnSummaryCompactionId(
                      input.execution.executionId,
                      turn,
                      inference.contextEpoch,
                    );
                const [compactionReceipt, replacementReceipt] =
                  yield* Effect.all(
                    [
                      tx.transact(
                        providerTurns.findSettledResult(
                          compactionProviderTurnId,
                        ),
                      ),
                      tx.transact(
                        providerTurns.findSettledResult(
                          makeOverflowReplacementProviderTurnId(
                            input.execution.executionId,
                            turn,
                          ),
                        ),
                      ),
                    ],
                    { concurrency: 1 },
                  ).pipe(Effect.mapError(failure));
                if (
                  compactionReceipt._tag !== "NotFound" ||
                  replacementReceipt._tag !== "NotFound"
                ) {
                  return yield* Effect.fail(
                    failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                  );
                }
                linkedCompactionProviderTurnId = compactionProviderTurnId;
                yield* tx
                  .transact(
                    Effect.gen(function* () {
                      const createdAt = yield* now();
                      yield* loopSteps.ensureProviderTurnLink(
                        {
                          identity: loopStepIdentity,
                          overflowOrdinal: 0,
                          role: "Inference",
                          providerTurnId: activeLoopStep.providerTurnId,
                          contextEpoch: inference.contextEpoch,
                          state: "SettledFailure",
                          createdAt,
                        },
                        loopStepFence,
                      );
                      yield* loopSteps.ensureProviderTurnLink(
                        {
                          identity: loopStepIdentity,
                          overflowOrdinal: 0,
                          role: "OverflowCompaction",
                          providerTurnId: compactionProviderTurnId,
                          predecessorProviderTurnId:
                            activeLoopStep.providerTurnId,
                          contextEpoch: inference.contextEpoch,
                          state: "Prepared",
                          createdAt,
                        },
                        loopStepFence,
                      );
                    }),
                  )
                  .pipe(Effect.mapError(failure));
              } else {
                const inferenceLink = inferenceLinks[0];
                const compactionLink = compactionLinks[0];
                if (
                  (providerTurnLinks.length !== 2 &&
                    providerTurnLinks.length !== 3) ||
                  replacementLinks.length > 1 ||
                  inferenceLinks.length !== 1 ||
                  compactionLinks.length !== 1 ||
                  inferenceLink === undefined ||
                  compactionLink === undefined ||
                  !isValidOverflowCompactionLinkPair(
                    providerTurnLinks,
                    loopStep.providerTurnId,
                    [
                      providerTurnSummaryCompactionId(
                        input.execution.executionId,
                        turn,
                        inference.contextEpoch,
                      ),
                      providerTurnNativeCompactionId(
                        input.execution.executionId,
                        turn,
                        inference.contextEpoch,
                      ),
                    ],
                  ) ||
                  Number(compactionLink.contextEpoch) !==
                    Number(inference.contextEpoch)
                ) {
                  return yield* Effect.fail(
                    failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                  );
                }
                linkedCompactionProviderTurnId = compactionLink.providerTurnId;
              }
              if (ownerEpoch === Number(inference.contextEpoch) + 1) {
                if (
                  owner?.producerProviderTurnId !==
                    linkedCompactionProviderTurnId ||
                  owner.producerExecutionId !== input.execution.executionId
                ) {
                  return yield* Effect.fail(
                    failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                  );
                }
                const replacementProviderTurnId =
                  makeOverflowReplacementProviderTurnId(
                    input.execution.executionId,
                    turn,
                  );
                const existingReplacement = replacementLinks[0];
                if (
                  existingReplacement !== undefined &&
                  (existingReplacement.providerTurnId !==
                    replacementProviderTurnId ||
                    existingReplacement.predecessorProviderTurnId !==
                      linkedCompactionProviderTurnId ||
                    Number(existingReplacement.contextEpoch) !== ownerEpoch)
                ) {
                  return yield* Effect.fail(
                    failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                  );
                }
                yield* tx
                  .transact(
                    loopSteps.ensureProviderTurnLink(
                      {
                        identity: loopStepIdentity,
                        overflowOrdinal: 0,
                        role: "OverflowReplacement",
                        providerTurnId: replacementProviderTurnId,
                        predecessorProviderTurnId:
                          linkedCompactionProviderTurnId,
                        contextEpoch: owner.contextEpoch,
                        state: "Prepared",
                        createdAt: yield* now(),
                      },
                      loopStepFence,
                    ),
                  )
                  .pipe(Effect.mapError(failure));
                overflowReplacementProviderTurnId = replacementProviderTurnId;
                overflowRecoveryAttempt = 1;
                continue;
              }
              if (ownerEpoch !== Number(inference.contextEpoch)) {
                return yield* Effect.fail(
                  failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                );
              }
              if (replacementLinks.length !== 0) {
                return yield* Effect.fail(
                  failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                );
              }
              const compactionManifest = yield* tx
                .transact(
                  providerTurns.findManifestByTurn(
                    linkedCompactionProviderTurnId,
                  ),
                )
                .pipe(Effect.mapError(failure));
              const compactionReceipt = yield* tx
                .transact(
                  providerTurns.findSettledResult(
                    linkedCompactionProviderTurnId,
                  ),
                )
                .pipe(Effect.mapError(failure));
              const existingContract =
                compactionReceipt._tag === "Unsettled" ||
                compactionReceipt._tag === "SettledSuccess" ||
                compactionReceipt._tag === "SettledFailure"
                  ? compactionReceipt.turn.outputContractRef
                  : undefined;
              if (
                compactionManifest !== null &&
                compactionReceipt._tag === "NotFound"
              ) {
                return yield* Effect.fail(
                  failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                );
              }
              resumeOverflowNativeCompaction =
                existingContract === "provider-native-compaction-v1" ||
                (existingContract === undefined && nativeSupported);
              resumeOverflowCompactionProviderTurnId =
                linkedCompactionProviderTurnId;
              replayPersistedContextLimit = true;
              continue;
            }
            if (providerTurnLinks.length === 0) {
              const inference = originalInference.turn;
              const nativeSupported =
                capability.portableRequestCompatibility?.operationKinds.includes(
                  "CompactionNative",
                ) === true;
              const compactionProviderTurnId = nativeSupported
                ? providerTurnNativeCompactionId(
                    input.execution.executionId,
                    turn,
                    inference.contextEpoch,
                  )
                : providerTurnSummaryCompactionId(
                    input.execution.executionId,
                    turn,
                    inference.contextEpoch,
                  );
              const replacementProviderTurnId =
                makeOverflowReplacementProviderTurnId(
                  input.execution.executionId,
                  turn,
                );
              const currentSession = yield* tx
                .transact(sessions.findById(input.execution.sessionId))
                .pipe(Effect.mapError(failure));
              if (
                inference.providerTurnId !== loopStep.providerTurnId ||
                inference.executionId !== input.execution.executionId ||
                inference.sessionId !== input.execution.sessionId ||
                inference.modelRef !== capability.modelRef ||
                Option.isNone(currentSession) ||
                currentSession.value.contextEpoch !== inference.contextEpoch
              ) {
                return yield* Effect.fail(
                  failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                );
              }
              const [compactionReceipt, replacementReceipt] = yield* Effect.all(
                [
                  tx.transact(
                    providerTurns.findSettledResult(compactionProviderTurnId),
                  ),
                  tx.transact(
                    providerTurns.findSettledResult(replacementProviderTurnId),
                  ),
                ],
                { concurrency: 1 },
              ).pipe(Effect.mapError(failure));
              if (
                compactionReceipt._tag !== "NotFound" ||
                replacementReceipt._tag !== "NotFound"
              ) {
                return yield* Effect.fail(
                  failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                );
              }
              yield* tx
                .transact(
                  Effect.gen(function* () {
                    const createdAt = yield* now();
                    yield* loopSteps.ensureProviderTurnLink(
                      {
                        identity: loopStepIdentity,
                        overflowOrdinal: 0,
                        role: "Inference",
                        providerTurnId: activeLoopStep.providerTurnId,
                        contextEpoch: inference.contextEpoch,
                        state: "SettledFailure",
                        createdAt,
                      },
                      loopStepFence,
                    );
                    yield* loopSteps.ensureProviderTurnLink(
                      {
                        identity: loopStepIdentity,
                        overflowOrdinal: 0,
                        role: "OverflowCompaction",
                        providerTurnId: compactionProviderTurnId,
                        predecessorProviderTurnId:
                          activeLoopStep.providerTurnId,
                        contextEpoch: inference.contextEpoch,
                        state: "Prepared",
                        createdAt,
                      },
                      loopStepFence,
                    );
                  }),
                )
                .pipe(Effect.mapError(failure));
              replayPersistedContextLimit = true;
            } else {
              if (inferenceLinks.length > 0 || compactionLinks.length > 0) {
                const inferenceLink = inferenceLinks[0];
                const compactionLink = compactionLinks[0];
                if (
                  inferenceLink === undefined ||
                  compactionLink === undefined ||
                  !isValidOverflowCompactionLinkPair(
                    providerTurnLinks,
                    loopStep.providerTurnId,
                    [
                      providerTurnSummaryCompactionId(
                        input.execution.executionId,
                        turn,
                        compactionLink.contextEpoch,
                      ),
                      providerTurnNativeCompactionId(
                        input.execution.executionId,
                        turn,
                        compactionLink.contextEpoch,
                      ),
                    ],
                  )
                ) {
                  return yield* Effect.fail(
                    failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                  );
                }
                const [
                  inferenceReceipt,
                  compactionReceipt,
                  compactionManifest,
                ] = yield* Effect.all(
                  [
                    tx.transact(
                      providerTurns.findSettledResult(
                        inferenceLink.providerTurnId,
                      ),
                    ),
                    tx.transact(
                      providerTurns.findSettledResult(
                        compactionLink.providerTurnId,
                      ),
                    ),
                    tx.transact(
                      providerTurns.findManifestByTurn(
                        compactionLink.providerTurnId,
                      ),
                    ),
                  ],
                  { concurrency: 1 },
                ).pipe(Effect.mapError(failure));
                if (
                  inferenceReceipt._tag !== "SettledFailure" ||
                  inferenceReceipt.failureKind !== "ContextLimitExceeded" ||
                  inferenceReceipt.turn.executionId !==
                    input.execution.executionId ||
                  inferenceReceipt.turn.sessionId !==
                    input.execution.sessionId ||
                  inferenceReceipt.turn.contextEpoch !==
                    inferenceLink.contextEpoch
                ) {
                  return yield* Effect.fail(
                    failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                  );
                }
                if (
                  compactionReceipt._tag === "NotFound" ||
                  compactionReceipt._tag === "Unsettled"
                ) {
                  const existingCompactionTurn =
                    compactionReceipt._tag === "Unsettled"
                      ? compactionReceipt.turn
                      : undefined;
                  const existingNativeCompaction =
                    existingCompactionTurn?.outputContractRef ===
                    "provider-native-compaction-v1";
                  const currentSession = yield* tx
                    .transact(sessions.findById(input.execution.sessionId))
                    .pipe(Effect.mapError(failure));
                  if (
                    (compactionReceipt._tag === "NotFound" &&
                      compactionManifest !== null) ||
                    (existingCompactionTurn !== undefined &&
                      (existingCompactionTurn.providerTurnId !==
                        compactionLink.providerTurnId ||
                        existingCompactionTurn.executionId !==
                          input.execution.executionId ||
                        existingCompactionTurn.sessionId !==
                          input.execution.sessionId ||
                        existingCompactionTurn.contextEpoch !==
                          compactionLink.contextEpoch ||
                        existingCompactionTurn.modelRef !==
                          capability.modelRef ||
                        existingCompactionTurn.outputContractRef !==
                          (existingNativeCompaction
                            ? "provider-native-compaction-v1"
                            : "compaction-result-v1") ||
                        compactionManifest === null)) ||
                    Option.isNone(currentSession) ||
                    Number(currentSession.value.contextEpoch) !==
                      Number(compactionLink.contextEpoch)
                  ) {
                    return yield* Effect.fail(
                      failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                    );
                  }
                  if (existingNativeCompaction) {
                    const nativeFrontier =
                      compactionManifest === null
                        ? null
                        : decodeUniqueNativePortableFrontier(
                            compactionManifest.manifestJson,
                            compactionManifest.portableRequestJson,
                          );
                    const nativeManifest = nativeFrontier?.manifest;
                    if (
                      nativeFrontier === null ||
                      nativeManifest === undefined ||
                      compactionReceipt._tag !== "Unsettled" ||
                      compactionManifest === null ||
                      nativeManifest.providerTurnId !==
                        compactionLink.providerTurnId ||
                      nativeManifest.executionId !==
                        input.execution.executionId ||
                      nativeManifest.sessionId !== input.execution.sessionId ||
                      nativeManifest.contextEpoch !==
                        compactionLink.contextEpoch ||
                      nativeManifest.operationKind !== "CompactionNative" ||
                      nativeManifest.logicalStepNo !== turn ||
                      nativeManifest.modelRef !== capability.modelRef ||
                      nativeManifest.outputContractRef !==
                        "provider-native-compaction-v1" ||
                      nativeManifest.resolvedModelBindingFingerprint !==
                        currentBindingFingerprint ||
                      nativeFrontier.request.modelRef !== capability.modelRef
                    ) {
                      return yield* Effect.fail(
                        failure({
                          _tag: "AgentLoopStepReplayBindingMismatch",
                        }),
                      );
                    }
                    resumeOverflowNativeCompaction = true;
                    resumeOverflowNativeCompactionInput = {
                      manifestJson: compactionManifest.manifestJson,
                      request: nativeFrontier.request,
                    };
                  }
                  // The committed link pins the exact Summary ProviderTurn.
                  // Rebuild the same canonical input later in this model
                  // decision, after the projection and step context exist.
                  resumeOverflowCompactionProviderTurnId =
                    compactionLink.providerTurnId;
                } else if (
                  compactionReceipt._tag === "SettledSuccess" &&
                  compactionReceipt.turn.outputContractRef ===
                    "provider-native-compaction-v1"
                ) {
                  if (
                    compactionReceipt.evidenceVersion !==
                      "provider-success-v1" ||
                    compactionReceipt.finishReason !== "Stop" ||
                    compactionReceipt.turn.providerTurnId !==
                      compactionLink.providerTurnId ||
                    compactionReceipt.turn.executionId !==
                      input.execution.executionId ||
                    compactionReceipt.turn.sessionId !==
                      input.execution.sessionId ||
                    compactionReceipt.turn.contextEpoch !==
                      compactionLink.contextEpoch ||
                    compactionManifest === null ||
                    compactionManifest.manifestJson !==
                      compactionReceipt.manifestJson
                  ) {
                    return yield* Effect.fail(
                      failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                    );
                  }
                  let nativeManifest: Record<string, unknown>;
                  try {
                    const manifest = JSON.parse(
                      compactionManifest.manifestJson,
                    ) as unknown;
                    if (
                      typeof manifest !== "object" ||
                      manifest === null ||
                      Array.isArray(manifest)
                    ) {
                      return yield* Effect.fail(
                        failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                      );
                    }
                    nativeManifest = manifest as Record<string, unknown>;
                  } catch {
                    return yield* Effect.fail(
                      failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                    );
                  }
                  const nativeFrontier = decodeUniqueNativePortableFrontier(
                    compactionManifest.manifestJson,
                    compactionManifest.portableRequestJson,
                  );
                  if (
                    nativeFrontier === null &&
                    portableRequestHasNativeCheckpoint(
                      compactionManifest.portableRequestJson,
                    ) &&
                    options.qualificationProbe !== undefined
                  ) {
                    yield* Effect.promise(
                      () =>
                        options.qualificationProbe?.({
                          boundary: "AH19NativeCheckpointRecovery",
                          stage: "NestedNativeFrontierRejected",
                          executionId: String(input.execution.executionId),
                          providerTurnId: String(compactionLink.providerTurnId),
                        }) ?? Promise.resolve(),
                    );
                  }
                  const nativeContinuationStates =
                    compactionReceipt.canonicalEvents.filter(
                      (event) => event._tag === "ContinuationState",
                    );
                  if (
                    nativeFrontier === null ||
                    nativeManifest.providerTurnId !==
                      compactionLink.providerTurnId ||
                    nativeManifest.executionId !==
                      input.execution.executionId ||
                    nativeManifest.sessionId !== input.execution.sessionId ||
                    nativeManifest.contextEpoch !==
                      compactionLink.contextEpoch ||
                    nativeManifest.operationKind !== "CompactionNative" ||
                    nativeManifest.logicalStepNo !== turn ||
                    typeof nativeManifest.modelRef !== "string" ||
                    typeof nativeManifest.resolvedModelBindingFingerprint !==
                      "string" ||
                    !/^p16fp_[0-9a-f]{64}$/u.test(
                      nativeManifest.resolvedModelBindingFingerprint,
                    ) ||
                    nativeFrontier.request.modelRef !==
                      nativeManifest.modelRef ||
                    nativeContinuationStates.length !== 1 ||
                    nativeContinuationStates[0]?._tag !== "ContinuationState"
                  ) {
                    return yield* Effect.fail(
                      failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                    );
                  }
                  const nativeStateRef = nativeContinuationStates[0].stateRef;
                  const currentSession = yield* tx
                    .transact(sessions.findById(input.execution.sessionId))
                    .pipe(Effect.mapError(failure));
                  if (Option.isNone(currentSession)) {
                    return yield* Effect.fail(
                      failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                    );
                  }
                  const currentEpoch = Number(
                    currentSession.value.contextEpoch,
                  );
                  const compactionEpoch = Number(compactionLink.contextEpoch);
                  if (
                    currentEpoch !== compactionEpoch &&
                    currentEpoch !== compactionEpoch + 1
                  ) {
                    return yield* Effect.fail(
                      failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                    );
                  }
                  const recentEntries = yield* tx
                    .transact(readExecutionTimeline())
                    .pipe(Effect.mapError(failure));
                  const nativeCheckpointEntries = recentEntries.filter(
                    (entry) =>
                      entry.source?.kind === "CompactionTurn" &&
                      entry.source.ref === compactionLink.providerTurnId &&
                      typeof entry.payload === "object" &&
                      entry.payload !== null &&
                      (entry.payload as { readonly _tag?: unknown })._tag ===
                        "CompactionCheckpoint" &&
                      (entry.payload as { readonly implementation?: unknown })
                        .implementation === "ProviderNative",
                  );
                  if (
                    (currentEpoch === compactionEpoch &&
                      nativeCheckpointEntries.length !== 0) ||
                    (currentEpoch === compactionEpoch + 1 &&
                      (nativeCheckpointEntries.length !== 1 ||
                        (
                          nativeCheckpointEntries[0]?.payload as
                            | Record<string, unknown>
                            | undefined
                        )?.opaqueItemRef !== nativeStateRef ||
                        (
                          nativeCheckpointEntries[0]?.payload as
                            | Record<string, unknown>
                            | undefined
                        )?.bindingFingerprint !==
                          nativeManifest.resolvedModelBindingFingerprint))
                  ) {
                    return yield* Effect.fail(
                      failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                    );
                  }
                  const bindingMatches =
                    providerNativeSupported &&
                    nativeManifest.resolvedModelBindingFingerprint ===
                      currentBindingFingerprint;
                  if (
                    !bindingMatches &&
                    options.qualificationProbe !== undefined
                  ) {
                    yield* Effect.promise(
                      () =>
                        options.qualificationProbe?.({
                          boundary: "AH19NativeCheckpointRecovery",
                          stage: "SettledNativeReceiptBindingMismatch",
                          executionId: String(input.execution.executionId),
                          providerTurnId: String(compactionLink.providerTurnId),
                        }) ?? Promise.resolve(),
                    );
                  }
                  const replacementProviderTurnId =
                    makeOverflowReplacementProviderTurnId(
                      input.execution.executionId,
                      turn,
                    );
                  let replacementEpoch: number;
                  if (bindingMatches) {
                    if (currentEpoch === compactionEpoch) {
                      const committed = yield* commitRecoveredNativeCompaction(
                        {
                          execution: input.execution,
                          providerTurnId: compactionLink.providerTurnId,
                          expectedEpoch: compactionLink.contextEpoch,
                          bindingFingerprint: currentBindingFingerprint,
                          opaqueItemRef: nativeStateRef,
                          fence: loopStepFence,
                        },
                        {
                          sessions,
                          tx,
                          ...(options.qualificationProbe === undefined
                            ? {}
                            : {
                                qualificationProbe: options.qualificationProbe,
                              }),
                        },
                      ).pipe(Effect.mapError(failure));
                      replacementEpoch = Number(committed.newEpoch);
                    } else {
                      replacementEpoch = compactionEpoch + 1;
                    }
                  } else if (currentEpoch === compactionEpoch) {
                    const compacted = yield* runSummaryCompaction(
                      {
                        execution: input.execution,
                        logicalStepNo: compactionLink.identity.logicalStepNo,
                        sourceAgentLoopStep: {
                          executionId: String(
                            compactionLink.identity.executionId,
                          ),
                          logicalStepNo: compactionLink.identity.logicalStepNo,
                          repairAttempt: compactionLink.identity.repairAttempt,
                          providerTurnId: String(
                            compactionLink.predecessorProviderTurnId,
                          ),
                        },
                        currentEpoch: compactionLink.contextEpoch,
                        modelRef: capability.modelRef,
                        ...(options.secretRef === undefined
                          ? {}
                          : { secretRef: options.secretRef }),
                        bindingFingerprint: currentBindingFingerprint,
                        inputFrontier: nativeFrontier.inputFrontier,
                        contextRefs: nativeFrontier.contextRefs,
                        inputItems: nativeFrontier.inputItems,
                        ...(yield* loadWorkCompactionPinning()),
                        fence: loopStepFence,
                      },
                      {
                        providerRuntime,
                        sessions,
                        tx,
                        ...(options.qualificationProbe === undefined
                          ? {}
                          : {
                              qualificationProbe: options.qualificationProbe,
                            }),
                      },
                    ).pipe(Effect.mapError(failure));
                    replacementEpoch = Number(compacted.newEpoch);
                  } else {
                    // The checkpoint already committed in the prior
                    // deployment. The Session projector below reconstructs
                    // the exact portable frontier and commits the rebase.
                    replacementEpoch = Number.NaN;
                  }
                  if (Number.isFinite(replacementEpoch)) {
                    if (
                      replacementEpoch !==
                      currentEpoch + (currentEpoch === compactionEpoch ? 1 : 0)
                    ) {
                      return yield* Effect.fail(
                        failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                      );
                    }
                    const existingReplacement = providerTurnLinks.filter(
                      (link) => link.role === "OverflowReplacement",
                    );
                    if (existingReplacement.length > 1) {
                      return yield* Effect.fail(
                        failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                      );
                    }
                    const existingReplacementLink = existingReplacement[0];
                    if (existingReplacementLink !== undefined) {
                      if (
                        existingReplacementLink.providerTurnId !==
                          replacementProviderTurnId ||
                        existingReplacementLink.predecessorProviderTurnId !==
                          compactionLink.providerTurnId ||
                        Number(existingReplacementLink.contextEpoch) !==
                          replacementEpoch
                      ) {
                        return yield* Effect.fail(
                          failure({
                            _tag: "AgentLoopStepReplayBindingMismatch",
                          }),
                        );
                      }
                    } else {
                      yield* tx
                        .transact(
                          loopSteps.ensureProviderTurnLink(
                            {
                              identity: loopStepIdentity,
                              overflowOrdinal: 0,
                              role: "OverflowReplacement",
                              providerTurnId: replacementProviderTurnId,
                              predecessorProviderTurnId:
                                compactionLink.providerTurnId,
                              contextEpoch:
                                parse(ContextEpochNumber)(replacementEpoch),
                              state: "Prepared",
                              createdAt: yield* now(),
                            },
                            loopStepFence,
                          ),
                        )
                        .pipe(Effect.mapError(failure));
                    }
                    overflowRecoveryAttempt = 1;
                    overflowReplacementProviderTurnId =
                      replacementProviderTurnId;
                    continue;
                  }
                } else if (compactionReceipt._tag === "SettledSuccess") {
                  if (
                    compactionReceipt.evidenceVersion !==
                      "provider-success-v1" ||
                    compactionReceipt.finishReason !== "Stop" ||
                    compactionReceipt.turn.providerTurnId !==
                      compactionLink.providerTurnId ||
                    compactionReceipt.turn.executionId !==
                      input.execution.executionId ||
                    compactionReceipt.turn.sessionId !==
                      input.execution.sessionId ||
                    compactionReceipt.turn.contextEpoch !==
                      compactionLink.contextEpoch ||
                    compactionReceipt.turn.modelRef !== capability.modelRef ||
                    compactionReceipt.turn.outputContractRef !==
                      "compaction-result-v1" ||
                    compactionManifest === null ||
                    compactionManifest.manifestJson !==
                      compactionReceipt.manifestJson
                  ) {
                    return yield* Effect.fail(
                      failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                    );
                  }
                  let persistedManifest: Record<string, unknown>;
                  let persistedRequest: Record<string, unknown>;
                  try {
                    const manifest = JSON.parse(
                      compactionManifest.manifestJson,
                    ) as unknown;
                    const request = JSON.parse(
                      compactionManifest.portableRequestJson,
                    ) as unknown;
                    if (
                      typeof manifest !== "object" ||
                      manifest === null ||
                      Array.isArray(manifest) ||
                      typeof request !== "object" ||
                      request === null ||
                      Array.isArray(request)
                    ) {
                      return yield* Effect.fail(
                        failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                      );
                    }
                    persistedManifest = manifest as Record<string, unknown>;
                    persistedRequest = request as Record<string, unknown>;
                  } catch {
                    return yield* Effect.fail(
                      failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                    );
                  }
                  const recoveryBindingFingerprint = currentBindingFingerprint;
                  if (
                    persistedManifest.providerTurnId !==
                      compactionLink.providerTurnId ||
                    persistedManifest.executionId !==
                      input.execution.executionId ||
                    persistedManifest.sessionId !== input.execution.sessionId ||
                    persistedManifest.contextEpoch !==
                      compactionLink.contextEpoch ||
                    persistedManifest.modelRef !== capability.modelRef ||
                    persistedManifest.outputContractRef !==
                      "compaction-result-v1" ||
                    persistedManifest.operationKind !== "CompactionSummary" ||
                    persistedManifest.logicalStepNo !== turn ||
                    persistedManifest.resolvedModelBindingFingerprint !==
                      recoveryBindingFingerprint ||
                    persistedManifest.compiledRequestHash !==
                      sha256Hex(compactionManifest.portableRequestJson) ||
                    persistedRequest.operationKind !== "CompactionSummary" ||
                    persistedRequest.modelRef !== capability.modelRef ||
                    persistedRequest.outputContractRef !==
                      "compaction-result-v1"
                  ) {
                    return yield* Effect.fail(
                      failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                    );
                  }
                  const summary = compactionReceipt.canonicalEvents
                    .flatMap((event) =>
                      event._tag === "TextDelta" ? [event.text] : [],
                    )
                    .join("")
                    .trim();
                  if (summary.length === 0) {
                    return yield* Effect.fail(
                      failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                    );
                  }
                  const currentSession = yield* tx
                    .transact(sessions.findById(input.execution.sessionId))
                    .pipe(Effect.mapError(failure));
                  if (
                    Option.isNone(currentSession) ||
                    (currentSession.value.contextEpoch !==
                      compactionLink.contextEpoch &&
                      Number(currentSession.value.contextEpoch) !==
                        Number(compactionLink.contextEpoch) + 1)
                  ) {
                    return yield* Effect.fail(
                      failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                    );
                  }
                  yield* commitRecoveredSummaryCompaction(
                    {
                      execution: input.execution,
                      providerTurnId: compactionLink.providerTurnId,
                      expectedEpoch: compactionLink.contextEpoch,
                      bindingFingerprint: recoveryBindingFingerprint,
                      summary,
                      fence: loopStepFence,
                    },
                    {
                      sessions,
                      tx,
                      ...(options.qualificationProbe === undefined
                        ? {}
                        : { qualificationProbe: options.qualificationProbe }),
                    },
                  ).pipe(Effect.mapError(failure));
                  const replacementLinks = providerTurnLinks.filter(
                    (link) => link.role === "OverflowReplacement",
                  );
                  const replacementProviderTurnId =
                    makeOverflowReplacementProviderTurnId(
                      input.execution.executionId,
                      turn,
                    );
                  if (replacementLinks.length > 1) {
                    return yield* Effect.fail(
                      failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                    );
                  }
                  const existingReplacement = replacementLinks[0];
                  if (existingReplacement !== undefined) {
                    if (
                      existingReplacement.providerTurnId !==
                        replacementProviderTurnId ||
                      existingReplacement.predecessorProviderTurnId !==
                        compactionLink.providerTurnId ||
                      Number(existingReplacement.contextEpoch) !==
                        Number(compactionLink.contextEpoch) + 1
                    ) {
                      return yield* Effect.fail(
                        failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                      );
                    }
                  } else {
                    yield* tx
                      .transact(
                        loopSteps.ensureProviderTurnLink(
                          {
                            identity: loopStepIdentity,
                            overflowOrdinal: 0,
                            role: "OverflowReplacement",
                            providerTurnId: replacementProviderTurnId,
                            predecessorProviderTurnId:
                              compactionLink.providerTurnId,
                            contextEpoch: parse(ContextEpochNumber)(
                              Number(compactionLink.contextEpoch) + 1,
                            ),
                            state: "Prepared",
                            createdAt: yield* now(),
                          },
                          loopStepFence,
                        ),
                      )
                      .pipe(Effect.mapError(failure));
                  }
                  // The settled Summary receipt has been promoted to the exact
                  // replacement checkpoint. The next loop iteration is pinned
                  // to that replacement ProviderTurn, not the failed Inference.
                  overflowRecoveryAttempt = 1;
                  overflowReplacementProviderTurnId = replacementProviderTurnId;
                  continue;
                } else {
                  return yield* Effect.fail(
                    failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                  );
                }
              }
            }
          }
        }
        if (
          loopStep.state === "SettlementProposed" &&
          loopStep.settlement !== undefined
        ) {
          return {
            _tag: "Settle",
            settlement: loopStep.settlement,
          };
        }
      }
      const proposeSettlement = (
        settlement: ExecutionSettlement,
      ): Effect.Effect<ModelDecisionOutcome, ExecutionDriverError> =>
        Effect.gen(function* () {
          if (
            loopStep !== undefined &&
            loopSteps !== undefined &&
            loopStepFence !== undefined &&
            loopStep.state === "Prepared"
          ) {
            const preparedStep = loopStep;
            if (
              settlement._tag === "Failed" &&
              options.qualificationProbe !== undefined
            ) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "AH4BeforeSettlementProposal",
                    providerTurnId,
                  }) ?? Promise.resolve(),
              );
            }
            loopStep = yield* tx
              .transact(
                Effect.gen(function* () {
                  if (
                    settlement._tag === "Failed" &&
                    settlement.failure.reason.startsWith("ProviderFailure:") &&
                    providerTurns !== undefined
                  ) {
                    const dangling =
                      yield* providerTurns.findUnsettledByTurn(providerTurnId);
                    if (dangling !== null) {
                      yield* providerTurns.failTurn(
                        providerTurnId,
                        yield* now(),
                      );
                    }
                  }
                  return yield* loopSteps.transition(
                    {
                      identity: preparedStep.identity,
                      expectedRevision: preparedStep.revision,
                      expectedState: "Prepared",
                      next: {
                        ...preparedStep,
                        state: "SettlementProposed",
                        settlement,
                        revision: preparedStep.revision + 1,
                        updatedAt: yield* now(),
                      },
                    },
                    loopStepFence,
                  );
                }),
              )
              .pipe(Effect.mapError(failure));
            if (
              settlement._tag === "Failed" &&
              options.qualificationProbe !== undefined
            ) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "AH4AfterSettlementProposal",
                    providerTurnId,
                  }) ?? Promise.resolve(),
              );
            }
          }
          return { _tag: "Settle", settlement };
        });
      // EGP: only an exact ConversationResponseEpisode can open conversation
      // history. A generic Workspace execution never implies conversation.
      const conversationMessages: Array<{
        readonly role: "user" | "assistant";
        readonly text: string;
      }> = [];
      const conversationContextRefs: Array<string> = [];
      const conversationCheckpointItems: PortableInputItem[] = [];
      const exactConversation = conversationResponseEpisode(input.execution);
      const conversationExecution = exactConversation !== null;
      let conversationOwner: ConversationCheckpointOwner | undefined;
      let conversationProjection: ConversationCheckpointProjection | undefined;
      let conversationCurrentJob: ConversationResponseJob | undefined;
      const history = conversationExecution
        ? yield* tx
            .transact(
              humanMessages.listForWorkspace(input.execution.workspaceId),
            )
            .pipe(Effect.mapError(failure))
        : [];
      let claimed = undefined as (typeof history)[number] | undefined;
      const placementExecution =
        conversationExecution ||
        executionEpisode(input.execution)?._tag === "InboxEpisode";
      if (conversationExecution) {
        if (
          dependencies.conversationCheckpoints === undefined ||
          responseJobs === undefined ||
          loopStepFence === undefined
        ) {
          return yield* Effect.fail(
            failure({
              _tag: "ConversationCheckpointStoreUnavailable",
              executionId: input.execution.executionId,
            }),
          );
        }
        const existingOwner = yield* tx
          .transact(
            dependencies.conversationCheckpoints.findOwner(
              input.execution.workspaceId,
            ),
          )
          .pipe(Effect.mapError(failure));
        conversationOwner = Option.isSome(existingOwner)
          ? existingOwner.value
          : yield* tx
              .transact(
                dependencies.conversationCheckpoints.initializeIfAbsent({
                  rootWorkspaceId: input.execution.workspaceId,
                  initializedAt: yield* now(),
                  fence: loopStepFence,
                }),
              )
              .pipe(Effect.mapError(failure));
        const responseJobRows = yield* tx
          .transact(responseJobs.listForWorkspace(input.execution.workspaceId))
          .pipe(Effect.mapError(failure));
        const currentResponseJob = responseJobRows.find(
          (job) => String(job.messageId) === exactConversation.messageId,
        );
        if (
          currentResponseJob === undefined ||
          currentResponseJob.state._tag !== "Running" ||
          currentResponseJob.state.executionId !== input.execution.executionId
        ) {
          return yield* Effect.fail(
            failure({
              _tag: "ConversationResponseJobNotCurrent",
              messageId: exactConversation.messageId,
              executionId: input.execution.executionId,
            }),
          );
        }
        if (
          dependencies.responseAttempts === undefined ||
          dependencies.executions === undefined
        ) {
          return yield* Effect.fail(
            failure({ _tag: "ConversationCheckpointEvidenceStoreUnavailable" }),
          );
        }
        const conversationAttempts: import("@arbor/ports").ConversationAttempt[] =
          [];
        const conversationExecutions: Execution[] = [input.execution];
        const seenExecutionIds = new Set<string>([
          String(input.execution.executionId),
        ]);
        for (const job of responseJobRows) {
          if (job.state._tag !== "Answered" && job.state._tag !== "Running") {
            continue;
          }
          const attempts = yield* tx
            .transact(dependencies.responseAttempts.list(job.messageId))
            .pipe(Effect.mapError(failure));
          conversationAttempts.push(...attempts);
          const wantedExecutionId = job.state.executionId;
          const wantedAttemptNo =
            job.state._tag === "Answered"
              ? job.nextAttemptNo - 1
              : job.state.attemptNo;
          const exactAttempt = attempts.find(
            (attempt) =>
              attempt.attemptNo === wantedAttemptNo &&
              attempt.executionId === wantedExecutionId,
          );
          if (
            exactAttempt !== undefined &&
            !seenExecutionIds.has(String(exactAttempt.executionId))
          ) {
            const found = yield* tx
              .transact(
                dependencies.executions.findById(exactAttempt.executionId),
              )
              .pipe(Effect.mapError(failure));
            if (Option.isSome(found)) {
              conversationExecutions.push(found.value);
            }
            seenExecutionIds.add(String(exactAttempt.executionId));
          }
        }
        conversationCurrentJob = currentResponseJob;
        const historyProjection = projectConversationCheckpointHistory({
          owner: conversationOwner,
          messages: history,
          responseJobs: responseJobRows,
          attempts: conversationAttempts,
          executions: conversationExecutions,
          currentMessageId: exactConversation.messageId,
          currentExecution: input.execution,
        });
        if (historyProjection._tag === "Blocked") {
          return yield* Effect.fail(
            failure({
              _tag: "ConversationCheckpointProjectionBlocked",
              reason: historyProjection.reason,
              messageId: exactConversation.messageId,
            }),
          );
        }
        conversationProjection = historyProjection.projection;
        claimed =
          conversationProjection.currentMessage as (typeof history)[number];
        const checkpoint = conversationProjection.checkpoint;
        if (
          checkpoint.checkpointKind !== null &&
          !isValidConversationCheckpointBinding(
            checkpoint.checkpointKind,
            checkpoint.checkpointRef,
            checkpoint.bindingFingerprint,
          )
        ) {
          return yield* Effect.fail(
            failure({ _tag: "ConversationCheckpointEvidenceInvalid" }),
          );
        }
        if (checkpoint.checkpointKind !== null) {
          yield* validateConversationCheckpointReceipt({
            owner: conversationOwner,
            execution: input.execution,
            providerTurns,
            tx,
            failure,
          });
        }
        if (checkpoint.checkpointKind === "Summary") {
          if (
            dependencies.blobs === undefined ||
            checkpoint.checkpointRef === null
          ) {
            return yield* Effect.fail(
              failure({ _tag: "ConversationCheckpointBlobStoreUnavailable" }),
            );
          }
          const bytes = yield* dependencies.blobs
            .get(checkpoint.checkpointRef)
            .pipe(Effect.mapError(failure));
          let summary: string;
          try {
            summary = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch {
            return yield* Effect.fail(
              failure({ _tag: "ConversationCheckpointBlobInvalid" }),
            );
          }
          if (summary.trim().length === 0) {
            return yield* Effect.fail(
              failure({ _tag: "ConversationCheckpointBlobInvalid" }),
            );
          }
          const summaryReceipt =
            providerTurns === undefined ||
            conversationOwner?.producerProviderTurnId === null ||
            conversationOwner?.producerProviderTurnId === undefined
              ? undefined
              : yield* tx
                  .transact(
                    providerTurns.findSettledResult(
                      conversationOwner.producerProviderTurnId,
                    ),
                  )
                  .pipe(Effect.mapError(failure));
          const providerSummary =
            summaryReceipt?._tag === "SettledSuccess"
              ? summaryReceipt.canonicalEvents
                  .flatMap((event) =>
                    event._tag === "TextDelta" ? [event.text] : [],
                  )
                  .join("")
                  .trim()
              : "";
          if (
            providerSummary.length === 0 ||
            providerSummary !== summary.trim()
          ) {
            return yield* Effect.fail(
              failure({ _tag: "ConversationCheckpointBlobMismatch" }),
            );
          }
          conversationCheckpointItems.push({
            _tag: "ContextUpdate",
            sourceRef: `conversation-checkpoint:${input.execution.workspaceId}:${checkpoint.contextEpoch}`,
            revision: Number(checkpoint.contextEpoch),
            updateKind: "Full",
            text: summary,
          });
          conversationContextRefs.push(
            `conversation-checkpoint:${input.execution.workspaceId}:${checkpoint.contextEpoch}`,
          );
        } else if (checkpoint.checkpointKind === "ProviderNative") {
          if (
            checkpoint.checkpointRef === null ||
            checkpoint.bindingFingerprint === null
          ) {
            return yield* Effect.fail(
              failure({ _tag: "ConversationCheckpointNativeBindingInvalid" }),
            );
          }
          const bindingUse = conversationCheckpointBindingUse({
            checkpointKind: checkpoint.checkpointKind,
            checkpointRef: checkpoint.checkpointRef,
            sourceBindingFingerprint: checkpoint.bindingFingerprint,
            currentBindingFingerprint,
            providerNativeSupported,
          });
          if (bindingUse._tag === "ProviderNative") {
            conversationCheckpointItems.push({
              _tag: "CompactionCheckpoint",
              implementation: "ProviderNative",
              fromEpoch: parse(ContextEpochNumber)(
                Number(checkpoint.contextEpoch) - 1,
              ),
              toEpoch: checkpoint.contextEpoch,
              retainedFrontierRef: `conversation-frontier:${input.execution.workspaceId}:${checkpoint.contextEpoch}`,
              opaqueItemRef: bindingUse.opaqueItemRef,
              bindingFingerprint: bindingUse.bindingFingerprint,
            });
            conversationContextRefs.push(
              `conversation-checkpoint:${input.execution.workspaceId}:${checkpoint.contextEpoch}`,
            );
          } else {
            const compacted = yield* runConversationCheckpointCompaction(
              {
                execution: input.execution,
                logicalStepNo: loopStep?.identity.logicalStepNo ?? turn,
                owner: conversationOwner,
                sources: [
                  ...conversationProjection.coveredAnswered,
                  ...conversationProjection.uncoveredAnswered,
                ],
                coveredThrough: (() => {
                  const source = [
                    ...conversationProjection.coveredAnswered,
                    ...conversationProjection.uncoveredAnswered,
                  ].at(-1);
                  return source === undefined
                    ? checkpoint.coveredThrough
                    : {
                        createdAt: source.message.createdAt,
                        messageId: source.message.messageId,
                      };
                })(),
                currentMessageId: exactConversation.messageId,
                currentResponseJob,
                checkpointKind: "Summary",
                bindingFingerprint: currentBindingFingerprint,
                modelRef: capability.modelRef,
                ...(options.secretRef === undefined
                  ? {}
                  : { secretRef: options.secretRef }),
                fence: loopStepFence,
                updatedAt: yield* now(),
                ...(options.qualificationProbe === undefined
                  ? {}
                  : { qualificationProbe: options.qualificationProbe }),
              },
              {
                providerRuntime,
                checkpointStore: dependencies.conversationCheckpoints,
                providerTurns:
                  providerTurns ??
                  (yield* Effect.fail(
                    failure({ _tag: "ProviderTurnStoreUnavailable" }),
                  )),
                blobs:
                  dependencies.blobs ??
                  (yield* Effect.fail(
                    failure({
                      _tag: "ConversationCheckpointBlobStoreUnavailable",
                    }),
                  )),
                tx,
              },
            ).pipe(Effect.mapError(failure));
            if (
              compacted.checkpointKind !== "Summary" ||
              compacted.newEpoch !==
                parse(ContextEpochNumber)(Number(checkpoint.contextEpoch) + 1)
            ) {
              return yield* Effect.fail(
                failure({ _tag: "ConversationCheckpointRebaseMismatch" }),
              );
            }
            continue;
          }
        } else if (checkpoint.checkpointKind !== null) {
          return yield* Effect.fail(
            failure({ _tag: "ConversationCheckpointEvidenceInvalid" }),
          );
        }
        for (const answered of conversationProjection.uncoveredAnswered) {
          conversationMessages.push(
            { role: "user", text: answered.message.bodyRef },
            { role: "assistant", text: answered.responseBody },
          );
          conversationContextRefs.push(
            `human-input:${answered.message.messageId}`,
            `human-response:${answered.message.messageId}`,
          );
        }
        conversationMessages.push({ role: "user", text: claimed.bodyRef });
        conversationContextRefs.push(`human-input:${claimed.messageId}`);
        if (
          loopStep?.state === "StepEffectsCommitted" &&
          loopStep.successor === undefined &&
          loopStepFence !== undefined &&
          loopSteps !== undefined &&
          providerTurns !== undefined &&
          conversationCurrentJob.state._tag === "Running" &&
          conversationCurrentJob.state.executionId ===
            input.execution.executionId &&
          conversationCurrentJob.messageId === exactConversation.messageId
        ) {
          if (loopStep === undefined) {
            return yield* Effect.fail(
              failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
            );
          }
          const pinnedStep = loopStep;
          const p20Links = yield* tx
            .transact(loopSteps.listProviderTurnLinks(pinnedStep.identity))
            .pipe(Effect.mapError(failure));
          const p20Chain = resolveP20OverflowReplacementChain(
            p20Links,
            pinnedStep.identity,
            String(pinnedStep.providerTurnId),
          );
          if (p20Chain !== undefined) {
            const [replacementManifest, replacementReceipt] = yield* Effect.all(
              [
                tx.transact(
                  providerTurns.findManifestByTurn(
                    p20Chain.replacement.providerTurnId,
                  ),
                ),
                tx.transact(
                  providerTurns.findSettledResult(
                    p20Chain.replacement.providerTurnId,
                  ),
                ),
              ],
              { concurrency: 1 },
            ).pipe(Effect.mapError(failure));
            if (
              !isP20OverflowReplacementManifestBound({
                step: pinnedStep,
                sessionId: String(input.execution.sessionId),
                chain: p20Chain,
                manifest: replacementManifest,
                settled: replacementReceipt,
              }) ||
              replacementReceipt._tag !== "SettledSuccess"
            ) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            const timeline = yield* tx
              .transact(readExecutionTimeline())
              .pipe(Effect.mapError(failure));
            const outputRows = timeline.filter(
              (entry) =>
                entry.sequence === pinnedStep.modelOutputSessionSequence &&
                belongsToConversationExecution(
                  entry,
                  String(input.execution.executionId),
                ),
            );
            const outputEntry = outputRows[0];
            const outputPayload =
              typeof outputEntry?.payload === "object" &&
              outputEntry.payload !== null
                ? (outputEntry.payload as Record<string, unknown>)
                : undefined;
            if (
              pinnedStep.modelOutputSessionSequence === undefined ||
              pinnedStep.decodedOutputHash === undefined ||
              pinnedStep.nextActionIndex !== 0 ||
              outputRows.length !== 1 ||
              outputEntry?.entryKind !== "ModelOutput" ||
              outputEntry.source?.kind !== "ProviderTurn" ||
              outputEntry.source.ref !==
                `${p20Chain.replacement.providerTurnId}:assistant` ||
              outputPayload?._tag !== "AssistantMessage" ||
              outputPayload.providerTurnId !==
                p20Chain.replacement.providerTurnId ||
              outputPayload.contentRef !==
                `provider:${p20Chain.replacement.providerTurnId}:assistant` ||
              typeof outputPayload.text !== "string" ||
              typeof outputPayload.finishReason !== "string"
            ) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            const decodedOutput = decodeTurn(
              replacementReceipt.canonicalEvents,
            );
            if (
              !decodedOutput.ok ||
              decodedOutput.output.toolInvocations.length !== 0 ||
              decodedOutput.output.text !== outputPayload.text ||
              decodedOutput.output.finishReason !==
                outputPayload.finishReason ||
              sha256Hex(
                JSON.stringify({
                  providerTurnId: p20Chain.replacement.providerTurnId,
                  outputContractRef: replacementReceipt.turn.outputContractRef,
                  decoderVersion: "decode-turn-v1",
                  text: decodedOutput.output.text,
                  finishReason: decodedOutput.output.finishReason,
                  toolInvocations: decodedOutput.output.toolInvocations,
                }),
              ) !== pinnedStep.decodedOutputHash
            ) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            const settlement: ExecutionSettlement = {
              _tag: "Completed",
              result: {
                _tag: "ConversationResponseProduced",
                messageId: exactConversation.messageId,
              },
            };
            const terminalStep = pinnedStep;
            yield* tx
              .transact(
                loopSteps.transition(
                  {
                    identity: terminalStep.identity,
                    expectedRevision: terminalStep.revision,
                    expectedState: "StepEffectsCommitted",
                    next: {
                      ...terminalStep,
                      state: "SettlementProposed",
                      settlement,
                      revision: terminalStep.revision + 1,
                      updatedAt: yield* now(),
                    },
                  },
                  loopStepFence,
                ),
              )
              .pipe(Effect.mapError(failure));
            if (options.qualificationProbe !== undefined) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "AH19NativeCheckpointRecovery",
                    stage: `P48TerminalSettledFromPinnedReplacement:step=${terminalStep.identity.logicalStepNo}:providerTurn=${p20Chain.replacement.providerTurnId}`,
                    executionId: String(input.execution.executionId),
                    providerTurnId: String(p20Chain.replacement.providerTurnId),
                  }) ?? Promise.resolve(),
              );
            }
            return { _tag: "Settle", settlement };
          }
        }
      }
      // A Human Conversation has its own durable history above. The primary
      // Workspace Session is the execution timeline for non-conversation episodes and
      // may contain tool calls, observations, or a dangling invocation from a
      // completely different episode. Letting that timeline participate here
      // both leaks technical Work context into chat and can block a harmless
      // conversation on an unrelated invocation. Start from an empty Session
      // projection; answered HumanMessages + the claimed message are the sole
      // conversation continuity source.
      const recentTimeline = yield* tx
        .transact(readExecutionTimeline())
        .pipe(Effect.mapError(failure));
      const conversationTimeline = (
        entries: ReadonlyArray<SessionEntryRecord>,
      ) =>
        entries.filter(
          (entry) =>
            belongsToConversationExecution(
              entry,
              input.execution.executionId,
            ) &&
            entry.entryKind !== "CheckpointReference" &&
            entry.source?.kind !== "CompactionTurn",
        );
      let recentSessionEntries = conversationExecution
        ? conversationTimeline(recentTimeline)
        : recentTimeline;
      let projectionDecision = decideSessionProjection(
        recentSessionEntries,
        currentBindingFingerprint,
        providerNativeSupported,
      );
      if (
        projectionDecision._tag === "Blocked" &&
        loopStepFence !== undefined &&
        (yield* tx
          .transact(sessions.supportsTypedTimeline())
          .pipe(Effect.mapError(failure)))
      ) {
        const unresolved = projectionDecision.callRefs.map((callRef) => {
          const entry = recentSessionEntries.find(
            (candidate) =>
              candidate.entryKind === "ModelOutput" &&
              typeof candidate.payload === "object" &&
              candidate.payload !== null &&
              (candidate.payload as { readonly _tag?: unknown })._tag ===
                "ToolCall" &&
              (candidate.payload as { readonly callRef?: unknown }).callRef ===
                callRef,
          );
          if (entry === undefined) return undefined;
          const payload = entry.payload as {
            readonly providerTurnId?: unknown;
            readonly callRef: string;
            readonly toolRef?: unknown;
          };
          return typeof payload.providerTurnId === "string" &&
            payload.providerTurnId !== providerTurnId
            ? {
                callRef: payload.callRef,
                toolName:
                  typeof payload.toolRef === "string"
                    ? payload.toolRef
                    : "unknown",
              }
            : undefined;
        });
        if (
          unresolved.length > 0 &&
          unresolved.every(
            (entry): entry is NonNullable<typeof entry> => entry !== undefined,
          )
        ) {
          const repairSession = yield* tx
            .transact(sessions.findById(input.execution.sessionId))
            .pipe(Effect.mapError(failure));
          if (Option.isNone(repairSession)) {
            return {
              _tag: "Settle" as const,
              settlement: safetyStop("SessionContextBlocked:SessionNotFound"),
            };
          }
          for (const invocation of unresolved) {
            const observationRef = `observation_${sha256Hex(
              `session-frontier-repair:${input.execution.sessionId}:${invocation.callRef}`,
            )}`;
            const item = {
              _tag: "ToolResult" as const,
              callRef: invocation.callRef,
              toolName: invocation.toolName,
              status: "Interrupted" as const,
              observationRef,
              modelOutputRef: `result_${sha256Hex(observationRef)}`,
              outputText:
                "tool invocation interrupted when its originating execution ended",
              truncated: false,
              artifactRefs: [],
            };
            yield* tx
              .transact(
                sessions.appendItemIdempotent(
                  input.execution.sessionId,
                  {
                    item,
                    contextEpoch: repairSession.value.contextEpoch,
                    source: {
                      kind: "SessionFrontierRepair",
                      ref: observationRef,
                    },
                    contentHash: sha256Hex(JSON.stringify(item)),
                  },
                  loopStepFence,
                ),
              )
              .pipe(Effect.mapError(failure));
          }
          recentSessionEntries = yield* tx
            .transact(readExecutionTimeline())
            .pipe(Effect.mapError(failure));
          if (conversationExecution) {
            recentSessionEntries = conversationTimeline(recentSessionEntries);
          }
          projectionDecision = decideSessionProjection(
            recentSessionEntries,
            currentBindingFingerprint,
            providerNativeSupported,
          );
        }
      }
      let sessionProjection: SessionTimelineProjection;
      if (projectionDecision._tag === "Blocked") {
        const settledForRecovery =
          loopStep !== undefined && providerTurns !== undefined
            ? yield* tx
                .transact(providerTurns.findSettledResult(providerTurnId))
                .pipe(Effect.mapError(failure))
            : undefined;
        if (settledForRecovery?._tag === "SettledSuccess") {
          const lastClosed = projectionDecision.closedFrontier.lastSequence;
          sessionProjection = projectSessionTimeline(
            lastClosed === null
              ? []
              : recentSessionEntries.filter(
                  (entry) => entry.sequence <= lastClosed,
                ),
            currentBindingFingerprint,
            providerNativeSupported,
          );
        } else {
          const settlement = safetyStop(
            `SessionContextBlocked:${projectionDecision.reason}:${projectionDecision.callRefs.join(",")}`,
          );
          if (
            loopStep !== undefined &&
            loopSteps !== undefined &&
            loopStepFence !== undefined &&
            loopStep.state === "Prepared"
          ) {
            yield* tx
              .transact(
                loopSteps.transition(
                  {
                    identity: loopStep.identity,
                    expectedRevision: loopStep.revision,
                    expectedState: "Prepared",
                    next: {
                      ...loopStep,
                      state: "SettlementProposed",
                      settlement,
                      revision: loopStep.revision + 1,
                      updatedAt: yield* now(),
                    },
                  },
                  loopStepFence,
                ),
              )
              .pipe(Effect.mapError(failure));
          }
          return { _tag: "Settle", settlement };
        }
      } else {
        sessionProjection = projectionDecision.projection;
      }
      const sessionRecord = yield* tx
        .transact(sessions.findById(input.execution.sessionId))
        .pipe(Effect.mapError(failure));
      if (Option.isNone(sessionRecord)) {
        return yield* Effect.fail(
          failure({
            _tag: "SessionContextMissing",
            sessionId: input.execution.sessionId,
          }),
        );
      }
      const stepContext = makeAgentStepContext({
        logicalStepNo: turn,
        repairAttempt,
        sessionId: input.execution.sessionId,
        contextEpoch:
          conversationOwner?.contextEpoch ?? sessionRecord.value.contextEpoch,
        controlBasis,
        bindingFingerprint: currentBindingFingerprint,
        inputFrontier: sessionProjection.frontier,
      });
      const inputItems = [
        ...conversationCheckpointItems,
        ...conversationMessages.map((message) => ({
          _tag: "Message" as const,
          role: message.role,
          text: message.text,
        })),
        ...sessionProjection.inputItems,
      ];
      const historySourceRefs = [
        ...conversationCheckpointItems.map(
          (_, index) =>
            `conversation-checkpoint:${input.execution.workspaceId}:${conversationOwner?.contextEpoch ?? 0}:${index}`,
        ),
        ...conversationMessages.map(
          (_, index) => `conversation-input:${index}`,
        ),
        ...sessionProjection.inputItems.map(
          (_, index) =>
            sessionProjection.contextRefs[index] ??
            `session:${input.execution.sessionId}:${index}`,
        ),
      ];
      const compressibleHistoryIndexes: number[] = [];
      const sessionInputOffset =
        conversationCheckpointItems.length + conversationMessages.length;
      // Conversation checkpoint/suffix/current input remains independently
      // owned by the RootWorkspace P14 owner. Only Work's bound Session
      // frontier participates in C3 Session-history compression.
      if (!conversationExecution) {
        const latestInputIndex = latestSessionInputIndex(
          sessionProjection.inputItems,
        );
        for (
          let index = 0;
          index < sessionProjection.inputItems.length;
          index += 1
        ) {
          if (index !== latestInputIndex) {
            compressibleHistoryIndexes.push(sessionInputOffset + index);
          }
        }
      }
      const historyContext = projectCompressibleHistory({
        inputItems,
        sourceRefs: historySourceRefs,
        compressibleIndexes: compressibleHistoryIndexes,
      });
      const messageContextRefs = [
        ...conversationContextRefs,
        ...sessionProjection.contextRefs,
      ];
      const nativeCheckpoint = sessionProjection.nativeCheckpoint;
      if (nativeCheckpoint !== undefined) {
        if (options.qualificationProbe !== undefined) {
          yield* Effect.promise(
            () =>
              options.qualificationProbe?.({
                boundary: "AH19NativeCheckpointRecovery",
                stage: `NativeCheckpointRecoveryEntered:bindingMatches=${nativeCheckpoint.bindingMatches}:source=${nativeCheckpoint.providerTurnId ?? "unknown"}:cursor=${turn}/${repairAttempt}:from=${nativeCheckpoint.fromEpoch ?? "missing"}:to=${nativeCheckpoint.toEpoch ?? "missing"}:sessionEpoch=${sessionRecord.value.contextEpoch}`,
                executionId: String(input.execution.executionId),
                providerTurnId: nativeCheckpoint.providerTurnId ?? "unknown",
              }) ?? Promise.resolve(),
          );
        }
        if (
          nativeCheckpoint.toEpoch === undefined ||
          nativeCheckpoint.toEpoch !== Number(sessionRecord.value.contextEpoch)
        ) {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        // A checkpoint can outlive the in-memory model-loop cursor. Bind it to
        // the persisted AgentLoopStep in every binding branch, including an
        // exact-binding restart; never derive the step from ProviderTurn text.
        if (
          nativeCheckpoint.providerTurnId === undefined ||
          nativeCheckpoint.fromEpoch === undefined ||
          nativeCheckpoint.opaqueItemRef === undefined ||
          nativeCheckpoint.bindingFingerprint === undefined ||
          providerTurns === undefined ||
          loopSteps === undefined
        ) {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        const checkpointNativeProviderTurnId = nativeCompactionProviderTurnId(
          nativeCheckpoint.providerTurnId,
        );
        if (checkpointNativeProviderTurnId === null) {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        if (options.qualificationProbe !== undefined) {
          yield* Effect.promise(
            () =>
              options.qualificationProbe?.({
                boundary: "AH19NativeCheckpointRecovery",
                stage: "NativeCheckpointProviderTurnParsed",
                executionId: String(input.execution.executionId),
                providerTurnId: checkpointNativeProviderTurnId,
              }) ?? Promise.resolve(),
          );
        }
        const [checkpointManifest, checkpointReceipt] = yield* Effect.all(
          [
            tx.transact(
              providerTurns.findManifestByTurn(checkpointNativeProviderTurnId),
            ),
            tx.transact(
              providerTurns.findSettledResult(checkpointNativeProviderTurnId),
            ),
          ],
          { concurrency: 1 },
        ).pipe(Effect.mapError(failure));
        if (options.qualificationProbe !== undefined) {
          yield* Effect.promise(
            () =>
              options.qualificationProbe?.({
                boundary: "AH19NativeCheckpointRecovery",
                stage: `NativeCheckpointManifestReceiptRead:manifest=${checkpointManifest !== null}:receipt=${checkpointReceipt._tag}:sameManifest=${checkpointReceipt._tag === "SettledSuccess" && checkpointReceipt.manifestJson === checkpointManifest?.manifestJson}`,
                executionId: String(input.execution.executionId),
                providerTurnId: checkpointNativeProviderTurnId,
              }) ?? Promise.resolve(),
          );
        }
        const checkpointFrontier =
          checkpointManifest === null
            ? null
            : decodeUniqueNativePortableFrontier(
                checkpointManifest.manifestJson,
                checkpointManifest.portableRequestJson,
              );
        const checkpointManifestJson = checkpointFrontier?.manifest;
        const checkpointSource = checkpointManifestJson?.sourceAgentLoopStep;
        const checkpointSourceIdentity =
          typeof checkpointSource === "object" &&
          checkpointSource !== null &&
          !Array.isArray(checkpointSource) &&
          (checkpointSource as Record<string, unknown>).executionId ===
            input.execution.executionId &&
          Number.isSafeInteger(
            (checkpointSource as Record<string, unknown>).logicalStepNo,
          ) &&
          Number((checkpointSource as Record<string, unknown>).logicalStepNo) >=
            0 &&
          Number.isSafeInteger(
            (checkpointSource as Record<string, unknown>).repairAttempt,
          ) &&
          Number((checkpointSource as Record<string, unknown>).repairAttempt) >=
            0 &&
          typeof (checkpointSource as Record<string, unknown>)
            .providerTurnId === "string"
            ? {
                executionId: input.execution.executionId,
                logicalStepNo: Number(
                  (checkpointSource as Record<string, unknown>).logicalStepNo,
                ),
                repairAttempt: Number(
                  (checkpointSource as Record<string, unknown>).repairAttempt,
                ),
              }
            : undefined;
        let checkpointRawSourceIsValid = false;
        if (checkpointManifest !== null) {
          try {
            const rawManifest = JSON.parse(
              checkpointManifest.manifestJson,
            ) as Record<string, unknown>;
            const rawSource = rawManifest.sourceAgentLoopStep;
            checkpointRawSourceIsValid =
              typeof rawSource === "object" &&
              rawSource !== null &&
              !Array.isArray(rawSource) &&
              (rawSource as Record<string, unknown>).executionId ===
                input.execution.executionId &&
              Number.isSafeInteger(
                (rawSource as Record<string, unknown>).logicalStepNo,
              ) &&
              Number((rawSource as Record<string, unknown>).logicalStepNo) >=
                0 &&
              Number.isSafeInteger(
                (rawSource as Record<string, unknown>).repairAttempt,
              ) &&
              Number((rawSource as Record<string, unknown>).repairAttempt) >=
                0 &&
              typeof (rawSource as Record<string, unknown>).providerTurnId ===
                "string";
          } catch {
            checkpointRawSourceIsValid = false;
          }
        }
        if (options.qualificationProbe !== undefined) {
          yield* Effect.promise(
            () =>
              options.qualificationProbe?.({
                boundary: "AH19NativeCheckpointRecovery",
                stage: `NativeCheckpointEvidence:frontier=${checkpointFrontier !== null}:source=${checkpointRawSourceIsValid}:receipt=${checkpointReceipt._tag}:manifestTurn=${checkpointManifestJson?.providerTurnId === checkpointNativeProviderTurnId}:requestEpoch=${checkpointManifestJson?.contextEpoch === nativeCheckpoint.fromEpoch}`,
                executionId: String(input.execution.executionId),
                providerTurnId: checkpointNativeProviderTurnId,
              }) ?? Promise.resolve(),
          );
        }
        if (
          checkpointManifest === null ||
          checkpointFrontier === null ||
          checkpointManifestJson === undefined ||
          checkpointSourceIdentity === undefined ||
          checkpointReceipt._tag !== "SettledSuccess" ||
          checkpointReceipt.evidenceVersion !== "provider-success-v1" ||
          checkpointReceipt.finishReason !== "Stop" ||
          checkpointReceipt.turn.providerTurnId !==
            checkpointNativeProviderTurnId ||
          checkpointReceipt.turn.manifestId !== checkpointManifest.manifestId ||
          checkpointReceipt.turn.executionId !== input.execution.executionId ||
          checkpointReceipt.turn.sessionId !== input.execution.sessionId ||
          checkpointReceipt.turn.contextEpoch !== nativeCheckpoint.fromEpoch ||
          checkpointReceipt.turn.outputContractRef !==
            "provider-native-compaction-v1" ||
          checkpointReceipt.manifestJson !== checkpointManifest.manifestJson ||
          checkpointManifestJson.providerTurnId !==
            checkpointNativeProviderTurnId ||
          checkpointManifestJson.executionId !== input.execution.executionId ||
          checkpointManifestJson.sessionId !== input.execution.sessionId ||
          checkpointManifestJson.contextEpoch !== nativeCheckpoint.fromEpoch ||
          checkpointManifestJson.operationKind !== "CompactionNative" ||
          checkpointManifestJson.outputContractRef !==
            "provider-native-compaction-v1" ||
          checkpointManifestJson.resolvedModelBindingFingerprint !==
            nativeCheckpoint.bindingFingerprint ||
          checkpointManifestJson.compiledRequestHash !==
            sha256Hex(checkpointManifest.portableRequestJson) ||
          checkpointFrontier.request.modelRef !==
            checkpointManifestJson.modelRef ||
          checkpointReceipt.turn.modelRef !== checkpointManifestJson.modelRef ||
          checkpointFrontier.request.operationKind !== "CompactionNative" ||
          checkpointFrontier.request.outputContractRef !==
            "provider-native-compaction-v1" ||
          checkpointReceipt.canonicalEvents.filter(
            (event) =>
              event._tag === "ContinuationState" &&
              event.stateRef === nativeCheckpoint.opaqueItemRef,
          ).length !== 1
        ) {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        const checkpointSourceStepOption = yield* tx
          .transact(loopSteps.find(checkpointSourceIdentity))
          .pipe(Effect.mapError(failure));
        if (!Option.isSome(checkpointSourceStepOption)) {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        const checkpointSourceStep = checkpointSourceStepOption.value;
        if (
          checkpointSourceStep.identity.executionId !==
            input.execution.executionId ||
          checkpointSourceStep.identity.logicalStepNo !==
            checkpointSourceIdentity.logicalStepNo ||
          checkpointSourceStep.identity.repairAttempt !==
            checkpointSourceIdentity.repairAttempt ||
          checkpointSourceStep.providerTurnId !==
            (checkpointSource as Record<string, unknown>).providerTurnId
        ) {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        if (
          checkpointSourceStep.state === "NextStepReady" &&
          checkpointSourceStep.successor === undefined
        ) {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        if (
          checkpointSourceStep.state === "Prepared" ||
          checkpointSourceStep.state === "ProviderResultAvailable" ||
          checkpointSourceStep.state === "OutputRejected" ||
          checkpointSourceStep.state === "OutputAccepted" ||
          checkpointSourceStep.state === "ActionsInProgress"
        ) {
          turn = checkpointSourceIdentity.logicalStepNo;
          repairAttempt = checkpointSourceIdentity.repairAttempt;
        } else if (
          checkpointSourceStep.state === "StepEffectsCommitted" ||
          checkpointSourceStep.state === "NextStepReady"
        ) {
          if (
            !nativeCheckpoint.bindingMatches ||
            checkpointSourceStep.successor === undefined
          ) {
            turn = checkpointSourceIdentity.logicalStepNo;
            repairAttempt = checkpointSourceIdentity.repairAttempt;
          } else {
            turn = checkpointSourceStep.successor.logicalStepNo;
            repairAttempt = checkpointSourceStep.successor.repairAttempt;
          }
        }
        if (options.qualificationProbe !== undefined) {
          yield* Effect.promise(
            () =>
              options.qualificationProbe?.({
                boundary: "AH19NativeCheckpointRecovery",
                stage: `NativeCheckpointSourceValidated:state=${checkpointSourceStep.state}:source=${checkpointSourceStep.providerTurnId}:cursor=${turn}/${repairAttempt}:bindingMatches=${nativeCheckpoint.bindingMatches}`,
                executionId: String(input.execution.executionId),
                providerTurnId: nativeCheckpoint.providerTurnId ?? "unknown",
              }) ?? Promise.resolve(),
          );
        }
        if (!nativeCheckpoint.bindingMatches) {
          if (options.qualificationProbe !== undefined) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH19NativeCheckpointRecovery",
                  stage: "ProjectorObservedBindingMismatch",
                  executionId: String(input.execution.executionId),
                  providerTurnId: nativeCheckpoint.providerTurnId ?? "unknown",
                }) ?? Promise.resolve(),
            );
          }
          if (
            nativeCheckpoint.providerTurnId === undefined ||
            nativeCheckpoint.fromEpoch === undefined ||
            nativeCheckpoint.opaqueItemRef === undefined ||
            nativeCheckpoint.bindingFingerprint === undefined ||
            providerTurns === undefined ||
            loopSteps === undefined ||
            loopStepFence === undefined
          ) {
            if (options.qualificationProbe !== undefined) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "AH19NativeCheckpointRecovery",
                    stage: `PrerequisitesMissing:turn=${nativeCheckpoint.providerTurnId !== undefined}:from=${nativeCheckpoint.fromEpoch !== undefined}:opaque=${nativeCheckpoint.opaqueItemRef !== undefined}:fingerprint=${nativeCheckpoint.bindingFingerprint !== undefined}:providerStore=${providerTurns !== undefined}:fence=${loopStepFence !== undefined}`,
                    executionId: String(input.execution.executionId),
                    providerTurnId:
                      nativeCheckpoint.providerTurnId ?? "unknown",
                  }) ?? Promise.resolve(),
              );
            }
            return yield* Effect.fail(
              failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
            );
          }
          if (options.qualificationProbe !== undefined) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH19NativeCheckpointRecovery",
                  stage: "PrerequisitesValidated",
                  executionId: String(input.execution.executionId),
                  providerTurnId: nativeCheckpoint.providerTurnId ?? "unknown",
                }) ?? Promise.resolve(),
            );
          }
          const nativeCheckpointProviderTurnId =
            nativeCheckpoint.providerTurnId;
          const nativeProviderTurnId = nativeCompactionProviderTurnId(
            nativeCheckpoint.providerTurnId,
          );
          if (nativeProviderTurnId === null) {
            if (options.qualificationProbe !== undefined) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "AH19NativeCheckpointRecovery",
                    stage: "NativeProviderTurnIdInvalid",
                    executionId: String(input.execution.executionId),
                    providerTurnId:
                      nativeCheckpoint.providerTurnId ?? "unknown",
                  }) ?? Promise.resolve(),
              );
            }
            return yield* Effect.fail(
              failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
            );
          }
          const sourceLinkOption = yield* tx
            .transact(
              loopSteps.findProviderTurnLinkByProviderTurnId(
                nativeProviderTurnId,
              ),
            )
            .pipe(Effect.mapError(failure));
          const nativeManifest = yield* tx
            .transact(providerTurns.findManifestByTurn(nativeProviderTurnId))
            .pipe(Effect.mapError(failure));
          if (nativeManifest === null) {
            return yield* Effect.fail(
              failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
            );
          }
          let nativeManifestValue: Record<string, unknown>;
          try {
            const parsed = JSON.parse(nativeManifest.manifestJson) as unknown;
            if (
              typeof parsed !== "object" ||
              parsed === null ||
              Array.isArray(parsed)
            ) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            nativeManifestValue = parsed as Record<string, unknown>;
          } catch {
            return yield* Effect.fail(
              failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
            );
          }
          const sourceIdentityValue = nativeManifestValue.sourceAgentLoopStep;
          const sourceIdentity =
            typeof sourceIdentityValue === "object" &&
            sourceIdentityValue !== null &&
            !Array.isArray(sourceIdentityValue)
              ? (sourceIdentityValue as Record<string, unknown>)
              : undefined;
          if (options.qualificationProbe !== undefined) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH19NativeCheckpointRecovery",
                  stage: `NativeCheckpointEvidence:frontier=${checkpointFrontier !== null}:source=${checkpointSourceIdentity !== undefined}:receipt=${checkpointReceipt._tag}:manifestTurn=${checkpointManifestJson?.providerTurnId === checkpointNativeProviderTurnId}:requestEpoch=${checkpointManifestJson?.contextEpoch === nativeCheckpoint.fromEpoch}`,
                  executionId: String(input.execution.executionId),
                  providerTurnId: checkpointNativeProviderTurnId,
                }) ?? Promise.resolve(),
            );
          }
          const sourceLink = Option.isSome(sourceLinkOption)
            ? sourceLinkOption.value
            : undefined;
          const sourceStepIdentity =
            sourceLink?.identity ??
            (sourceIdentity !== undefined &&
            sourceIdentity.executionId === input.execution.executionId &&
            Number.isSafeInteger(sourceIdentity.logicalStepNo) &&
            Number(sourceIdentity.logicalStepNo) >= 0 &&
            Number.isSafeInteger(sourceIdentity.repairAttempt) &&
            Number(sourceIdentity.repairAttempt) >= 0
              ? {
                  executionId: input.execution.executionId,
                  logicalStepNo: Number(sourceIdentity.logicalStepNo),
                  repairAttempt: Number(sourceIdentity.repairAttempt),
                }
              : undefined);
          if (
            sourceStepIdentity === undefined ||
            (sourceLink !== undefined &&
              (sourceLink.providerTurnId !== nativeProviderTurnId ||
                sourceLink.identity.executionId !==
                  input.execution.executionId ||
                sourceLink.role !== "OverflowCompaction" ||
                sourceLink.overflowOrdinal !== 0 ||
                sourceLink.contextEpoch !== nativeCheckpoint.fromEpoch ||
                sourceLink.predecessorProviderTurnId === undefined)) ||
            sourceIdentity?.providerTurnId === undefined
          ) {
            return yield* Effect.fail(
              failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
            );
          }
          if (
            sourceIdentity.executionId !== sourceStepIdentity.executionId ||
            sourceIdentity.logicalStepNo !== sourceStepIdentity.logicalStepNo ||
            sourceIdentity.repairAttempt !== sourceStepIdentity.repairAttempt
          ) {
            return yield* Effect.fail(
              failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
            );
          }
          const sourceStepOption = yield* tx
            .transact(loopSteps.find(sourceStepIdentity))
            .pipe(Effect.mapError(failure));
          if (!Option.isSome(sourceStepOption)) {
            return yield* Effect.fail(
              failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
            );
          }
          const sourceStep = sourceStepOption.value;
          const sourceStepLinks = yield* tx
            .transact(loopSteps.listProviderTurnLinks(sourceStepIdentity))
            .pipe(Effect.mapError(failure));
          const inferenceLinks = sourceStepLinks.filter(
            (link) => link.role === "Inference",
          );
          const compactionLinks = sourceStepLinks.filter(
            (link) => link.role === "OverflowCompaction",
          );
          const sourceInferenceLink = inferenceLinks[0];
          const hasOverflowSource = sourceLink !== undefined;
          if (
            sourceStep.identity.executionId !== input.execution.executionId ||
            sourceStep.providerTurnId !== sourceIdentity.providerTurnId ||
            (hasOverflowSource
              ? sourceStep.providerTurnId !==
                  sourceLink.predecessorProviderTurnId ||
                inferenceLinks.length !== 1 ||
                compactionLinks.length !== 1 ||
                compactionLinks[0]?.providerTurnId !== nativeProviderTurnId ||
                sourceInferenceLink === undefined ||
                sourceInferenceLink.providerTurnId !==
                  sourceLink.predecessorProviderTurnId ||
                sourceInferenceLink.contextEpoch !== sourceLink.contextEpoch
              : compactionLinks.length !== 0 ||
                inferenceLinks.length > 1 ||
                (sourceInferenceLink !== undefined &&
                  sourceInferenceLink.providerTurnId !==
                    sourceStep.providerTurnId))
          ) {
            return yield* Effect.fail(
              failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
            );
          }
          if (sourceLink !== undefined && sourceInferenceLink !== undefined) {
            const sourceInferenceResult = yield* tx
              .transact(
                providerTurns.findSettledResult(
                  sourceInferenceLink.providerTurnId,
                ),
              )
              .pipe(Effect.mapError(failure));
            if (
              sourceInferenceResult._tag !== "SettledFailure" ||
              sourceInferenceResult.turn.providerTurnId !==
                sourceInferenceLink.providerTurnId ||
              sourceInferenceResult.failureKind !== "ContextLimitExceeded" ||
              sourceInferenceResult.turn.executionId !==
                input.execution.executionId ||
              sourceInferenceResult.turn.sessionId !==
                input.execution.sessionId ||
              sourceInferenceResult.turn.contextEpoch !==
                sourceLink.contextEpoch
            ) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
          }
          // The Native Manifest carries the exact source identity for ordinary
          // compaction; an overflow link, when present, must agree with it.
          turn = sourceStepIdentity.logicalStepNo;
          repairAttempt = sourceStepIdentity.repairAttempt;
          if (options.qualificationProbe !== undefined) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH19NativeCheckpointRecovery",
                  stage: `NativeSourceIdentity:step=${sourceStepIdentity.logicalStepNo}:repair=${sourceStepIdentity.repairAttempt}:sourceProviderTurn=${sourceStep.providerTurnId}:overflow=${hasOverflowSource}:state=${sourceStep.state}:successor=${sourceStep.successor?.providerTurnId ?? "none"}`,
                  executionId: String(input.execution.executionId),
                  providerTurnId: nativeProviderTurnId,
                }) ?? Promise.resolve(),
            );
          }
          if (options.qualificationProbe !== undefined) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH19NativeCheckpointRecovery",
                  stage: "NativeManifestQueryStarted",
                  executionId: String(input.execution.executionId),
                  providerTurnId: nativeProviderTurnId,
                }) ?? Promise.resolve(),
            );
          }
          if (options.qualificationProbe !== undefined) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH19NativeCheckpointRecovery",
                  stage:
                    nativeManifest === null
                      ? "NativeManifestQueryNotFound"
                      : "NativeManifestQueryFound",
                  executionId: String(input.execution.executionId),
                  providerTurnId: nativeProviderTurnId,
                }) ?? Promise.resolve(),
            );
          }
          if (nativeManifest === null) {
            return yield* Effect.fail(
              failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
            );
          }
          const nativeReceipt = yield* tx
            .transact(providerTurns.findSettledResult(nativeProviderTurnId))
            .pipe(Effect.mapError(failure));
          if (options.qualificationProbe !== undefined) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH19NativeCheckpointRecovery",
                  stage: `NativeReceiptLookup:${nativeReceipt._tag}`,
                  executionId: String(input.execution.executionId),
                  providerTurnId: nativeProviderTurnId,
                }) ?? Promise.resolve(),
            );
          }
          if (
            nativeManifest === null ||
            nativeReceipt._tag !== "SettledSuccess" ||
            nativeReceipt.finishReason !== "Stop" ||
            nativeReceipt.evidenceVersion !== "provider-success-v1" ||
            nativeReceipt.turn.providerTurnId !== nativeProviderTurnId ||
            nativeReceipt.turn.executionId !== input.execution.executionId ||
            nativeReceipt.turn.sessionId !== input.execution.sessionId ||
            nativeReceipt.turn.contextEpoch !== nativeCheckpoint.fromEpoch ||
            nativeReceipt.manifestJson !== nativeManifest.manifestJson
          ) {
            return yield* Effect.fail(
              failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
            );
          }
          let nativeManifestJson: Record<string, unknown>;
          let nativeRequest: Record<string, unknown>;
          try {
            const manifestValue = JSON.parse(
              nativeManifest.manifestJson,
            ) as unknown;
            const requestValue = JSON.parse(
              nativeManifest.portableRequestJson,
            ) as unknown;
            if (
              typeof manifestValue !== "object" ||
              manifestValue === null ||
              Array.isArray(manifestValue) ||
              typeof requestValue !== "object" ||
              requestValue === null ||
              Array.isArray(requestValue)
            ) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            nativeManifestJson = manifestValue as Record<string, unknown>;
            nativeRequest = requestValue as Record<string, unknown>;
          } catch {
            return yield* Effect.fail(
              failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
            );
          }
          const nativeInputFrontier = nativeManifestJson.inputFrontier as
            | {
                firstSequence?: unknown;
                lastSequence?: unknown;
              }
            | undefined;
          const nativeContextRefs = nativeManifestJson.contextRefs;
          const nativeInputItems = nativeRequest.inputItems;
          const nativeContinuationRefs = nativeReceipt.canonicalEvents.filter(
            (event) => event._tag === "ContinuationState",
          );
          const validContextRefs =
            Array.isArray(nativeContextRefs) &&
            nativeContextRefs.length > 0 &&
            nativeContextRefs.every(
              (ref): ref is string => typeof ref === "string" && ref.length > 0,
            ) &&
            new Set(nativeContextRefs).size === nativeContextRefs.length;
          const emptyNativeFrontier =
            nativeInputFrontier?.firstSequence === null &&
            nativeInputFrontier.lastSequence === null;
          const nonEmptyNativeFrontier =
            typeof nativeInputFrontier?.firstSequence === "number" &&
            Number.isSafeInteger(nativeInputFrontier.firstSequence) &&
            nativeInputFrontier.firstSequence >= 0 &&
            typeof nativeInputFrontier.lastSequence === "number" &&
            Number.isSafeInteger(nativeInputFrontier.lastSequence) &&
            nativeInputFrontier.lastSequence >=
              nativeInputFrontier.firstSequence &&
            nativeInputFrontier.lastSequence < nativeCheckpoint.sequence;
          const validNativeFrontier =
            emptyNativeFrontier || nonEmptyNativeFrontier;
          const manifestSourceIdentity = nativeManifestJson.sourceAgentLoopStep;
          const sourceAgentLoopStepMatches =
            typeof manifestSourceIdentity === "object" &&
            manifestSourceIdentity !== null &&
            !Array.isArray(manifestSourceIdentity) &&
            (manifestSourceIdentity as Record<string, unknown>).executionId ===
              sourceStepIdentity.executionId &&
            (manifestSourceIdentity as Record<string, unknown>)
              .logicalStepNo === sourceStepIdentity.logicalStepNo &&
            (manifestSourceIdentity as Record<string, unknown>)
              .repairAttempt === sourceStepIdentity.repairAttempt &&
            (manifestSourceIdentity as Record<string, unknown>)
              .providerTurnId === sourceStep.providerTurnId;
          if (options.qualificationProbe !== undefined) {
            const checks = {
              providerTurn:
                nativeManifestJson.providerTurnId ===
                nativeCheckpoint.providerTurnId,
              execution:
                nativeManifestJson.executionId === input.execution.executionId,
              session:
                nativeManifestJson.sessionId === input.execution.sessionId,
              epoch:
                nativeManifestJson.contextEpoch === nativeCheckpoint.fromEpoch,
              operation:
                nativeManifestJson.operationKind === "CompactionNative",
              step:
                nativeManifestJson.logicalStepNo ===
                sourceStepIdentity.logicalStepNo,
              sourceAgentLoopStep: sourceAgentLoopStepMatches,
              fingerprint:
                nativeManifestJson.resolvedModelBindingFingerprint ===
                nativeCheckpoint.bindingFingerprint,
              hash:
                nativeManifestJson.compiledRequestHash ===
                sha256Hex(nativeManifest.portableRequestJson),
              version: nativeRequest.requestVersion === 2,
              requestOperation:
                nativeRequest.operationKind === "CompactionNative",
              model: nativeRequest.modelRef === nativeManifestJson.modelRef,
              output:
                nativeRequest.outputContractRef ===
                "provider-native-compaction-v1",
              refs: validContextRefs,
              frontier: validNativeFrontier,
              items:
                Array.isArray(nativeInputItems) && nativeInputItems.length > 0,
              nestedNative:
                Array.isArray(nativeInputItems) &&
                nativeInputItems.some(
                  (item) =>
                    typeof item === "object" &&
                    item !== null &&
                    "_tag" in item &&
                    item._tag === "CompactionCheckpoint" &&
                    "implementation" in item &&
                    item.implementation === "ProviderNative",
                ),
              continuationCount: nativeContinuationRefs.length,
              continuationRef:
                nativeContinuationRefs[0]?._tag === "ContinuationState" &&
                nativeContinuationRefs[0].stateRef ===
                  nativeCheckpoint.opaqueItemRef,
            };
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH19NativeCheckpointRecovery",
                  stage: `NativeManifestChecks:${Object.entries(checks)
                    .map(([key, value]) => `${key}=${String(value)}`)
                    .join(",")}`,
                  executionId: String(input.execution.executionId),
                  providerTurnId: nativeCheckpointProviderTurnId,
                }) ?? Promise.resolve(),
            );
          }
          if (
            nativeManifestJson.providerTurnId !==
              nativeCheckpoint.providerTurnId ||
            nativeManifestJson.executionId !== input.execution.executionId ||
            nativeManifestJson.sessionId !== input.execution.sessionId ||
            nativeManifestJson.contextEpoch !== nativeCheckpoint.fromEpoch ||
            nativeManifestJson.operationKind !== "CompactionNative" ||
            nativeManifestJson.logicalStepNo !==
              sourceStepIdentity.logicalStepNo ||
            !sourceAgentLoopStepMatches ||
            nativeManifestJson.resolvedModelBindingFingerprint !==
              nativeCheckpoint.bindingFingerprint ||
            nativeManifestJson.compiledRequestHash !==
              sha256Hex(nativeManifest.portableRequestJson) ||
            nativeRequest.requestVersion !== 2 ||
            nativeRequest.operationKind !== "CompactionNative" ||
            nativeRequest.modelRef !== nativeManifestJson.modelRef ||
            nativeRequest.outputContractRef !==
              "provider-native-compaction-v1" ||
            !validContextRefs ||
            !validNativeFrontier ||
            !Array.isArray(nativeInputItems) ||
            nativeInputItems.length === 0 ||
            nativeInputItems.some(
              (item) =>
                typeof item === "object" &&
                item !== null &&
                "_tag" in item &&
                item._tag === "CompactionCheckpoint" &&
                "implementation" in item &&
                item.implementation === "ProviderNative",
            ) ||
            nativeContinuationRefs.length !== 1 ||
            nativeContinuationRefs[0]?.stateRef !==
              nativeCheckpoint.opaqueItemRef
          ) {
            return yield* Effect.fail(
              failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
            );
          }
          if (options.qualificationProbe !== undefined) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH19NativeCheckpointRecovery",
                  stage: "PortableFrontierValidated",
                  executionId: String(input.execution.executionId),
                  providerTurnId: nativeCheckpointProviderTurnId,
                }) ?? Promise.resolve(),
            );
          }
          const postCheckpointEntries = recentSessionEntries.filter(
            (entry) => entry.sequence > nativeCheckpoint.sequence,
          );
          const postCheckpointProjection = projectSessionTimeline(
            postCheckpointEntries,
            currentBindingFingerprint,
            providerNativeSupported,
          );
          if (postCheckpointProjection.nativeCheckpoint !== undefined) {
            return yield* Effect.fail(
              failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
            );
          }
          const portableContextRefs = [
            ...(nativeContextRefs as ReadonlyArray<string>),
            ...postCheckpointProjection.contextRefs,
          ];
          if (
            portableContextRefs.length === 0 ||
            new Set(portableContextRefs).size !== portableContextRefs.length
          ) {
            return yield* Effect.fail(
              failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
            );
          }
          const firstSequence =
            typeof nativeInputFrontier.firstSequence === "number"
              ? nativeInputFrontier.firstSequence
              : postCheckpointProjection.frontier.firstSequence;
          const lastSequence =
            postCheckpointProjection.frontier.lastSequence ??
            (typeof nativeInputFrontier.lastSequence === "number"
              ? nativeInputFrontier.lastSequence
              : null);
          if (
            (firstSequence === null) !== (lastSequence === null) ||
            (firstSequence !== null &&
              lastSequence !== null &&
              lastSequence < firstSequence)
          ) {
            return yield* Effect.fail(
              failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
            );
          }
          const portableItems = [
            ...(nativeInputItems as ReadonlyArray<PortableInputItem>),
            ...postCheckpointProjection.inputItems,
          ];
          const terminalInboxEpisode = executionEpisode(input.execution);
          const isTerminalResponseEpisode =
            conversationResponseEpisode(input.execution) !== null ||
            terminalInboxEpisode?._tag === "InboxEpisode";
          if (
            isTerminalResponseEpisode &&
            sourceStep.state === "StepEffectsCommitted"
          ) {
            const sequence = sourceStep.modelOutputSessionSequence;
            const outputRows = recentSessionEntries.filter(
              (entry) => entry.sequence === sequence,
            );
            const outputEntry = outputRows[0];
            const outputPayload =
              typeof outputEntry?.payload === "object" &&
              outputEntry.payload !== null
                ? (outputEntry.payload as Record<string, unknown>)
                : undefined;
            const outputProviderTurnId = outputPayload?.providerTurnId;
            const outputTurnId = decodedProviderTurnId(outputProviderTurnId);
            const replacementLinks = sourceStepLinks.filter(
              (link) => link.role === "OverflowReplacement",
            );
            const replacementLink = replacementLinks[0];
            if (
              sequence === undefined ||
              sourceStep.decodedOutputHash === undefined ||
              sourceStep.nextActionIndex !== 0 ||
              outputRows.length !== 1 ||
              outputEntry?.entryKind !== "ModelOutput" ||
              outputEntry.source?.kind !== "ProviderTurn" ||
              outputPayload?._tag !== "AssistantMessage" ||
              outputTurnId === null ||
              outputEntry.source.ref !== `${outputTurnId}:assistant` ||
              replacementLinks.length !== 1 ||
              replacementLink?.providerTurnId !== outputTurnId ||
              replacementLink.identity.logicalStepNo !==
                sourceStep.identity.logicalStepNo ||
              replacementLink.identity.repairAttempt !==
                sourceStep.identity.repairAttempt ||
              replacementLink.predecessorProviderTurnId !==
                nativeCheckpointProviderTurnId ||
              replacementLink.contextEpoch !== nativeCheckpoint.toEpoch
            ) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            const sourceManifest = yield* tx
              .transact(providerTurns.findManifestByTurn(outputTurnId))
              .pipe(Effect.mapError(failure));
            if (sourceManifest === null) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            let sourceManifestJson: Record<string, unknown>;
            try {
              const parsed = JSON.parse(sourceManifest.manifestJson) as unknown;
              if (
                typeof parsed !== "object" ||
                parsed === null ||
                Array.isArray(parsed)
              ) {
                return yield* Effect.fail(
                  failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                );
              }
              sourceManifestJson = parsed as Record<string, unknown>;
            } catch {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            if (
              sourceManifestJson.providerTurnId !== outputProviderTurnId ||
              sourceManifestJson.executionId !== input.execution.executionId ||
              sourceManifestJson.sessionId !== input.execution.sessionId ||
              sourceManifestJson.contextEpoch !==
                replacementLink.contextEpoch ||
              sourceManifestJson.operationKind !== "Inference" ||
              sourceManifestJson.logicalStepNo !==
                sourceStep.identity.logicalStepNo ||
              sourceManifestJson.repairAttempt !==
                sourceStep.identity.repairAttempt ||
              sourceManifestJson.resolvedModelBindingFingerprint !==
                nativeManifestJson.resolvedModelBindingFingerprint ||
              !hasValidCompiledInferenceRequestHash(
                sourceManifestJson,
                sourceManifest.portableRequestJson,
              )
            ) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
          }
          if (options.qualificationProbe !== undefined) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH19NativeCheckpointRecovery",
                  stage: "PortableSummaryStarted",
                  executionId: String(input.execution.executionId),
                  providerTurnId: nativeCheckpointProviderTurnId,
                }) ?? Promise.resolve(),
            );
          }
          const rebuilt = yield* runSummaryCompaction(
            {
              execution: input.execution,
              logicalStepNo: sourceStepIdentity.logicalStepNo,
              sourceAgentLoopStep: {
                executionId: String(sourceStepIdentity.executionId),
                logicalStepNo: sourceStepIdentity.logicalStepNo,
                repairAttempt: sourceStepIdentity.repairAttempt,
                providerTurnId: String(sourceStep.providerTurnId),
              },
              currentEpoch: sessionRecord.value.contextEpoch,
              modelRef: capability.modelRef,
              ...(options.secretRef === undefined
                ? {}
                : { secretRef: options.secretRef }),
              bindingFingerprint: currentBindingFingerprint,
              inputFrontier: { firstSequence, lastSequence },
              contextRefs: portableContextRefs,
              inputItems: portableItems,
              ...(yield* loadWorkCompactionPinning()),
              fence: loopStepFence,
            },
            {
              providerRuntime,
              sessions,
              tx,
              ...(options.qualificationProbe === undefined
                ? {}
                : { qualificationProbe: options.qualificationProbe }),
            },
          ).pipe(Effect.mapError(failure));
          if (options.qualificationProbe !== undefined) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH19NativeCheckpointRecovery",
                  stage: "PortableSummaryCommitted",
                  executionId: String(input.execution.executionId),
                  providerTurnId: nativeCheckpointProviderTurnId,
                }) ?? Promise.resolve(),
            );
          }
          if (
            Number(rebuilt.newEpoch) !==
            Number(sessionRecord.value.contextEpoch) + 1
          ) {
            return yield* Effect.fail(
              failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
            );
          }
          if (sourceStep.state === "StepEffectsCommitted") {
            const terminalInboxEpisode = executionEpisode(input.execution);
            const terminalMessageId = conversationResponseEpisode(
              input.execution,
            );
            const terminalInboxEntryKey =
              terminalInboxEpisode?._tag === "InboxEpisode"
                ? terminalInboxEpisode.entryKey
                : undefined;
            if (
              terminalMessageId !== null ||
              terminalInboxEntryKey !== undefined
            ) {
              const outputSequence = sourceStep.modelOutputSessionSequence;
              const outputHash = sourceStep.decodedOutputHash;
              const outputRows = recentSessionEntries.filter(
                (entry) => entry.sequence === outputSequence,
              );
              const replacementLinks = sourceStepLinks.filter(
                (link) => link.role === "OverflowReplacement",
              );
              const outputEntry = outputRows[0];
              const outputPayload =
                typeof outputEntry?.payload === "object" &&
                outputEntry.payload !== null
                  ? (outputEntry.payload as Record<string, unknown>)
                  : undefined;
              const outputProviderTurnId = outputPayload?.providerTurnId;
              const outputTurnId = decodedProviderTurnId(outputProviderTurnId);
              const replacementLink = replacementLinks[0];
              if (outputTurnId === null) {
                return yield* Effect.fail(
                  failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                );
              }
              const outputIdentityChecks = {
                sequence:
                  outputSequence !== undefined && outputHash !== undefined,
                oneRow: outputRows.length === 1,
                modelOutput: outputEntry?.entryKind === "ModelOutput",
                providerSource: outputEntry?.source?.kind === "ProviderTurn",
                assistantPayload: outputPayload?._tag === "AssistantMessage",
                providerId: true,
                sourceRef:
                  outputEntry?.source?.ref === `${outputTurnId}:assistant`,
                contentRef:
                  outputPayload?.contentRef ===
                  `provider:${outputTurnId}:assistant`,
                text:
                  typeof outputPayload?.text === "string" &&
                  typeof outputPayload.finishReason === "string",
                noActionCursor: sourceStep.nextActionIndex === 0,
                oneReplacementLink: replacementLinks.length === 1,
                linkStep:
                  replacementLink?.identity.executionId ===
                    sourceStep.identity.executionId &&
                  replacementLink.identity.logicalStepNo ===
                    sourceStep.identity.logicalStepNo &&
                  replacementLink.identity.repairAttempt ===
                    sourceStep.identity.repairAttempt,
                linkOrdinal: replacementLink?.overflowOrdinal === 0,
                linkProviderTurn:
                  replacementLink?.providerTurnId === outputTurnId,
                linkPredecessor:
                  replacementLink?.predecessorProviderTurnId ===
                  nativeCheckpointProviderTurnId,
                linkEpoch:
                  Number(replacementLink?.contextEpoch) ===
                  Number(nativeCheckpoint.toEpoch),
              };
              if (Object.values(outputIdentityChecks).some((valid) => !valid)) {
                if (options.qualificationProbe !== undefined) {
                  yield* Effect.promise(
                    () =>
                      options.qualificationProbe?.({
                        boundary: "AH19NativeCheckpointRecovery",
                        stage: `NativeRebaseTerminalIdentityChecks:${Object.entries(
                          outputIdentityChecks,
                        )
                          .map(([key, value]) => `${key}=${String(value)}`)
                          .join(",")}`,
                        executionId: String(input.execution.executionId),
                        providerTurnId: nativeCheckpointProviderTurnId,
                      }) ?? Promise.resolve(),
                  );
                }
                return yield* Effect.fail(
                  failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                );
              }
              const [outputResult, outputManifest] = yield* Effect.all(
                [
                  tx.transact(providerTurns.findSettledResult(outputTurnId)),
                  tx.transact(providerTurns.findManifestByTurn(outputTurnId)),
                ],
                { concurrency: 1 },
              ).pipe(Effect.mapError(failure));
              const outputResultChecks = {
                success: outputResult._tag === "SettledSuccess",
                version:
                  outputResult._tag === "SettledSuccess" &&
                  outputResult.evidenceVersion === "provider-success-v1",
                finish:
                  outputResult._tag === "SettledSuccess" &&
                  outputResult.finishReason === outputPayload?.finishReason,
                turnId:
                  outputResult._tag === "SettledSuccess" &&
                  outputResult.turn.providerTurnId === outputTurnId,
                execution:
                  outputResult._tag === "SettledSuccess" &&
                  outputResult.turn.executionId === input.execution.executionId,
                session:
                  outputResult._tag === "SettledSuccess" &&
                  outputResult.turn.sessionId === input.execution.sessionId,
                epoch:
                  outputResult._tag === "SettledSuccess" &&
                  outputResult.turn.contextEpoch ===
                    replacementLink?.contextEpoch,
                model:
                  outputResult._tag === "SettledSuccess" &&
                  outputResult.turn.modelRef === capability.modelRef,
                manifestId:
                  outputResult._tag === "SettledSuccess" &&
                  outputResult.manifestId === outputResult.turn.manifestId,
                manifestFound: outputManifest !== null,
                manifestIdMatches:
                  outputManifest !== null &&
                  outputResult._tag === "SettledSuccess" &&
                  outputManifest.manifestId === outputResult.manifestId,
                manifestJsonMatches:
                  outputManifest !== null &&
                  outputResult._tag === "SettledSuccess" &&
                  outputManifest.manifestJson === outputResult.manifestJson,
              };
              if (Object.values(outputResultChecks).some((valid) => !valid)) {
                if (options.qualificationProbe !== undefined) {
                  yield* Effect.promise(
                    () =>
                      options.qualificationProbe?.({
                        boundary: "AH19NativeCheckpointRecovery",
                        stage: `NativeRebaseTerminalResultChecks:${Object.entries(
                          outputResultChecks,
                        )
                          .map(([key, value]) => `${key}=${String(value)}`)
                          .join(",")}`,
                        executionId: String(input.execution.executionId),
                        providerTurnId: nativeCheckpointProviderTurnId,
                      }) ?? Promise.resolve(),
                  );
                }
                return yield* Effect.fail(
                  failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                );
              }
              if (
                outputResult._tag !== "SettledSuccess" ||
                outputManifest === null
              ) {
                return yield* Effect.fail(
                  failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                );
              }
              let outputManifestJson: Record<string, unknown>;
              try {
                const parsed = JSON.parse(
                  outputManifest.manifestJson,
                ) as unknown;
                if (
                  typeof parsed !== "object" ||
                  parsed === null ||
                  Array.isArray(parsed)
                ) {
                  return yield* Effect.fail(
                    failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                  );
                }
                outputManifestJson = parsed as Record<string, unknown>;
              } catch {
                return yield* Effect.fail(
                  failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                );
              }
              const outputManifestChecks = {
                providerTurn:
                  outputManifestJson.providerTurnId === outputProviderTurnId,
                execution:
                  outputManifestJson.executionId ===
                  input.execution.executionId,
                session:
                  outputManifestJson.sessionId === input.execution.sessionId,
                epoch:
                  outputManifestJson.contextEpoch ===
                  outputResult.turn.contextEpoch,
                model: outputManifestJson.modelRef === capability.modelRef,
                operation: outputManifestJson.operationKind === "Inference",
                step:
                  outputManifestJson.logicalStepNo ===
                  sourceStep.identity.logicalStepNo,
                repair:
                  outputManifestJson.repairAttempt ===
                  sourceStep.identity.repairAttempt,
                contract:
                  outputManifestJson.outputContractRef ===
                  outputResult.turn.outputContractRef,
                requestHash: hasValidCompiledInferenceRequestHash(
                  outputManifestJson,
                  outputManifest.portableRequestJson,
                ),
                sourceBinding:
                  outputManifestJson.resolvedModelBindingFingerprint ===
                  nativeManifestJson.resolvedModelBindingFingerprint,
              };
              if (Object.values(outputManifestChecks).some((valid) => !valid)) {
                if (options.qualificationProbe !== undefined) {
                  yield* Effect.promise(
                    () =>
                      options.qualificationProbe?.({
                        boundary: "AH19NativeCheckpointRecovery",
                        stage: `NativeRebaseTerminalManifestChecks:${Object.entries(
                          outputManifestChecks,
                        )
                          .map(([key, value]) => `${key}=${String(value)}`)
                          .join(",")}`,
                        executionId: String(input.execution.executionId),
                        providerTurnId: nativeCheckpointProviderTurnId,
                      }) ?? Promise.resolve(),
                  );
                }
                return yield* Effect.fail(
                  failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                );
              }
              const decodedOutput = decodeTurn(outputResult.canonicalEvents);
              const sourceActions = yield* tx
                .transact(loopSteps.listActions(sourceStep.identity))
                .pipe(Effect.mapError(failure));
              const decodedOutputChecks = {
                decoded: decodedOutput.ok,
                noActions: sourceActions.length === 0,
                text:
                  decodedOutput.ok &&
                  decodedOutput.output.text === outputPayload?.text,
                finish:
                  decodedOutput.ok &&
                  decodedOutput.output.finishReason ===
                    outputPayload?.finishReason,
                hash:
                  decodedOutput.ok &&
                  sha256Hex(
                    JSON.stringify({
                      providerTurnId: outputProviderTurnId,
                      outputContractRef: outputResult.turn.outputContractRef,
                      decoderVersion: "decode-turn-v1",
                      text: decodedOutput.output.text,
                      finishReason: decodedOutput.output.finishReason,
                      toolInvocations: decodedOutput.output.toolInvocations,
                    }),
                  ) === outputHash,
              };
              if (Object.values(decodedOutputChecks).some((valid) => !valid)) {
                if (options.qualificationProbe !== undefined) {
                  yield* Effect.promise(
                    () =>
                      options.qualificationProbe?.({
                        boundary: "AH19NativeCheckpointRecovery",
                        stage: `NativeRebaseTerminalDecodeChecks:${Object.entries(
                          decodedOutputChecks,
                        )
                          .map(([key, value]) => `${key}=${String(value)}`)
                          .join(",")}`,
                        executionId: String(input.execution.executionId),
                        providerTurnId: nativeCheckpointProviderTurnId,
                      }) ?? Promise.resolve(),
                  );
                }
                return yield* Effect.fail(
                  failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                );
              }
              if (!decodedOutput.ok) {
                return yield* Effect.fail(
                  failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                );
              }
              if (
                decodedOutput.output.toolInvocations.length === 0 &&
                decodedOutput.output.text.trim().length > 0 &&
                (terminalMessageId !== null ||
                  terminalInboxEntryKey !== undefined)
              ) {
                const settlement: ExecutionSettlement =
                  terminalMessageId !== null
                    ? {
                        _tag: "Completed",
                        result: {
                          _tag: "ConversationResponseProduced",
                          messageId: terminalMessageId.messageId,
                        },
                      }
                    : terminalInboxEntryKey !== undefined
                      ? {
                          _tag: "Completed",
                          result: {
                            _tag: "InboxInputHandled",
                            entryKey: terminalInboxEntryKey,
                          },
                        }
                      : {
                          _tag: "Failed",
                          failure: {
                            _tag: "ExecutionFailure",
                            reason: "terminal inbox identity missing",
                          },
                        };
                yield* tx
                  .transact(
                    loopSteps.transition(
                      {
                        identity: sourceStep.identity,
                        expectedRevision: sourceStep.revision,
                        expectedState: "StepEffectsCommitted",
                        next: {
                          ...sourceStep,
                          state: "SettlementProposed",
                          settlement,
                          revision: sourceStep.revision + 1,
                          updatedAt: yield* now(),
                        },
                      },
                      loopStepFence,
                    ),
                  )
                  .pipe(Effect.mapError(failure));
                return { _tag: "Settle", settlement };
              }
            }
            if (
              sourceStep.successor !== undefined ||
              loopSteps === undefined ||
              loopStepFence === undefined ||
              turn + 1 >= MAX_TURNS
            ) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            const successorIdentity = {
              executionId: sourceStep.identity.executionId,
              logicalStepNo: sourceStep.identity.logicalStepNo + 1,
              repairAttempt: 0,
            } as const;
            const successorProviderTurnId = providerTurnInferenceId(
              input.execution.executionId,
              successorIdentity.logicalStepNo,
            );
            const successorUpdatedAt = yield* now();
            const predecessorUpdatedAt = yield* now();
            yield* tx
              .transact(
                Effect.gen(function* () {
                  yield* loopSteps.transition(
                    {
                      identity: sourceStep.identity,
                      expectedRevision: sourceStep.revision,
                      expectedState: "StepEffectsCommitted",
                      next: {
                        ...sourceStep,
                        state: "NextStepReady",
                        successor: {
                          ...successorIdentity,
                          providerTurnId: successorProviderTurnId,
                        },
                        nextStepReason: "Continue",
                        revision: sourceStep.revision + 1,
                        updatedAt: predecessorUpdatedAt,
                      },
                    },
                    loopStepFence,
                  );
                  yield* loopSteps.ensureSuccessor(
                    sourceStep.identity,
                    {
                      identity: successorIdentity,
                      predecessor: sourceStep.identity,
                      providerTurnId: successorProviderTurnId,
                      state: "Prepared",
                      nextActionIndex: 0,
                      revision: 0,
                      updatedAt: successorUpdatedAt,
                    },
                    loopStepFence,
                  );
                }),
              )
              .pipe(Effect.mapError(failure));
            if (options.qualificationProbe !== undefined) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "AH19NativeCheckpointRecovery",
                    stage: `NativeRebaseCompletesStepEffectsSuccessor:from=${sourceStep.identity.logicalStepNo}:to=${successorIdentity.logicalStepNo}:providerTurn=${successorProviderTurnId}`,
                    executionId: String(input.execution.executionId),
                    providerTurnId: nativeCheckpointProviderTurnId,
                  }) ?? Promise.resolve(),
              );
            }
            turn = successorIdentity.logicalStepNo;
            repairAttempt = 0;
            compactionAttempts = 0;
            overflowRecoveryAttempt = 0;
            replayPersistedContextLimit = false;
            overflowReplacementProviderTurnId = undefined;
            resumeOverflowCompactionProviderTurnId = undefined;
            resumeOverflowNativeCompaction = false;
            resumeOverflowNativeCompactionInput = undefined;
            continue;
          }
          if (
            sourceStep.state === "NextStepReady" &&
            sourceStep.successor !== undefined
          ) {
            const sourceSuccessor = sourceStep.successor;
            const successorIdentity = {
              executionId: sourceSuccessor.executionId,
              logicalStepNo: sourceSuccessor.logicalStepNo,
              repairAttempt: sourceSuccessor.repairAttempt,
            };
            const successorOption = yield* tx
              .transact(loopSteps.find(successorIdentity))
              .pipe(Effect.mapError(failure));
            const successorRecord = Option.isSome(successorOption)
              ? successorOption.value
              : undefined;
            const successorChecks = {
              exists: successorRecord !== undefined,
              execution:
                successorIdentity.executionId === input.execution.executionId,
              exactNextStep:
                successorIdentity.logicalStepNo ===
                sourceStepIdentity.logicalStepNo + 1,
              initialRepair: successorIdentity.repairAttempt === 0,
              providerTurn:
                successorRecord?.providerTurnId ===
                sourceSuccessor.providerTurnId,
              predecessorExecution:
                successorRecord?.predecessor?.executionId ===
                sourceStepIdentity.executionId,
              predecessorStep:
                successorRecord?.predecessor?.logicalStepNo ===
                sourceStepIdentity.logicalStepNo,
              predecessorRepair:
                successorRecord?.predecessor?.repairAttempt ===
                sourceStepIdentity.repairAttempt,
            };
            if (options.qualificationProbe !== undefined) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "AH19NativeCheckpointRecovery",
                    stage: `NativeRebaseSuccessorChecks:${Object.entries(
                      successorChecks,
                    )
                      .map(([key, value]) => `${key}=${String(value)}`)
                      .join(",")}`,
                    executionId: String(input.execution.executionId),
                    providerTurnId: nativeCheckpointProviderTurnId,
                  }) ?? Promise.resolve(),
              );
            }
            if (Object.values(successorChecks).some((valid) => !valid)) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            if (options.qualificationProbe !== undefined) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "AH19NativeCheckpointRecovery",
                    stage: `NativeRebaseResumesPersistedSuccessor:from=${sourceStepIdentity.logicalStepNo}:to=${successorIdentity.logicalStepNo}:providerTurn=${sourceSuccessor.providerTurnId}`,
                    executionId: String(input.execution.executionId),
                    providerTurnId: nativeCheckpointProviderTurnId,
                  }) ?? Promise.resolve(),
              );
            }
            turn = successorIdentity.logicalStepNo;
            repairAttempt = successorIdentity.repairAttempt;
            compactionAttempts = 0;
            overflowRecoveryAttempt = 0;
            replayPersistedContextLimit = false;
            overflowReplacementProviderTurnId = undefined;
            resumeOverflowCompactionProviderTurnId = undefined;
            resumeOverflowNativeCompaction = false;
            resumeOverflowNativeCompactionInput = undefined;
            continue;
          }
          const stepProviderLinks = sourceStepLinks;
          const overflowNativeLink = stepProviderLinks.some(
            (link) =>
              link.role === "OverflowCompaction" &&
              link.providerTurnId === nativeProviderTurnId,
          );
          if (overflowNativeLink) {
            if (loopSteps === undefined) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            const replacementProviderTurnId =
              makeOverflowReplacementProviderTurnId(
                input.execution.executionId,
                sourceStepIdentity.logicalStepNo,
              );
            const existingReplacement = stepProviderLinks.filter(
              (link) => link.role === "OverflowReplacement",
            );
            if (existingReplacement.length > 1) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            const priorReplacement = existingReplacement[0];
            if (priorReplacement !== undefined) {
              if (options.qualificationProbe !== undefined) {
                yield* Effect.promise(
                  () =>
                    options.qualificationProbe?.({
                      boundary: "AH19NativeCheckpointRecovery",
                      stage: `ExistingOverflowReplacement:sourceStep=${sourceStepIdentity.logicalStepNo}:state=${sourceStep.state}:successor=${sourceStep.successor?.providerTurnId ?? "none"}:linkEpoch=${Number(priorReplacement.contextEpoch)}:rebuiltEpoch=${Number(rebuilt.newEpoch)}`,
                      executionId: String(input.execution.executionId),
                      providerTurnId: nativeCheckpointProviderTurnId,
                    }) ?? Promise.resolve(),
                );
              }
              if (
                priorReplacement.providerTurnId !== replacementProviderTurnId ||
                priorReplacement.predecessorProviderTurnId !==
                  nativeProviderTurnId ||
                Number(priorReplacement.contextEpoch) !==
                  Number(rebuilt.newEpoch)
              ) {
                return yield* Effect.fail(
                  failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                );
              }
            } else {
              yield* tx
                .transact(
                  loopSteps.ensureProviderTurnLink(
                    {
                      identity: loopStepIdentity,
                      overflowOrdinal: 0,
                      role: "OverflowReplacement",
                      providerTurnId: replacementProviderTurnId,
                      predecessorProviderTurnId: nativeProviderTurnId,
                      contextEpoch: parse(ContextEpochNumber)(
                        Number(rebuilt.newEpoch),
                      ),
                      state: "Prepared",
                      createdAt: yield* now(),
                    },
                    loopStepFence,
                  ),
                )
                .pipe(Effect.mapError(failure));
            }
            overflowRecoveryAttempt = 1;
            overflowReplacementProviderTurnId = replacementProviderTurnId;
            replayPersistedContextLimit = false;
            resumeOverflowCompactionProviderTurnId = undefined;
          }
          compactionAttempts = Math.max(compactionAttempts, 1);
          continue;
        }
      }
      const workspace = yield* tx
        .transact(workspaces.findById(input.execution.workspaceId))
        .pipe(Effect.mapError(failure));
      if (Option.isNone(workspace)) {
        return yield* Effect.fail(
          failure({
            _tag: "WorkspaceContextMissing",
            workspaceId: input.execution.workspaceId,
          }),
        );
      }
      if (workspaceKnowledge !== undefined) {
        const knowledge = yield* workspaceKnowledge
          .load(input.execution.workspaceId)
          .pipe(Effect.mapError(failure));
        if (knowledge.entries.length > 0) {
          inputItems.push({
            _tag: "ContextUpdate",
            sourceRef: `workspace-knowledge:${input.execution.workspaceId}`,
            revision: Number(workspace.value.revision),
            updateKind: "Full",
            text: JSON.stringify({
              scope: "accepted-workspace-knowledge",
              provenance: "CanonicalAcceptance",
              entries: knowledge.entries,
            }),
          });
          messageContextRefs.push(
            `workspace-knowledge:${input.execution.workspaceId}:${knowledge.fingerprint}`,
          );
        }
      }
      if (placementExecution && workspacePlacement !== undefined) {
        const placement = yield* workspacePlacement
          .list({ rootWorkspaceId: input.execution.workspaceId })
          .pipe(Effect.mapError(failure));
        inputItems.push({
          _tag: "ContextUpdate",
          sourceRef: `workspace-placement:${input.execution.workspaceId}`,
          revision: Number(workspace.value.revision),
          updateKind: "Full",
          text: JSON.stringify({
            scope: "workspace-placement",
            current: placement.current,
            directChildren: placement.directChildren,
            inFlightFormations: placement.inFlightFormations,
            nextCursor: placement.nextCursor,
          }),
        });
        messageContextRefs.push(
          `workspace-placement:${input.execution.workspaceId}:${placement.fingerprint}`,
        );
      }
      let currentWork: import("@arbor/domain").Work | null = null;
      const boundWork = workEpisode(input.execution);
      if (boundWork !== null) {
        const work = yield* tx
          .transact(works.findById(boundWork.workId))
          .pipe(Effect.mapError(failure));
        if (Option.isNone(work)) {
          return yield* Effect.fail(
            failure({
              _tag: "WorkContextMissing",
              workId: boundWork.workId,
            }),
          );
        }
        currentWork = work.value;
        if (
          localPlans !== undefined &&
          executionEpisode(input.execution)?._tag === "WorkEpisode"
        ) {
          const plan = yield* tx
            .transact(localPlans.findByWork(boundWork.workId))
            .pipe(Effect.mapError(failure));
          if (
            Option.isSome(plan) &&
            plan.value.targetWorkRevision === currentWork.revision
          ) {
            inputItems.push({
              _tag: "ContextUpdate",
              sourceRef: `local-plan:${boundWork.workId}`,
              revision: plan.value.revision,
              updateKind: "Full",
              text: JSON.stringify({
                scope: "progress-only",
                items: plan.value.items,
              }),
            });
            messageContextRefs.push(
              `local-plan:${boundWork.workId}:${String(plan.value.revision)}`,
            );
          }
          if (
            nativeCheckpoint !== undefined &&
            !nativeCheckpoint.bindingMatches
          ) {
            if (providerTurns === undefined || loopStepFence === undefined) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            let nativeProviderTurnId: ProviderTurnId;
            try {
              nativeProviderTurnId = parse(ProviderTurnId)(
                nativeCheckpoint.providerTurnId,
              );
            } catch {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            const [nativeManifestRow, nativeReceipt] = yield* Effect.all(
              [
                tx.transact(
                  providerTurns.findManifestByTurn(nativeProviderTurnId),
                ),
                tx.transact(
                  providerTurns.findSettledResult(nativeProviderTurnId),
                ),
              ],
              { concurrency: 1 },
            ).pipe(Effect.mapError(failure));
            if (
              nativeManifestRow === null ||
              nativeReceipt._tag !== "SettledSuccess" ||
              nativeReceipt.evidenceVersion !== "provider-success-v1" ||
              nativeReceipt.finishReason !== "Stop" ||
              nativeReceipt.turn.providerTurnId !== nativeProviderTurnId ||
              nativeReceipt.turn.sessionId !== input.execution.sessionId ||
              nativeReceipt.manifestJson !== nativeManifestRow.manifestJson
            ) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            const nativeFrontier = decodeUniqueNativePortableFrontier(
              nativeManifestRow.manifestJson,
              nativeManifestRow.portableRequestJson,
            );
            const nativeManifest = nativeFrontier?.manifest;
            const nativeStateRefs = nativeReceipt.canonicalEvents.filter(
              (event) => event._tag === "ContinuationState",
            );
            if (
              nativeFrontier === null ||
              nativeManifest === undefined ||
              nativeManifest.providerTurnId !== nativeProviderTurnId ||
              nativeManifest.executionId !== nativeReceipt.turn.executionId ||
              nativeManifest.sessionId !== input.execution.sessionId ||
              nativeManifest.contextEpoch !== nativeCheckpoint.fromEpoch ||
              nativeManifest.operationKind !== "CompactionNative" ||
              nativeManifest.outputContractRef !==
                "provider-native-compaction-v1" ||
              nativeManifest.resolvedModelBindingFingerprint !==
                nativeCheckpoint.bindingFingerprint ||
              nativeReceipt.turn.contextEpoch !== nativeCheckpoint.fromEpoch ||
              nativeReceipt.turn.modelRef !== nativeManifest.modelRef ||
              nativeReceipt.turn.outputContractRef !==
                "provider-native-compaction-v1" ||
              nativeStateRefs.length !== 1 ||
              nativeStateRefs[0]?._tag !== "ContinuationState" ||
              nativeStateRefs[0].stateRef !== nativeCheckpoint.opaqueItemRef ||
              (nativeFrontier.inputFrontier.lastSequence !== null &&
                nativeFrontier.inputFrontier.lastSequence >=
                  nativeCheckpoint.sequence) ||
              nativeFrontier.inputItems.some(
                (item) =>
                  item._tag === "CompactionCheckpoint" &&
                  item.implementation === "ProviderNative",
              )
            ) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            const postCheckpointEntries = recentSessionEntries.filter(
              (entry) => entry.sequence > nativeCheckpoint.sequence,
            );
            const postCheckpointProjection = projectSessionTimeline(
              postCheckpointEntries,
              currentBindingFingerprint,
              providerNativeSupported,
            );
            if (postCheckpointProjection.nativeCheckpoint !== undefined) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            const portableContextRefs = [
              ...nativeFrontier.contextRefs,
              ...postCheckpointProjection.contextRefs,
            ];
            if (
              portableContextRefs.length === 0 ||
              new Set(portableContextRefs).size !== portableContextRefs.length
            ) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            const rebuiltFrontier = {
              firstSequence: nativeFrontier.inputFrontier.firstSequence,
              lastSequence:
                postCheckpointProjection.frontier.lastSequence !== null
                  ? postCheckpointProjection.frontier.lastSequence
                  : nativeFrontier.inputFrontier.lastSequence,
            };
            if (
              rebuiltFrontier.firstSequence !== null &&
              rebuiltFrontier.lastSequence !== null &&
              rebuiltFrontier.lastSequence < rebuiltFrontier.firstSequence
            ) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            const [stepProviderLinks, sourceSession] = yield* Effect.all(
              [
                loopSteps === undefined
                  ? Effect.succeed([])
                  : tx.transact(
                      loopSteps.listProviderTurnLinks(loopStepIdentity),
                    ),
                tx.transact(sessions.findById(input.execution.sessionId)),
              ],
              { concurrency: 1 },
            ).pipe(Effect.mapError(failure));
            if (Option.isNone(sourceSession)) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            const isOverflowNativeCheckpoint = stepProviderLinks.some(
              (link) =>
                link.role === "OverflowCompaction" &&
                link.providerTurnId === nativeProviderTurnId,
            );
            const portableItems = [
              ...nativeFrontier.inputItems,
              ...postCheckpointProjection.inputItems,
            ];
            if (loopStep === undefined) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            const rebuilt = yield* runSummaryCompaction(
              {
                execution: input.execution,
                logicalStepNo: loopStepIdentity.logicalStepNo,
                sourceAgentLoopStep: {
                  executionId: String(loopStepIdentity.executionId),
                  logicalStepNo: loopStepIdentity.logicalStepNo,
                  repairAttempt: loopStepIdentity.repairAttempt,
                  providerTurnId: String(loopStep.providerTurnId),
                },
                currentEpoch: sourceSession.value.contextEpoch,
                modelRef: capability.modelRef,
                ...(options.secretRef === undefined
                  ? {}
                  : { secretRef: options.secretRef }),
                bindingFingerprint: currentBindingFingerprint,
                inputFrontier: rebuiltFrontier,
                contextRefs: portableContextRefs,
                inputItems: portableItems,
                ...(yield* loadWorkCompactionPinning()),
                fence: loopStepFence,
              },
              {
                providerRuntime,
                sessions,
                tx,
                ...(options.qualificationProbe === undefined
                  ? {}
                  : { qualificationProbe: options.qualificationProbe }),
              },
            ).pipe(Effect.mapError(failure));
            if (
              Number(rebuilt.newEpoch) !==
              Number(sourceSession.value.contextEpoch) + 1
            ) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            if (isOverflowNativeCheckpoint) {
              const replacementProviderTurnId =
                makeOverflowReplacementProviderTurnId(
                  input.execution.executionId,
                  turn,
                );
              const existingReplacement = stepProviderLinks.filter(
                (link) => link.role === "OverflowReplacement",
              );
              if (existingReplacement.length > 1) {
                return yield* Effect.fail(
                  failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                );
              }
              const priorReplacement = existingReplacement[0];
              if (priorReplacement !== undefined) {
                if (
                  priorReplacement.providerTurnId !==
                    replacementProviderTurnId ||
                  priorReplacement.predecessorProviderTurnId !==
                    nativeProviderTurnId ||
                  Number(priorReplacement.contextEpoch) !==
                    Number(rebuilt.newEpoch)
                ) {
                  return yield* Effect.fail(
                    failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                  );
                }
              } else {
                if (loopSteps === undefined) {
                  return yield* Effect.fail(
                    failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                  );
                }
                yield* tx
                  .transact(
                    loopSteps.ensureProviderTurnLink(
                      {
                        identity: loopStepIdentity,
                        overflowOrdinal: 0,
                        role: "OverflowReplacement",
                        providerTurnId: replacementProviderTurnId,
                        predecessorProviderTurnId: nativeProviderTurnId,
                        contextEpoch: parse(ContextEpochNumber)(
                          Number(rebuilt.newEpoch),
                        ),
                        state: "Prepared",
                        createdAt: yield* now(),
                      },
                      loopStepFence,
                    ),
                  )
                  .pipe(Effect.mapError(failure));
              }
              overflowRecoveryAttempt = 1;
              overflowReplacementProviderTurnId = replacementProviderTurnId;
              replayPersistedContextLimit = false;
            }
            compactionAttempts = Math.max(compactionAttempts, 1);
            continue;
          }
        }
      }
      const workContext = assembleWorkContext(
        workspace.value,
        currentWork,
        input.execution,
      );
      const compactionWorkPinning =
        executionEpisode(input.execution)?._tag === "WorkEpisode"
          ? {
              pinnedInstructions: workContext.fragments.map((fragment) => ({
                slotId: fragment.scope,
                authorityRole: fragment.authorityRole,
                text:
                  workContext.contents.get(fragment.contentRef) ??
                  fragment.contentRef,
              })),
              pinnedInstructionFragments: workContext.fragments.map(
                (fragment) => ({
                  identity: fragment.identity,
                  revision: fragment.revision,
                  hash: fragment.hash,
                  source: fragment.source,
                  scope: fragment.scope,
                }),
              ),
              controlBasis,
            }
          : {};
      const conversationActionAsset =
        GENERIC_INSTRUCTION_ASSETS.rootConversationAction;
      const conversationActionFragments = conversationExecution
        ? [
            instructionAssetFragment(
              "root-conversation-action",
              conversationActionAsset,
            ),
          ]
        : [];
      const workExecutionLoopAsset = GENERIC_INSTRUCTION_ASSETS.baseLoop;
      const instructionContents = new Map(workContext.contents);
      if (conversationExecution) {
        instructionContents.set(
          conversationActionAsset.contentRef,
          conversationActionAsset.text,
        );
      }
      const boundEpisode = executionEpisode(input.execution);
      if (
        boundEpisode?._tag === "DecisionEpisode" &&
        decisionRequests !== undefined
      ) {
        const request = yield* tx
          .transact(decisionRequests.findById(boundEpisode.decisionId))
          .pipe(Effect.mapError(failure));
        if (Option.isNone(request)) {
          return yield* proposeSettlement({
            _tag: "Failed",
            failure: {
              _tag: "ExecutionFailure",
              reason: "DecisionRequestMissingOrSettled",
            },
          });
        }
        let requestContextRevision = request.value.revision;
        if (request.value.state._tag !== "Pending") {
          const pinnedActions =
            loopStep !== undefined && loopSteps !== undefined
              ? yield* tx
                  .transact(loopSteps.listActions(loopStep.identity))
                  .pipe(Effect.mapError(failure))
              : [];
          const pendingSelectionAction = pinnedActions.find(
            (action) =>
              action.actionIndex === loopStep?.nextActionIndex &&
              action.routeKind === "Control" &&
              action.actionKind === "select_current_work" &&
              action.state === "Pending",
          );
          const pinnedProviderResult =
            loopStep !== undefined && providerTurns !== undefined
              ? yield* tx
                  .transact(
                    providerTurns.findSettledResult(loopStep.providerTurnId),
                  )
                  .pipe(Effect.mapError(failure))
              : undefined;
          const replayingPinnedSelection = isPinnedSubmittedDecisionReplay({
            executionWorkspaceId: String(input.execution.workspaceId),
            episode: boundEpisode,
            request: request.value,
            workspace: Option.isSome(workspace)
              ? {
                  currentWorkId:
                    workspace.value.currentWorkId === null
                      ? null
                      : String(workspace.value.currentWorkId),
                  revision: Number(workspace.value.revision),
                }
              : undefined,
            step: loopStep,
            pendingAction: pendingSelectionAction,
            providerTurnId: String(providerTurnId),
            providerResult:
              pinnedProviderResult?._tag === "SettledSuccess"
                ? {
                    _tag: "SettledSuccess",
                    manifestId: String(pinnedProviderResult.manifestId),
                  }
                : undefined,
          });
          const bindingFailure = classifySubmittedDecisionBindingFailure({
            executionWorkspaceId: String(input.execution.workspaceId),
            episode: boundEpisode,
            request: request.value,
            workspace: Option.isSome(workspace)
              ? {
                  currentWorkId:
                    workspace.value.currentWorkId === null
                      ? null
                      : String(workspace.value.currentWorkId),
                  revision: Number(workspace.value.revision),
                }
              : undefined,
            step: loopStep,
            pendingAction: pendingSelectionAction,
            providerTurnId: String(providerTurnId),
            providerResult:
              pinnedProviderResult?._tag === "SettledSuccess"
                ? {
                    _tag: "SettledSuccess",
                    manifestId: String(pinnedProviderResult.manifestId),
                  }
                : undefined,
          });
          if (
            bindingFailure !== undefined &&
            loopStep !== undefined &&
            pendingSelectionAction !== undefined
          ) {
            return {
              _tag: "SubmittedDecisionBindingMismatch",
              failureCode: bindingFailure,
              logicalStepNo: loopStep.identity.logicalStepNo,
              repairAttempt: loopStep.identity.repairAttempt,
              providerTurnId: loopStep.providerTurnId,
              logicalActionId: pendingSelectionAction.logicalActionId,
            };
          }
          if (!replayingPinnedSelection) {
            return yield* proposeSettlement({
              _tag: "Failed",
              failure: {
                _tag: "ExecutionFailure",
                reason: "DecisionRequestMissingOrSettled",
              },
            });
          }
          // The submitted canonical request is the result of this exact
          // pinned SelectCurrentWork Action. Rebuild its original decision
          // context only long enough to replay the settled Provider result;
          // no new Provider request or action is admitted from this snapshot.
          requestContextRevision = boundEpisode.requestRevision;
        }
        inputItems.push({
          _tag: "ContextUpdate",
          sourceRef: `decision-request:${boundEpisode.decisionId}`,
          revision: requestContextRevision,
          updateKind: "Full",
          text: JSON.stringify({
            decisionKind: "SelectCurrentWork",
            candidateWorkIds: request.value.candidateWorkIds,
            workspaceRevision: request.value.workspaceRevision,
          }),
        });
        messageContextRefs.push(
          `decision-request:${boundEpisode.decisionId}:${String(requestContextRevision)}`,
        );
      }
      if (resumeOverflowCompactionProviderTurnId !== undefined) {
        if (
          loopStep === undefined ||
          loopSteps === undefined ||
          loopStepFence === undefined
        ) {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        const expectedCompactionProviderTurnId = resumeOverflowNativeCompaction
          ? providerTurnNativeCompactionId(
              input.execution.executionId,
              turn,
              stepContext.contextEpoch,
            )
          : providerTurnSummaryCompactionId(
              input.execution.executionId,
              turn,
              stepContext.contextEpoch,
            );
        if (
          resumeOverflowCompactionProviderTurnId !==
          expectedCompactionProviderTurnId
        ) {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        const compacted = conversationExecution
          ? yield* Effect.gen(function* () {
              if (
                conversationOwner === undefined ||
                conversationProjection === undefined ||
                conversationCurrentJob === undefined ||
                dependencies.conversationCheckpoints === undefined ||
                dependencies.blobs === undefined ||
                providerTurns === undefined
              ) {
                return yield* Effect.fail(
                  failure({ _tag: "ConversationCheckpointRuntimeUnavailable" }),
                );
              }
              const sources = [
                ...conversationProjection.coveredAnswered,
                ...conversationProjection.uncoveredAnswered,
              ];
              const latest = sources.at(-1);
              const coveredThrough =
                latest === undefined
                  ? conversationProjection.checkpoint.coveredThrough
                  : {
                      createdAt: latest.message.createdAt,
                      messageId: latest.message.messageId,
                    };
              return yield* runConversationCheckpointCompaction(
                {
                  execution: input.execution,
                  logicalStepNo: loopStep?.identity.logicalStepNo ?? turn,
                  ...(resumeOverflowCompactionProviderTurnId === undefined
                    ? {}
                    : {
                        providerTurnId: resumeOverflowCompactionProviderTurnId,
                      }),
                  owner: conversationOwner,
                  sources,
                  coveredThrough,
                  currentMessageId: exactConversation?.messageId ?? "",
                  currentResponseJob: conversationCurrentJob,
                  checkpointKind:
                    resumeOverflowNativeCompaction && providerNativeSupported
                      ? "ProviderNative"
                      : "Summary",
                  bindingFingerprint: currentBindingFingerprint,
                  modelRef: capability.modelRef,
                  ...(options.secretRef === undefined
                    ? {}
                    : { secretRef: options.secretRef }),
                  fence: loopStepFence,
                  updatedAt: yield* now(),
                  ...(options.qualificationProbe === undefined
                    ? {}
                    : { qualificationProbe: options.qualificationProbe }),
                },
                {
                  providerRuntime,
                  checkpointStore: dependencies.conversationCheckpoints,
                  providerTurns,
                  blobs: dependencies.blobs,
                  tx,
                },
              ).pipe(Effect.mapError(failure));
            })
          : yield* runCompaction(
              {
                execution: input.execution,
                logicalStepNo: loopStep?.identity.logicalStepNo ?? turn,
                ...(loopStep === undefined
                  ? {}
                  : {
                      sourceAgentLoopStep: {
                        executionId: String(loopStep.identity.executionId),
                        logicalStepNo: loopStep.identity.logicalStepNo,
                        repairAttempt: loopStep.identity.repairAttempt,
                        providerTurnId: String(loopStep.providerTurnId),
                      },
                    }),
                currentEpoch: stepContext.contextEpoch,
                modelRef: capability.modelRef,
                ...(options.secretRef === undefined
                  ? {}
                  : { secretRef: options.secretRef }),
                bindingFingerprint: stepContext.bindingFingerprint,
                inputFrontier: stepContext.inputFrontier,
                contextRefs: messageContextRefs,
                inputItems,
                ...compactionWorkPinning,
                fence: loopStepFence,
                nativeSupported:
                  resumeOverflowNativeCompaction && providerNativeSupported,
                ...(resumeOverflowNativeCompactionInput === undefined
                  ? {}
                  : { nativeRecovery: resumeOverflowNativeCompactionInput }),
              },
              {
                providerRuntime,
                sessions,
                tx,
                ...(options.qualificationProbe === undefined
                  ? {}
                  : { qualificationProbe: options.qualificationProbe }),
              },
            ).pipe(Effect.mapError(failure));
        if (
          compacted.providerTurnId !== resumeOverflowCompactionProviderTurnId ||
          Number(compacted.newEpoch) !== Number(stepContext.contextEpoch) + 1
        ) {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        const replacementProviderTurnId = makeOverflowReplacementProviderTurnId(
          input.execution.executionId,
          turn,
        );
        yield* tx
          .transact(
            loopSteps.ensureProviderTurnLink(
              {
                identity: loopStepIdentity,
                overflowOrdinal: 0,
                role: "OverflowReplacement",
                providerTurnId: replacementProviderTurnId,
                predecessorProviderTurnId:
                  resumeOverflowCompactionProviderTurnId,
                contextEpoch: parse(ContextEpochNumber)(
                  Number(stepContext.contextEpoch) + 1,
                ),
                state: "Prepared",
                createdAt: yield* now(),
              },
              loopStepFence,
            ),
          )
          .pipe(Effect.mapError(failure));
        overflowRecoveryAttempt = 1;
        overflowReplacementProviderTurnId = replacementProviderTurnId;
        replayPersistedContextLimit = false;
        resumeOverflowNativeCompaction = false;
        resumeOverflowNativeCompactionInput = undefined;
        resumeOverflowCompactionProviderTurnId = undefined;
        continue;
      }
      const turnProfile = yield* turnProfileResolver
        .resolve({
          execution: input.execution,
          conversation:
            conversationExecution && conversationMessages.length > 0,
        })
        .pipe(Effect.mapError(failure));
      const workExecutionLoopFragments = workExecutionLoopFragmentsFor(
        turnProfile.purpose,
      );
      if (workExecutionLoopFragments.length > 0) {
        instructionContents.set(
          workExecutionLoopAsset.contentRef,
          workExecutionLoopAsset.text,
        );
      }
      const prepared = yield* Effect.match(
        modelContext.prepareTurn({
          executionId: input.execution.executionId,
          sessionId: input.execution.sessionId,
          contextEpoch: stepContext.contextEpoch,
          providerTurnId,
          binding: agentBinding,
          workspaceId: input.execution.workspaceId,
          cognitiveMode: input.agentExecutionState.currentMode ?? "execute",
          program: GENERIC_COGNITION_PROGRAM,
          fragments: [
            runtimeSafetyFragment,
            ...workContext.fragments,
            ...workExecutionLoopFragments,
            ...conversationActionFragments,
            ...repairFragments,
          ],
          contextFragments: historyContext.contextFragments,
          compressibleInputItemIndexes:
            historyContext.compressibleInputItemIndexes,
          budget: {
            modelWindow: capability.contextWindow,
            outputReserve: capability.outputCeiling,
            protocolReserve: 100,
            toolReserve: 100,
          },
          controlBasis,
          maxOutputTokens: capability.outputCeiling,
          bodySkillIds: [],
          turnProfile,
          instructionContents,
          stepContext,
          ...(inputItems.length > 0 ? { inputItems } : {}),
          ...(messageContextRefs.length > 0 ? { messageContextRefs } : {}),
          ...(options.providerRef !== undefined
            ? { providerRef: options.providerRef }
            : {}),
        }),
        {
          onFailure: (cause) => ({ ok: false as const, cause }),
          onSuccess: (value) => ({ ok: true as const, value }),
        },
      );
      if (!prepared.ok) {
        if (prepared.cause._tag === "ContextUnsatisfiable") {
          return yield* proposeSettlement({
            _tag: "Failed",
            failure: {
              _tag: "ExecutionFailure",
              reason: "ContextUnsatisfiable",
            },
          });
        }
        return yield* Effect.fail(failure(prepared.cause));
      }
      const preparation = prepared.value;

      if (preparation._tag === "GovernanceBlocked") {
        return yield* proposeSettlement(safetyStop("GovernanceBlocked"));
      }
      if (preparation._tag === "NeedsCompaction") {
        if (loopStepFence === undefined) {
          return yield* Effect.fail(
            failure({
              _tag: "CompactionFenceUnavailable",
              executionId: input.execution.executionId,
            }),
          );
        }
        if (compactionAttempts >= 1) {
          return yield* proposeSettlement(safetyStop("CompactionNoGain"));
        }
        compactionAttempts += 1;
        const nativeSupported =
          capability.portableRequestCompatibility?.operationKinds.includes(
            "CompactionNative",
          ) === true;
        yield* runCompaction(
          {
            execution: input.execution,
            logicalStepNo: loopStep?.identity.logicalStepNo ?? turn,
            ...(loopStep === undefined
              ? {}
              : {
                  sourceAgentLoopStep: {
                    executionId: String(loopStep.identity.executionId),
                    logicalStepNo: loopStep.identity.logicalStepNo,
                    repairAttempt: loopStep.identity.repairAttempt,
                    providerTurnId: String(loopStep.providerTurnId),
                  },
                }),
            currentEpoch: stepContext.contextEpoch,
            modelRef: capability.modelRef,
            ...(options.secretRef === undefined
              ? {}
              : { secretRef: options.secretRef }),
            bindingFingerprint: stepContext.bindingFingerprint,
            inputFrontier: stepContext.inputFrontier,
            contextRefs: messageContextRefs,
            inputItems,
            ...compactionWorkPinning,
            fence: loopStepFence,
            nativeSupported,
          },
          {
            providerRuntime,
            sessions,
            tx,
            ...(options.qualificationProbe === undefined
              ? {}
              : { qualificationProbe: options.qualificationProbe }),
          },
        ).pipe(Effect.mapError(failure));
        continue;
      }

      const turnInput: ProviderRunInput = {
        providerTurnId: preparation.turn.manifest.providerTurnId,
        executionId: input.execution.executionId,
        sessionId: input.execution.sessionId,
        contextEpoch: preparation.turn.manifest.contextEpoch,
        modelRef: capability.modelRef,
        outputContractRef: preparation.turn.manifest.outputContractRef,
        ...(options.onProviderProgress !== undefined
          ? {
              onProgress: (
                event: import("@arbor/ports").ProviderRuntimeProgress,
              ) => {
                options.onProviderProgress?.(
                  String(input.execution.executionId),
                  event,
                );
              },
            }
          : {}),
        manifestJson: JSON.stringify(preparation.turn.manifest),
        request: preparation.turn.request,
        ...(options.secretRef !== undefined
          ? { secretRef: options.secretRef }
          : {}),
        ...(options.executionPolicyOverrides !== undefined
          ? {
              executionPolicyOverrides: options.executionPolicyOverrides,
            }
          : {}),
      };
      if (
        loopStep !== undefined &&
        loopSteps !== undefined &&
        loopStepFence !== undefined &&
        providerTurns !== undefined &&
        loopStep.state !== "OutputRejected"
      ) {
        const durableLoopSteps = loopSteps;
        const durableFence = loopStepFence;
        const settled = yield* tx
          .transact(
            providerTurns.findSettledResult(
              preparation.turn.manifest.providerTurnId,
            ),
          )
          .pipe(Effect.mapError(failure));
        if (settled._tag === "SettledSuccess") {
          let persistedManifest: typeof preparation.turn.manifest;
          try {
            persistedManifest = JSON.parse(
              settled.manifestJson,
            ) as typeof preparation.turn.manifest;
          } catch {
            return yield* Effect.fail(
              failure({
                _tag: "AgentLoopStepReplayManifestInvalid",
              }),
            );
          }
          if (
            settled.turn.executionId !== input.execution.executionId ||
            settled.turn.sessionId !== input.execution.sessionId ||
            settled.turn.contextEpoch !==
              preparation.turn.manifest.contextEpoch ||
            persistedManifest.providerTurnId !== settled.turn.providerTurnId ||
            persistedManifest.executionId !== settled.turn.executionId ||
            persistedManifest.sessionId !== settled.turn.sessionId ||
            persistedManifest.contextEpoch !== settled.turn.contextEpoch ||
            persistedManifest.modelRef !== settled.turn.modelRef ||
            persistedManifest.outputContractRef !==
              settled.turn.outputContractRef
          ) {
            return yield* Effect.fail(
              failure({
                _tag: "AgentLoopStepReplayBindingMismatch",
              }),
            );
          }
          const decoded = decodeTurn(settled.canonicalEvents);
          if (settled.evidenceVersion === "legacy-success-v1" && !decoded.ok) {
            return yield* Effect.fail(
              failure({
                _tag: "LegacyProviderResultRequiresAttention",
                reason: decoded.reason,
              }),
            );
          }
          if (
            settled.evidenceVersion === "legacy-success-v1" &&
            decoded.ok &&
            decoded.output.toolInvocations.length > 0 &&
            loopStep.state === "Prepared"
          ) {
            const episode = executionEpisode(input.execution);
            const recoveryStore = dependencies.recoveryAttentionFacts;
            const recordLegacyAdoptionFailure =
              recoveryStore?.recordLegacyAdoptionFailure;
            const resolveLegacyAdoptionFailure =
              recoveryStore?.resolveLegacyAdoptionFailure;
            if (
              loopStepFence === undefined ||
              recordLegacyAdoptionFailure === undefined ||
              resolveLegacyAdoptionFailure === undefined ||
              episode === undefined ||
              settled.settledAt === undefined ||
              settled.settledAt.length === 0
            ) {
              return yield* Effect.fail(
                failure({
                  _tag: "LegacyProviderResultRequiresAttention",
                  reason:
                    "legacy action disposition cannot be safely inspected",
                }),
              );
            }
            const actionEvidence = [];
            for (const [
              actionIndex,
              invocation,
            ] of decoded.output.toolInvocations.entries()) {
              const matches = persistedManifest.toolRoutes.filter(
                (route) => route.name === invocation.toolName,
              );
              const route = matches[0];
              if (
                matches.length !== 1 ||
                route === undefined ||
                typeof route.version !== "string" ||
                route.version.length === 0
              ) {
                return yield* Effect.fail(
                  failure({
                    _tag: "LegacyProviderResultRequiresAttention",
                    reason:
                      "legacy action route identity is not uniquely bound",
                  }),
                );
              }
              const logicalActionId = `lac_${sha256Hex(
                JSON.stringify({
                  executionId: input.execution.executionId,
                  providerTurnId: settled.turn.providerTurnId,
                  callRef: invocation.callRef,
                  routeKind: route.route,
                  actionKind: invocation.toolName,
                }),
              )}`;
              actionEvidence.push({
                actionIndex,
                logicalActionId,
                callRef: invocation.callRef,
                toolName: invocation.toolName,
                toolSchemaVersion: route.version,
                inputHash: sha256Hex(invocation.argumentsJson),
                stableActionId:
                  typeof route.stableId === "string"
                    ? route.stableId
                    : LEGACY_ADOPTION_MISSING,
                actionVersion: route.version,
                argumentsSha256: sha256Hex(invocation.argumentsJson),
                // A P9 action row alone is not P4 disposition evidence. The
                // explicit marker lets a later exact P4 proof resolve this
                // original fingerprint without guessing at restart.
                disposition: LEGACY_ADOPTION_MISSING,
              });
            }
            const episodeEvidence = (() => {
              switch (episode._tag) {
                case "WorkEpisode":
                  return {
                    kind: episode._tag,
                    ref: episode.workId,
                    revision: episode.targetWorkRevision,
                  };
                case "ConversationResponseEpisode":
                  return {
                    kind: episode._tag,
                    ref: episode.messageId,
                    revision: episode.responseJobRevision,
                  };
                case "InboxEpisode":
                  return {
                    kind: episode._tag,
                    ref: episode.entryKey,
                    revision: 0,
                  };
                case "DecisionEpisode":
                  return {
                    kind: episode._tag,
                    ref: episode.decisionId,
                    revision: episode.requestRevision,
                  };
              }
            })();
            let canonicalEventsSha256: string;
            try {
              canonicalEventsSha256 = sha256Hex(
                canonicalizeLegacyAdoptionEvidenceV1(settled.canonicalEvents),
              );
            } catch {
              return yield* Effect.fail(
                failure({
                  _tag: "LegacyProviderResultRequiresAttention",
                  reason:
                    "legacy canonical Provider evidence cannot be fingerprinted",
                }),
              );
            }
            const evidence = {
              version: 1 as const,
              executionId: input.execution.executionId,
              projectId: input.execution.projectId,
              workspaceId: input.execution.workspaceId,
              episode: episodeEvidence,
              step: {
                logicalStepNo: loopStep.identity.logicalStepNo,
                repairAttempt: loopStep.identity.repairAttempt,
                providerTurnId: settled.turn.providerTurnId,
                manifestId: settled.manifestId,
                decoderVersion: "decode-turn-v1",
              },
              providerSuccess: {
                attemptNo: settled.attemptNo,
                evidenceVersion: settled.evidenceVersion,
                finishReason: settled.finishReason,
                settledAt: settled.settledAt,
                canonicalEventsSha256,
              },
              actions: actionEvidence,
              failureCode: "LegacyActionDispositionUnproven" as const,
            };
            const preparedLegacyStep = loopStep;
            const resolution = yield* tx
              .transact(
                Effect.gen(function* () {
                  const firstDetectedAt = yield* now();
                  const resolved = yield* resolveLegacyAdoptionFailure({
                    evidence,
                    fence: loopStepFence,
                    resolvedAt: firstDetectedAt,
                  });
                  if (Option.isSome(resolved)) {
                    if (options.qualificationProbe !== undefined) {
                      yield* Effect.promise(
                        () =>
                          options.qualificationProbe?.({
                            boundary:
                              "AH14BeforeLegacyAdoptionResolutionCommit",
                            providerTurnId: settled.turn.providerTurnId,
                            executionId: input.execution.executionId,
                            logicalActionId: resolved.value.resolutionFactId,
                          }) ?? Promise.resolve(),
                      );
                    }
                    yield* providerTurns.adoptSettledSuccessEvidence(
                      settled.turn.providerTurnId,
                      settled.attemptNo,
                      "legacy-success-v1",
                      "provider-success-v1",
                    );
                    const adoptedStep = yield* durableLoopSteps.transition(
                      {
                        identity: preparedLegacyStep.identity,
                        expectedRevision: preparedLegacyStep.revision,
                        expectedState: "Prepared",
                        next: {
                          ...preparedLegacyStep,
                          manifestId: settled.manifestId,
                          state: "ProviderResultAvailable",
                          decoderVersion: "decode-turn-v1",
                          migrationProvenance: {
                            _tag: "LegacySettledProviderSuccess",
                            evidenceVersion: settled.evidenceVersion,
                          },
                          revision: preparedLegacyStep.revision + 1,
                          updatedAt: yield* now(),
                        },
                      },
                      durableFence,
                    );
                    return {
                      _tag: "Resolved" as const,
                      fact: resolved.value,
                      step: adoptedStep,
                    };
                  }
                  const fact = yield* recordLegacyAdoptionFailure({
                    evidence,
                    fence: loopStepFence,
                    firstDetectedAt,
                  });
                  if (options.qualificationProbe !== undefined) {
                    yield* Effect.promise(
                      () =>
                        options.qualificationProbe?.({
                          boundary: "AH14BeforeLegacyAdoptionAttentionCommit",
                          providerTurnId: settled.turn.providerTurnId,
                          executionId: input.execution.executionId,
                        }) ?? Promise.resolve(),
                    );
                  }
                  return { _tag: "Blocked" as const, fact };
                }),
              )
              .pipe(Effect.mapError(failure));
            if (resolution._tag === "Blocked") {
              if (options.qualificationProbe !== undefined) {
                yield* Effect.promise(
                  () =>
                    options.qualificationProbe?.({
                      boundary: "AH14AfterLegacyAdoptionAttentionCommit",
                      providerTurnId: settled.turn.providerTurnId,
                      executionId: input.execution.executionId,
                      logicalActionId: resolution.fact.attentionFactId,
                    }) ?? Promise.resolve(),
                );
              }
              return { _tag: "RecoveryBlocked" };
            }
            loopStep = resolution.step;
            if (options.qualificationProbe !== undefined) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "AH14AfterLegacyAdoptionResolutionCommit",
                    providerTurnId: settled.turn.providerTurnId,
                    executionId: input.execution.executionId,
                    logicalActionId: resolution.fact.resolutionFactId,
                  }) ?? Promise.resolve(),
              );
            }
          }
          if (loopStep.state === "Prepared") {
            const preparedStep = loopStep;
            if (
              settled.evidenceVersion === "legacy-success-v1" &&
              options.qualificationProbe !== undefined
            ) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "AH14BeforeLegacyAdoptionCommit",
                    providerTurnId: settled.turn.providerTurnId,
                    executionId: input.execution.executionId,
                  }) ?? Promise.resolve(),
              );
            }
            loopStep = yield* tx
              .transact(
                Effect.gen(function* () {
                  if (settled.evidenceVersion === "legacy-success-v1") {
                    yield* providerTurns.adoptSettledSuccessEvidence(
                      settled.turn.providerTurnId,
                      settled.attemptNo,
                      "legacy-success-v1",
                      "provider-success-v1",
                    );
                  }
                  return yield* durableLoopSteps.transition(
                    {
                      identity: preparedStep.identity,
                      expectedRevision: preparedStep.revision,
                      expectedState: "Prepared",
                      next: {
                        ...preparedStep,
                        manifestId: settled.manifestId,
                        state: "ProviderResultAvailable",
                        decoderVersion: "decode-turn-v1",
                        ...(settled.evidenceVersion === "legacy-success-v1"
                          ? {
                              migrationProvenance: {
                                _tag: "LegacySettledProviderSuccess",
                                evidenceVersion: settled.evidenceVersion,
                              },
                            }
                          : {}),
                        revision: preparedStep.revision + 1,
                        updatedAt: yield* now(),
                      },
                    },
                    durableFence,
                  );
                }),
              )
              .pipe(Effect.mapError(failure));
            if (
              settled.evidenceVersion === "legacy-success-v1" &&
              options.qualificationProbe !== undefined
            ) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "AH14AfterLegacyAdoptionCommit",
                    providerTurnId: settled.turn.providerTurnId,
                    executionId: input.execution.executionId,
                  }) ?? Promise.resolve(),
              );
            }
          }
          if (decoded.ok) {
            return {
              _tag: "Ready",
              turn: {
                ...preparation.turn,
                manifest: persistedManifest,
                toolRoutes: persistedManifest.toolRoutes,
              },
              output: decoded.output,
              loopStep,
              ...(conversationExecution ? { conversation: true } : {}),
            };
          }
        } else if (settled._tag === "SettledFailure") {
          if (
            settled.turn.executionId !== input.execution.executionId ||
            settled.turn.sessionId !== input.execution.sessionId ||
            settled.turn.contextEpoch !== preparation.turn.manifest.contextEpoch
          ) {
            return yield* Effect.fail(
              failure({
                _tag: "AgentLoopStepReplayBindingMismatch",
              }),
            );
          }
          const settlement: ExecutionSettlement =
            settled.finishReason === "Cancelled"
              ? {
                  _tag: "Interrupted",
                  result: {
                    _tag: "ControlledInterruption",
                    reason: "ProviderTurnSettled:Cancelled",
                  },
                }
              : {
                  _tag: "Failed",
                  failure: {
                    _tag: "ExecutionFailure",
                    reason: `ProviderTurnSettled:${settled.finishReason}`,
                  },
                };
          if (
            settled.failureKind === "ContextLimitExceeded" &&
            replayPersistedContextLimit
          ) {
            // The same settled inference failure is fed to the existing
            // ordinal-0 overflow path below; do not terminalize the step.
          } else if (loopStep.state === "Prepared") {
            const failedStep = loopStep;
            yield* tx
              .transact(
                durableLoopSteps.transition(
                  {
                    identity: failedStep.identity,
                    expectedRevision: failedStep.revision,
                    expectedState: "Prepared",
                    next: {
                      ...failedStep,
                      state: "SettlementProposed",
                      settlement,
                      revision: failedStep.revision + 1,
                      updatedAt: yield* now(),
                    },
                  },
                  durableFence,
                ),
              )
              .pipe(Effect.mapError(failure));
          }
          if (!replayPersistedContextLimit) {
            return { _tag: "Settle", settlement };
          }
        } else if (settled._tag === "SettledEvidenceInvalid") {
          return yield* Effect.fail(
            failure({
              _tag: "SettledProviderEvidenceInvalid",
              reason: settled.reason,
            }),
          );
        }
      }
      const providerResult = replayPersistedContextLimit
        ? {
            ok: false as const,
            cause: {
              _tag: "ProviderFailure" as const,
              kind: "ContextLimitExceeded" as const,
            },
          }
        : yield* Effect.match(providerRuntime.runTurn(turnInput), {
            onFailure: (cause) => ({ ok: false as const, cause }),
            onSuccess: (value) => ({ ok: true as const, value }),
          });
      if (!providerResult.ok) {
        if (isProviderTurnBindingChanged(providerResult.cause)) {
          return yield* proposeSettlement(
            providerTurnBindingChangedSettlement(),
          );
        }
        if (isProviderExecutionTimeout(providerResult.cause)) {
          return yield* proposeSettlement(
            providerExecutionTimeoutSettlement(providerResult.cause),
          );
        }
        if (
          typeof providerResult.cause === "object" &&
          providerResult.cause !== null &&
          "_tag" in providerResult.cause &&
          providerResult.cause._tag === "ProviderFailure" &&
          "kind" in providerResult.cause &&
          providerResult.cause.kind === "ContextLimitExceeded" &&
          overflowRecoveryAttempt === 0 &&
          loopStepFence !== undefined &&
          loopStep !== undefined &&
          loopSteps !== undefined
        ) {
          const overflowStep = loopStep;
          const overflowFence = loopStepFence;
          const overflowSteps = loopSteps;
          const observedAt = yield* now();
          if (providerTurns !== undefined) {
            const existingTurn = yield* tx
              .transact(providerTurns.findUnsettledByTurn(providerTurnId))
              .pipe(Effect.mapError(failure));
            if (existingTurn !== null) {
              yield* tx
                .transact(
                  Effect.gen(function* () {
                    yield* providerTurns.failTurn(providerTurnId, observedAt);
                    if (options.qualificationProbe !== undefined) {
                      yield* Effect.promise(async () => {
                        await options.qualificationProbe?.({
                          boundary: "AH18BeforeInferenceFailTurnCommit",
                          executionId: String(input.execution.executionId),
                          providerTurnId: String(providerTurnId),
                        });
                      });
                    }
                  }),
                )
                .pipe(Effect.mapError(failure));
            }
          }
          const nativeSupported =
            capability.portableRequestCompatibility?.operationKinds.includes(
              "CompactionNative",
            ) === true;
          const compactTurnId = nativeSupported
            ? providerTurnNativeCompactionId(
                input.execution.executionId,
                turn,
                stepContext.contextEpoch,
              )
            : providerTurnSummaryCompactionId(
                input.execution.executionId,
                turn,
                stepContext.contextEpoch,
              );
          if (!replayPersistedContextLimit) {
            const compactionProviderTurnId = compactTurnId;
            const linkProbeIdentity = {
              executionId: String(input.execution.executionId),
              providerTurnId: String(compactionProviderTurnId),
            };
            yield* tx
              .transact(
                Effect.gen(function* () {
                  yield* overflowSteps.ensureProviderTurnLink(
                    {
                      identity: overflowStep.identity,
                      overflowOrdinal: 0,
                      role: "Inference",
                      providerTurnId,
                      contextEpoch: stepContext.contextEpoch,
                      state: "SettledFailure",
                      createdAt: observedAt,
                    },
                    overflowFence,
                  );
                  yield* overflowSteps.ensureProviderTurnLink(
                    {
                      identity: overflowStep.identity,
                      overflowOrdinal: 0,
                      role: "OverflowCompaction",
                      providerTurnId: compactTurnId,
                      predecessorProviderTurnId: providerTurnId,
                      contextEpoch: stepContext.contextEpoch,
                      state: "Prepared",
                      createdAt: observedAt,
                    },
                    overflowFence,
                  );
                  if (options.qualificationProbe !== undefined) {
                    yield* Effect.promise(async () => {
                      await options.qualificationProbe?.({
                        boundary: "AH18BeforeOverflowLinksCommit",
                        ...linkProbeIdentity,
                      });
                    });
                  }
                }),
              )
              .pipe(Effect.mapError(failure));
            if (options.qualificationProbe !== undefined) {
              yield* Effect.promise(async () => {
                await options.qualificationProbe?.({
                  boundary: "AH18AfterOverflowLinksCommit",
                  ...linkProbeIdentity,
                });
              });
            }
          }
          const compacted = conversationExecution
            ? yield* Effect.gen(function* () {
                if (
                  conversationOwner === undefined ||
                  conversationProjection === undefined ||
                  conversationCurrentJob === undefined ||
                  dependencies.conversationCheckpoints === undefined ||
                  dependencies.blobs === undefined ||
                  providerTurns === undefined
                ) {
                  return yield* Effect.fail(
                    failure({
                      _tag: "ConversationCheckpointRuntimeUnavailable",
                    }),
                  );
                }
                const sources = [
                  ...conversationProjection.coveredAnswered,
                  ...conversationProjection.uncoveredAnswered,
                ];
                const latest = sources.at(-1);
                const coveredThrough =
                  latest === undefined
                    ? conversationProjection.checkpoint.coveredThrough
                    : {
                        createdAt: latest.message.createdAt,
                        messageId: latest.message.messageId,
                      };
                return yield* runConversationCheckpointCompaction(
                  {
                    execution: input.execution,
                    logicalStepNo: overflowStep.identity.logicalStepNo,
                    providerTurnId: compactTurnId,
                    owner: conversationOwner,
                    sources,
                    coveredThrough,
                    currentMessageId: exactConversation?.messageId ?? "",
                    currentResponseJob: conversationCurrentJob,
                    checkpointKind: nativeSupported
                      ? "ProviderNative"
                      : "Summary",
                    bindingFingerprint: currentBindingFingerprint,
                    modelRef: capability.modelRef,
                    ...(options.secretRef === undefined
                      ? {}
                      : { secretRef: options.secretRef }),
                    fence: overflowFence,
                    updatedAt: yield* now(),
                    ...(options.qualificationProbe === undefined
                      ? {}
                      : { qualificationProbe: options.qualificationProbe }),
                  },
                  {
                    providerRuntime,
                    checkpointStore: dependencies.conversationCheckpoints,
                    providerTurns,
                    blobs: dependencies.blobs,
                    tx,
                  },
                ).pipe(Effect.mapError(failure));
              })
            : yield* runCompaction(
                {
                  execution: input.execution,
                  logicalStepNo: loopStep?.identity.logicalStepNo ?? turn,
                  ...(loopStep === undefined
                    ? {}
                    : {
                        sourceAgentLoopStep: {
                          executionId: String(loopStep.identity.executionId),
                          logicalStepNo: loopStep.identity.logicalStepNo,
                          repairAttempt: loopStep.identity.repairAttempt,
                          providerTurnId: String(loopStep.providerTurnId),
                        },
                      }),
                  currentEpoch: stepContext.contextEpoch,
                  modelRef: capability.modelRef,
                  ...(options.secretRef === undefined
                    ? {}
                    : { secretRef: options.secretRef }),
                  bindingFingerprint: stepContext.bindingFingerprint,
                  inputFrontier: stepContext.inputFrontier,
                  contextRefs: messageContextRefs,
                  inputItems,
                  ...compactionWorkPinning,
                  fence: overflowFence,
                  nativeSupported,
                },
                {
                  providerRuntime,
                  sessions,
                  tx,
                  ...(options.qualificationProbe === undefined
                    ? {}
                    : { qualificationProbe: options.qualificationProbe }),
                },
              ).pipe(Effect.mapError(failure));
          overflowReplacementProviderTurnId =
            makeOverflowReplacementProviderTurnId(
              input.execution.executionId,
              turn,
            );
          yield* tx
            .transact(
              overflowSteps.ensureProviderTurnLink(
                {
                  identity: overflowStep.identity,
                  overflowOrdinal: 0,
                  role: "OverflowReplacement",
                  providerTurnId: overflowReplacementProviderTurnId,
                  predecessorProviderTurnId: compacted.providerTurnId,
                  contextEpoch: compacted.newEpoch,
                  state: "Prepared",
                  createdAt: yield* now(),
                },
                overflowFence,
              ),
            )
            .pipe(Effect.mapError(failure));
          overflowRecoveryAttempt = 1;
          replayPersistedContextLimit = false;
          continue;
        }
        if (isProviderFailure(providerResult.cause)) {
          return yield* proposeSettlement(
            providerFailureSettlement(providerResult.cause),
          );
        }
        return yield* Effect.fail(failure(providerResult.cause));
      }
      const providerRun = providerResult.value;
      const events = providerRun.events;
      if (
        loopStep !== undefined &&
        loopSteps !== undefined &&
        loopStepFence !== undefined
      ) {
        const settled =
          providerTurns === undefined
            ? undefined
            : yield* tx
                .transact(providerTurns.findSettledResult(providerTurnId))
                .pipe(Effect.mapError(failure));
        if (
          settled?._tag === "SettledSuccess" &&
          options.qualificationProbe !== undefined
        ) {
          yield* Effect.promise(
            () =>
              options.qualificationProbe?.({
                boundary: "AH3BeforeStepAvailable",
                providerTurnId,
              }) ?? Promise.resolve(),
          );
        }
        loopStep = yield* tx
          .transact(
            loopSteps.transition(
              {
                identity: loopStep.identity,
                expectedRevision: loopStep.revision,
                expectedState: "Prepared",
                next: {
                  ...loopStep,
                  ...(settled?._tag === "SettledSuccess"
                    ? { manifestId: settled.manifestId }
                    : {}),
                  state: "ProviderResultAvailable",
                  decoderVersion: "decode-turn-v1",
                  revision: loopStep.revision + 1,
                  updatedAt: yield* now(),
                },
              },
              loopStepFence,
            ),
          )
          .pipe(Effect.mapError(failure));
        if (options.qualificationProbe !== undefined) {
          yield* Effect.promise(
            () =>
              options.qualificationProbe?.({
                boundary: "AH3AfterStepAvailable",
                providerTurnId,
              }) ?? Promise.resolve(),
          );
        }
      }
      // D5: end-bracket the provider call (call completion). D1
      // (B-4): report the real ProviderAttempt ordinal observed by
      // ProviderRuntime, so the gate sees actual transient retries
      // (retry never creates a new ProviderTurn — DID §6A.9). The
      // end bracket is not a D4 turn boundary.
      if (leaseGeneration !== undefined || providerRun.attemptNo > 0) {
        const endDecision = yield* admit(activity, {
          retryCount: providerRun.attemptNo,
          inFlight: "end",
          ...(leaseGeneration !== undefined ? { leaseGeneration } : {}),
          observedAt: yield* now(),
        });
        if (endDecision === "Stop") {
          return {
            _tag: "Settle",
            settlement: safetyStop("RuntimeSafetyStop"),
          };
        }
      }
      const decoded = decodeTurn(events);
      if (decoded.ok) {
        return {
          _tag: "Ready",
          turn: preparation.turn,
          output: decoded.output,
          ...(loopStep === undefined ? {} : { loopStep }),
          ...(conversationExecution ? { conversation: true } : {}),
        };
      }
      const repair = decideRepair(
        REPAIR_POLICY,
        repairAttempt,
        preparation.turn.manifest.outputContractRef,
        decoded.reason,
      );
      if (repair._tag === "Exhausted") {
        if (
          loopStep !== undefined &&
          loopSteps !== undefined &&
          loopStepFence !== undefined &&
          loopStep.state === "ProviderResultAvailable"
        ) {
          const rejectedStep = loopStep;
          const outputRejected = yield* tx
            .transact(
              loopSteps.transition(
                {
                  identity: rejectedStep.identity,
                  expectedRevision: rejectedStep.revision,
                  expectedState: "ProviderResultAvailable",
                  next: {
                    ...rejectedStep,
                    state: "OutputRejected",
                    repairDisposition: {
                      _tag: "Exhausted",
                      settlement: repair.settlement,
                    },
                    revision: rejectedStep.revision + 1,
                    updatedAt: yield* now(),
                  },
                },
                loopStepFence,
              ),
            )
            .pipe(Effect.mapError(failure));
          if (
            repair.settlement._tag === "Failed" &&
            options.qualificationProbe !== undefined
          ) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH4RepairBeforeSettlementProposal",
                  providerTurnId,
                }) ?? Promise.resolve(),
            );
          }
          yield* tx
            .transact(
              loopSteps.transition(
                {
                  identity: outputRejected.identity,
                  expectedRevision: outputRejected.revision,
                  expectedState: "OutputRejected",
                  next: {
                    ...outputRejected,
                    state: "SettlementProposed",
                    settlement: repair.settlement,
                    revision: outputRejected.revision + 1,
                    updatedAt: yield* now(),
                  },
                },
                loopStepFence,
              ),
            )
            .pipe(Effect.mapError(failure));
          if (
            repair.settlement._tag === "Failed" &&
            options.qualificationProbe !== undefined
          ) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH4RepairAfterSettlementProposal",
                  providerTurnId,
                }) ?? Promise.resolve(),
            );
          }
        }
        return { _tag: "Settle", settlement: repair.settlement };
      }
      if (
        loopStep !== undefined &&
        loopSteps !== undefined &&
        loopStepFence !== undefined &&
        loopStep.state === "ProviderResultAvailable"
      ) {
        const rejectedStep = loopStep;
        const successorIdentity = {
          executionId: input.execution.executionId,
          logicalStepNo: turn,
          repairAttempt: repairAttempt + 1,
        } as const;
        const successorProviderTurnId = providerTurnRepairInferenceId(
          input.execution.executionId,
          turn,
          repairAttempt + 1,
        );
        yield* tx
          .transact(
            Effect.gen(function* () {
              yield* loopSteps.transition(
                {
                  identity: rejectedStep.identity,
                  expectedRevision: rejectedStep.revision,
                  expectedState: "ProviderResultAvailable",
                  next: {
                    ...rejectedStep,
                    state: "OutputRejected",
                    repairDisposition: {
                      _tag: "Retry",
                      successor: {
                        ...successorIdentity,
                        providerTurnId: successorProviderTurnId,
                      },
                    },
                    successor: {
                      ...successorIdentity,
                      providerTurnId: successorProviderTurnId,
                    },
                    revision: rejectedStep.revision + 1,
                    updatedAt: yield* now(),
                  },
                },
                loopStepFence,
              );
              yield* loopSteps.ensureSuccessor(
                rejectedStep.identity,
                {
                  identity: successorIdentity,
                  predecessor: rejectedStep.identity,
                  providerTurnId: successorProviderTurnId,
                  state: "Prepared",
                  nextActionIndex: 0,
                  revision: 0,
                  updatedAt: yield* now(),
                },
                loopStepFence,
              );
            }),
          )
          .pipe(Effect.mapError(failure));
      }
      repairFragments = [repair.repairFragment];
      repairAttempt += 1;
    }
  });
};
