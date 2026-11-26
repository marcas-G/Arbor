import { Effect, Layer } from "effect";
import {
  ClockLive,
  SessionRepositoryLive,
  layer as sqlitePersistenceLayer,
  TransactionPortLive,
} from "../../../../../adapters/persistence-sqlite/src/index.js";
import {
  ContextEpochNumber,
  ExecutionId,
  ProviderTurnId,
  parse,
  SessionId,
  WorkspaceId,
} from "../../../../../packages/domain/src/index.js";
import {
  canonicalInstructionTrust,
  hashInstructionContent,
  type InstructionFragment,
  latestSessionInputIndex,
  ModelContext,
  ModelContextLive,
  projectCompressibleHistory,
  projectSessionTimeline,
  WORK_EXECUTION_PROGRAM,
} from "../../../../../packages/model-context/src/index.js";
import {
  ModelCapabilityPort,
  type SessionEntryRecord,
  SessionRepository,
  SkillRegistry,
  TransactionPort,
} from "../../../../../packages/ports/dist/index.js";

// Shared AH19 test support — moved verbatim from ah19-provider-native-binding-recovery.functional.test.ts (B5 split).

export const readWorkFrontierThroughSessionRepository = (
  databaseFile: string,
  sessionId: string,
  executionId?: string,
): Promise<ReadonlyArray<SessionEntryRecord>> => {
  const infrastructure = Layer.mergeAll(
    sqlitePersistenceLayer({ filename: databaseFile }),
    ClockLive,
  );
  const services = Layer.mergeAll(
    infrastructure,
    Layer.provide(TransactionPortLive, infrastructure),
    Layer.provide(SessionRepositoryLive, infrastructure),
  );
  const read = Effect.gen(function* () {
    const transactions = yield* TransactionPort;
    const sessions = yield* SessionRepository;
    return yield* transactions.transact(
      sessions.listWorkActiveFrontier(
        parse(SessionId)(sessionId),
        executionId === undefined ? undefined : parse(ExecutionId)(executionId),
      ),
    );
  });
  return Effect.runPromise(
    Effect.scoped(Effect.provide(read, services)) as Effect.Effect<
      ReadonlyArray<SessionEntryRecord>,
      unknown,
      never
    >,
  );
};

export const prepareActualWorkFrontier = async (input: {
  readonly executionId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly workId: string;
  readonly workRevision: number;
  readonly contextEpoch: number;
  readonly bindingFingerprint: string;
  readonly controlBasis: {
    readonly projectPolicyRevision: number;
    readonly workspacePolicyRevision: number;
    readonly responsibilityRevision: number;
    readonly resourceBoundaryRevision: number;
    readonly workId?: string;
    readonly workRevision?: number;
    readonly authorizationDigest: string;
    readonly environmentRevision: string;
  };
  readonly entries: ReadonlyArray<SessionEntryRecord>;
}) => {
  const projection = projectSessionTimeline(
    input.entries,
    input.bindingFingerprint,
    true,
  );
  const currentInputIndex = latestSessionInputIndex(projection.inputItems);
  const compressibleIndexes = projection.inputItems.flatMap((_, index) =>
    index === currentInputIndex ? [] : [index],
  );
  const history = projectCompressibleHistory({
    inputItems: projection.inputItems,
    sourceRefs: projection.contextRefs,
    compressibleIndexes,
  });
  const objectiveText = `AH19 bounded-tail Work ${input.workId}`;
  const objectiveFragment: InstructionFragment = {
    identity: `work-objective:${input.workId}`,
    revision: input.workRevision,
    hash: hashInstructionContent(objectiveText),
    semanticKind: "WorkObjective",
    source: "Canonical",
    scope: "work-objective",
    authorityRole: "A3",
    strength: "Hard",
    compositionMode: "Constrain",
    activationCondition: "always",
    lifetime: "Protected",
    cacheClass: "TurnDynamic",
    budgetClass: "work",
    modelCompatibility: [],
    contentRef: `work-objective:${input.workId}:${input.workRevision}`,
    provenance: canonicalInstructionTrust,
  };
  const capabilityLayer = Layer.succeed(ModelCapabilityPort, {
    resolve: () =>
      Effect.succeed({
        modelRef: "model-ah19-native-test",
        family: "ah19-frontier-integration",
        contextWindow: 1024,
        outputCeiling: 200,
        toolProtocol: "json",
      }),
  });
  const skillLayer = Layer.succeed(SkillRegistry, {
    available: () => Effect.succeed([]),
    load: () => Effect.die("no skills in AH19 frontier integration"),
  });
  const contextLayer = Layer.provide(
    ModelContextLive,
    Layer.mergeAll(capabilityLayer, skillLayer),
  );
  const services = Layer.mergeAll(capabilityLayer, skillLayer, contextLayer);
  const preparation = Effect.gen(function* () {
    const modelContext = yield* ModelContext;
    return yield* modelContext.prepareTurn({
      executionId: parse(ExecutionId)(input.executionId),
      sessionId: parse(SessionId)(input.sessionId),
      contextEpoch: parse(ContextEpochNumber)(input.contextEpoch),
      providerTurnId: parse(ProviderTurnId)(
        "ptn_018f2b3c-4d5e-7abc-8def-0123456789f2",
      ),
      binding: {
        _tag: "ResponsibilityBoundAgentBinding" as const,
        workspaceId: parse(WorkspaceId)(input.workspaceId),
      },
      workspaceId: parse(WorkspaceId)(input.workspaceId),
      cognitiveMode: "execute",
      program: WORK_EXECUTION_PROGRAM,
      fragments: [objectiveFragment],
      contextFragments: history.contextFragments,
      compressibleInputItemIndexes: history.compressibleInputItemIndexes,
      budget: {
        modelWindow: 1024,
        outputReserve: 200,
        protocolReserve: 100,
        toolReserve: 100,
      },
      controlBasis: input.controlBasis,
      maxOutputTokens: 200,
      bodySkillIds: [],
      turnProfile: {
        purpose: "WorkspaceWork",
        profileVersion: "turn-profile-v1",
        outputContractRef: "tool-invocation-v1",
        executableTools: [],
        controlTools: [],
        contextPolicyRef: "workspace-work-context-v1",
        fingerprint: "ah19-post-checkpoint-frontier",
      },
      instructionContents: new Map([
        [objectiveFragment.contentRef, objectiveText],
      ]),
      messageContextRefs: projection.contextRefs,
      inputItems: projection.inputItems,
    });
  });
  const result = await Effect.runPromise(Effect.provide(preparation, services));
  return { projection, history, result };
};
