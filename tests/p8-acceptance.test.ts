import { readFileSync } from "node:fs";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  AcceptanceRepositoryLive,
  ClockLive,
  CommandStoreLive,
  DeliverableRepositoryLive,
  DomainEventJournalLive,
  EnvironmentRevisionStoreLive,
  EvidenceRepositoryLive,
  ExecutionRepositoryLive,
  IdGeneratorLive,
  layer,
  P8_MIGRATIONS,
  ProjectRepositoryLive,
  runMigrations,
  SessionRepositoryLive,
  TransactionPortLive,
  VerificationRepositoryLive,
  WorkRepositoryLive,
  WorkspaceRepositoryLive,
  WorkWaitStoreLive,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  assertProgramGate,
  evalAllPrograms,
  evaluateProgramContent,
  PROGRAM_REGISTRY,
  type ProgramRegistryEntry,
  programFilePath,
  sha256Hex,
} from "../packages/agent-runtime/src/prompt-programs.js";
import {
  type AcceptWorkOutcomePayload,
  makeAcceptWorkOutcomeHandler,
  makeCompleteWorkHandler,
} from "../packages/application/src/commands/accept-complete.js";
import {
  type ConcludeVerificationPayload,
  type CriterionResultInput,
  makeConcludeVerificationHandler,
  makeRecordVerificationEvidenceHandler,
  type RecordVerificationEvidencePayload,
} from "../packages/application/src/commands/conclude-verification.js";
import {
  makeStartVerificationHandler,
  type StartVerificationPayload,
} from "../packages/application/src/commands/start-verification.js";
import {
  completionCommandId,
  runCompletionConsumer,
} from "../packages/application/src/completion-consumer.js";
import {
  CommandGateway,
  CommandGatewayLive,
  type CommandHandler,
  CommandHandlerRegistry,
  FenceStopCheckInertLive,
  type GatewayEnvelope,
  makeP1CommandHandlers,
  semanticRequestFingerprint,
} from "../packages/application/src/index.js";
import {
  runVerificationConsumer,
  verificationSpawnIds,
} from "../packages/application/src/verification-consumer.js";
import {
  deliverVerificationWake,
  type VerificationWakeDependencies,
} from "../packages/application/src/verification-wake.js";
import {
  ensureVerifierSpawned,
  type VerifierSpawnDependencies,
} from "../packages/application/src/verifier-spawn.js";
import {
  AcceptanceId,
  ArtifactId,
  CommandId,
  type CommandSubmissionContext,
  DeliverableId,
  EvidenceId,
  ExecutionId,
  LeaseGeneration,
  Principal,
  parse,
  type Verification,
  VerificationId,
  type VerificationMission,
  type VerificationVerdict,
  WorkId,
  WorkRevision,
  type WorkspaceId,
} from "../packages/domain/dist/index.js";
import { makeP2CommandHandlers } from "../packages/execution-runtime/src/index.js";
import {
  AcceptanceRepository,
  Clock,
  DeliverableRepository,
  EnvironmentRevisionStore,
  EvidenceRepository,
  ExecutionRepository,
  ExecutionScheduler,
  ProjectRepository,
  type SchedulerDecision,
  SessionRepository,
  TransactionPort,
  VerificationRepository,
  WorkRepository,
  WorkspaceRepository,
  WorkWaitStore,
} from "../packages/ports/src/index.js";
import {
  p7Project,
  p7RootWorkspace,
  p7SeedProject,
  p7SeedWork,
  p7TestActor,
  p7TestPrincipal,
} from "./support/p7-app.js";

const wrk = (tail: string) =>
  parse(WorkId)(`wrk_00000000-0000-7000-8000-000000${tail}`);
const ver = (tail: string) =>
  parse(VerificationId)(`ver_00000000-0000-7000-8000-000000${tail}`);
const exe = (tail: string) =>
  parse(ExecutionId)(`exe_00000000-0000-7000-8000-000000${tail}`);
const evd = (tail: string) =>
  parse(EvidenceId)(`evd_00000000-0000-7000-8000-000000${tail}`);
const acc = (tail: string) =>
  parse(AcceptanceId)(`acc_00000000-0000-7000-8000-000000${tail}`);
const art = (tail: string) =>
  parse(ArtifactId)(`art_00000000-0000-7000-8000-000000${tail}`);
const del = (tail: string) =>
  parse(DeliverableId)(`del_00000000-0000-7000-8000-000000${tail}`);
const cmd = (tail: string) =>
  parse(CommandId)(`cmd_018f2b3c-4d5e-7abc-8def-${tail}`);
const WREV = (n: number) => parse(WorkRevision)(n);

const VERIFIER_PRINCIPAL = parse(Principal)("runtime:verifier");

const WORK_A = wrk("00a001");
const WORK_A_WAITER = wrk("00a002");
const EV_A1 = evd("00a011");
const EV_A2 = evd("00a012");
const ACC_A = acc("00a021");

const WORK_B = wrk("00b001");
const EV_B1 = evd("00b011");
const EV_B2 = evd("00b012");

const WORK_C = wrk("00c001");
const EV_C1 = evd("00c011");
const EV_C2 = evd("00c012");

const WORK_D = wrk("00d001");
const EV_D1 = evd("00d011");
const EV_D2 = evd("00d012");
const ACC_D1 = acc("00d021");
const ACC_D2 = acc("00d022");
const VER_D2 = ver("00d002");
const EXE_D2 = exe("00d042");

const WORK_E1 = wrk("00e001");
const WORK_E2 = wrk("00e002");
const WORK_E3 = wrk("00e003");
const DEL_E = del("00e011");
const ART_E = art("00e012");
const VER_E1 = ver("00e021");
const VER_E2 = ver("00e022");
const VER_E3 = ver("00e023");
const VER_E4 = ver("00e024");
const VER_E5 = ver("00e025");
const EXE_E1 = exe("00e031");
const EXE_E2 = exe("00e032");
const EXE_E3 = exe("00e033");
const EXE_E4 = exe("00e034");
const EXE_E5 = exe("00e035");

const WORK_G1 = wrk("00f001");
const WORK_G2 = wrk("00f002");
const VER_G1B = ver("00f011");
const VER_G3 = ver("00f012");
const VER_G4 = ver("00f013");
const EXE_G1B = exe("00f021");
const EXE_G3 = exe("00f022");
const EXE_G4 = exe("00f023");

const missionOf = (goal: string): VerificationMission => ({
  goal,
  criteria: [
    { criterionId: "c1", requirement: "tests pass", required: true },
    { criterionId: "c2", requirement: "lint clean", required: true },
  ],
  riskRequirements: [],
});

const MISSION_A = missionOf("verify the completed outcome");
const MISSION_B = missionOf("verify the rework outcome");
const MISSION_C = missionOf("verify the uncertain outcome");
const MISSION_D = missionOf("verify before refine");
const MISSION_E = missionOf("verify the bound deliverable");
const MISSION_G = missionOf("verify the orphan-prone outcome");

const LEGACY_PLACEHOLDER_MISSION: VerificationMission = {
  goal: "p6-placeholder",
  criteria: [],
  riskRequirements: [],
};

const FORMATION_PLACEHOLDER_MISSION: VerificationMission = {
  goal: "formation-assigned work",
  criteria: [
    {
      criterionId: "acceptance",
      requirement: "parent acceptance",
      required: true,
    },
  ],
  riskRequirements: [],
};

const missionDigestOf = (mission: VerificationMission): string =>
  `${mission.goal} [criteria=${mission.criteria.length} required=${mission.criteria.filter((criterion) => criterion.required).length}]`;

const criterionResult = (
  mission: VerificationMission,
  criterionId: string,
  verdict: VerificationVerdict,
  evidenceRefs: ReadonlyArray<EvidenceId>,
): CriterionResultInput => {
  const criterion = mission.criteria.find(
    (candidate) => candidate.criterionId === criterionId,
  );
  expect(criterion).toBeDefined();
  return {
    criterionId,
    requirement: criterion?.requirement ?? "",
    required: criterion?.required ?? true,
    verdict,
    evidenceRefs,
  };
};

const settledEventOf = (
  eventId: string,
  workId: WorkId,
  claimRef: string,
): { eventType: string; eventId: string; payload: unknown } => ({
  eventType: "ExecutionSettled",
  eventId,
  payload: {
    executionId: `exe_acceptance_${claimRef}`,
    workId,
    workRevision: 0,
    claimRef,
  },
});

const acceptedEventOf = (
  eventId: string,
  payload: {
    acceptanceId: AcceptanceId;
    workId: WorkId;
    targetWorkRevision: number;
    verificationId: VerificationId;
  },
): { eventType: string; eventId: string; payload: unknown } => ({
  eventType: "WorkOutcomeAccepted",
  eventId,
  payload: { ...payload, actor: p7TestActor },
});

interface SchedulerCall {
  readonly workspaceId: WorkspaceId;
  readonly wakeReasonTag: string;
}

const makeSchedulerStub = () => {
  const calls: SchedulerCall[] = [];
  const stub = Layer.succeed(
    ExecutionScheduler,
    ExecutionScheduler.of({
      reevaluate: (workspaceId, wakeReason) =>
        Effect.sync(() => {
          calls.push({ workspaceId, wakeReasonTag: wakeReason._tag });
          return { _tag: "Idle" } as SchedulerDecision;
        }),
      registerWorkWait: () => Effect.void,
      clearWorkWait: () => Effect.void,
      scheduleTimer: () => Effect.void,
      dueTimers: () => Effect.succeed([]),
    }),
  );
  return { calls, layer: stub };
};

type RegistryDeps =
  | ProjectRepository
  | WorkspaceRepository
  | SessionRepository
  | WorkRepository
  | ExecutionRepository
  | WorkWaitStore
  | VerificationRepository
  | EvidenceRepository
  | AcceptanceRepository
  | DeliverableRepository
  | EnvironmentRevisionStore
  | SqlClient;

const StoryRegistryLive: Layer.Layer<
  CommandHandlerRegistry,
  never,
  RegistryDeps
> = Layer.effect(
  CommandHandlerRegistry,
  Effect.gen(function* () {
    const projects = yield* ProjectRepository;
    const workspaces = yield* WorkspaceRepository;
    const sessions = yield* SessionRepository;
    const works = yield* WorkRepository;
    const executions = yield* ExecutionRepository;
    const workWaits = yield* WorkWaitStore;
    const verifications = yield* VerificationRepository;
    const evidence = yield* EvidenceRepository;
    const acceptances = yield* AcceptanceRepository;
    const deliverableService = yield* DeliverableRepository;
    const environmentRevisions = yield* EnvironmentRevisionStore;
    const sql = yield* SqlClient;
    const handlers: ReadonlyArray<CommandHandler<unknown, unknown>> = [
      ...makeP1CommandHandlers({ projects, workspaces, sessions, works }),
      ...makeP2CommandHandlers({
        projects,
        workspaces,
        sessions,
        executions,
        workWaits,
      }),
      makeStartVerificationHandler({
        works,
        verifications,
        environmentRevisions,
        deliverables: {
          ...deliverableService,
          listArtifacts: (deliverableId) =>
            sql
              .unsafe<{
                readonly role: string;
                readonly artifact_id: string;
              }>(
                "SELECT role, artifact_id FROM deliverable_artifacts WHERE deliverable_id = ?",
                [deliverableId],
              )
              .pipe(
                Effect.map((rows) =>
                  rows.map((row) => ({
                    role: row.role,
                    artifactId: row.artifact_id as never,
                  })),
                ),
                Effect.mapError(
                  (cause) =>
                    ({
                      _tag: "DeliverableRepositoryFailure",
                      cause,
                    }) as never,
                ),
              ),
        },
      }) as unknown as CommandHandler<unknown, unknown>,
      makeRecordVerificationEvidenceHandler({
        verifications,
        evidence,
      }) as unknown as CommandHandler<unknown, unknown>,
      makeConcludeVerificationHandler({
        verifications,
        evidence,
        works,
      }) as unknown as CommandHandler<unknown, unknown>,
      makeAcceptWorkOutcomeHandler({
        works,
        verifications,
        acceptances,
      }) as unknown as CommandHandler<unknown, unknown>,
      makeCompleteWorkHandler({
        works,
        workspaces,
        verifications,
        acceptances,
      }) as unknown as CommandHandler<unknown, unknown>,
    ];
    return CommandHandlerRegistry.of({
      lookup: (commandType) => {
        const handler = handlers.find(
          (candidate) => candidate.commandType === commandType,
        );
        return handler === undefined ? Option.none() : Option.some(handler);
      },
    });
  }),
);

type StoryServices =
  | CommandGateway
  | SqlClient
  | TransactionPort
  | Clock
  | ExecutionRepository
  | WorkWaitStore
  | ExecutionScheduler
  | VerificationRepository
  | EvidenceRepository
  | AcceptanceRepository
  | WorkRepository
  | WorkspaceRepository
  | DeliverableRepository
  | EnvironmentRevisionStore;

const makeStoryApp = () => {
  const scheduler = makeSchedulerStub();
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const repositories = Layer.mergeAll(
    Layer.provide(ProjectRepositoryLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(SessionRepositoryLive, infra),
    Layer.provide(WorkRepositoryLive, infra),
    Layer.provide(ExecutionRepositoryLive, infra),
    Layer.provide(WorkWaitStoreLive, infra),
    Layer.provide(DeliverableRepositoryLive, infra),
    Layer.provide(VerificationRepositoryLive, infra),
    Layer.provide(EvidenceRepositoryLive, infra),
    Layer.provide(AcceptanceRepositoryLive, infra),
    Layer.provide(EnvironmentRevisionStoreLive, infra),
  );
  const transaction = Layer.provide(TransactionPortLive, infra);
  const registry = Layer.provide(
    StoryRegistryLive,
    Layer.mergeAll(repositories, transaction, infra),
  );
  const journal = Layer.provide(DomainEventJournalLive, infra);
  const gatewayDeps = Layer.mergeAll(
    infra,
    registry,
    journal,
    repositories,
    transaction,
    Layer.provide(CommandStoreLive, infra),
    FenceStopCheckInertLive,
  );
  const app = Layer.mergeAll(
    gatewayDeps,
    Layer.provide(CommandGatewayLive, gatewayDeps),
    scheduler.layer,
  ) as unknown as Layer.Layer<StoryServices>;
  return { app, calls: scheduler.calls };
};

const runStory = <A>(
  app: Layer.Layer<StoryServices>,
  program: Effect.Effect<A, unknown, StoryServices>,
): Promise<A> => Effect.runPromise(Effect.scoped(Effect.provide(program, app)));

const seedProject = Effect.gen(function* () {
  yield* runMigrations(P8_MIGRATIONS);
  yield* p7SeedProject;
});

const seedWork = (workId: WorkId, commandId: CommandId) =>
  Effect.gen(function* () {
    const receipt = yield* p7SeedWork(workId, commandId);
    expect(receipt.resolution._tag).toBe("Committed");
  });

const setMission = (workId: WorkId, mission: VerificationMission) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "UPDATE works SET verification_mission = ? WHERE work_id = ?",
      [JSON.stringify(mission), workId],
    );
  });

const setCurrentWork = (workId: WorkId | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "UPDATE workspaces SET current_work_id = ? WHERE workspace_id = ?",
      [workId, p7RootWorkspace],
    );
  });

const insertWait = (
  workId: WorkId,
  conditions: ReadonlyArray<unknown>,
): Effect.Effect<void, unknown, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "INSERT INTO work_waits (work_id, wait_mode, conditions_json, registered_at, updated_at) VALUES (?,?,?,?,?)",
      [workId, "Any", JSON.stringify(conditions), "t", "t"],
    );
  });

const refineWork = (workId: WorkId) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const works = yield* WorkRepository;
    yield* tx.transact(
      Effect.gen(function* () {
        const found = yield* works.findById(workId);
        if (Option.isSome(found)) {
          yield* works.refineIfRevision(
            workId,
            found.value.revision,
            {
              objective: found.value.objective,
              completionExpectation: found.value.completionExpectation,
              verificationMission: found.value.verificationMission,
            },
            WREV(Number(found.value.revision) + 1),
          );
        }
      }),
    );
  });

const seedDeliverable = (
  deliverableId: DeliverableId,
  sourceWorkId: WorkId,
  artifactId: ArtifactId,
) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const deliverables = yield* DeliverableRepository;
    yield* tx.transact(
      deliverables.insert(
        {
          deliverableId,
          sourceWorkId,
          sourceWorkRevision: 0,
          kind: "report",
        },
        [{ role: "summary", artifactId }],
        p7Project,
      ),
    );
  });

const countRows = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ readonly n: number }>(
      `SELECT COUNT(*) AS n FROM ${table}`,
    );
    return Number(rows[0]?.n ?? 0);
  });

const countEvents = (eventType: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ readonly n: number }>(
      "SELECT COUNT(*) AS n FROM domain_events WHERE event_type = ?",
      [eventType],
    );
    return Number(rows[0]?.n ?? 0);
  });

const eventPayloads = (eventType: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ readonly payload_json: string }>(
      "SELECT payload_json FROM domain_events WHERE event_type = ? ORDER BY sequence",
      [eventType],
    );
    return rows.map(
      (row) => JSON.parse(row.payload_json) as Record<string, unknown>,
    );
  });

const receiptResolution = (commandId: CommandId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ readonly resolution: string }>(
      "SELECT resolution FROM commands WHERE command_id = ?",
      [commandId],
    );
    return rows.length === 1
      ? (rows[0] as { readonly resolution: string }).resolution
      : null;
  });

const worksSnapshot = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe("SELECT * FROM works ORDER BY work_id");
  return JSON.stringify(rows);
});

const workRowOf = (workId: WorkId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ lifecycle: string; revision: number }>(
      "SELECT lifecycle, revision FROM works WHERE work_id = ?",
      [workId],
    );
    return rows[0] as { lifecycle: string; revision: number };
  });

const storedCurrentWorkId = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{ current_work_id: string | null }>(
    "SELECT current_work_id FROM workspaces WHERE workspace_id = ?",
    [p7RootWorkspace],
  );
  return rows[0]?.current_work_id ?? null;
});

const executionRowOf = (executionId: ExecutionId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{
      binding_kind: string;
      parent_execution_id: string | null;
      settlement_kind: string | null;
      stop_requested_at: string | null;
    }>(
      "SELECT binding_kind, parent_execution_id, settlement_kind, stop_requested_at FROM executions WHERE execution_id = ?",
      [executionId],
    );
    return rows[0] as {
      binding_kind: string;
      parent_execution_id: string | null;
      settlement_kind: string | null;
      stop_requested_at: string | null;
    };
  });

const ownerWorkspaceIdOf = (verificationId: VerificationId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ owner_workspace_id: string }>(
      "SELECT owner_workspace_id FROM verifications WHERE verification_id = ?",
      [verificationId],
    );
    return rows[0]?.owner_workspace_id ?? null;
  });

const requireVerification = (verificationId: VerificationId) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const verifications = yield* VerificationRepository;
    const found = yield* tx.transact(verifications.findById(verificationId));
    if (Option.isNone(found)) {
      return yield* Effect.die(
        new Error(`verification missing: ${verificationId}`),
      );
    }
    return found.value;
  });

const openVerificationOf = (workId: WorkId, targetWorkRevision: number) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const verifications = yield* VerificationRepository;
    return yield* tx.transact(
      verifications.findOpenByWorkRevision(workId, targetWorkRevision),
    );
  });

const acceptanceOf = (workId: WorkId, targetWorkRevision: number) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const acceptances = yield* AcceptanceRepository;
    return yield* tx.transact(
      acceptances.findByWorkRevision(workId, targetWorkRevision),
    );
  });

const fingerprintOf = (commandType: string, payload: unknown) =>
  semanticRequestFingerprint({
    commandType,
    projectId: p7Project,
    actor: p7TestActor,
    schemaVersion: "1",
    payload,
  });

const envelopeOf = <P>(
  commandType: string,
  commandId: CommandId,
  payload: P,
): GatewayEnvelope<P> => ({
  commandType,
  commandId,
  projectId: p7Project,
  actor: p7TestActor,
  issuedAt: "t",
  payload,
});

const externalContext: CommandSubmissionContext = {
  _tag: "External",
  principal: p7TestPrincipal,
};

const verifierContextOf = (
  executionId: ExecutionId,
): CommandSubmissionContext => ({
  _tag: "ExecutionOrigin",
  principal: p7TestPrincipal,
  executionId,
  fencingGeneration: parse(LeaseGeneration)(0),
});

const startPayload = (
  verificationId: VerificationId,
  workId: WorkId,
  observedWorkRevision: number,
  missionSnapshot: VerificationMission,
  verifierExecutionId: ExecutionId,
  overrides: {
    targetDeliverables?: ReadonlyArray<DeliverableId>;
    executableMission?: boolean;
  } = {},
): StartVerificationPayload => ({
  verificationId,
  workId,
  observedWorkRevision: WREV(observedWorkRevision),
  missionSnapshot,
  verifierExecutionId,
  executableMission: false,
  ...overrides,
});

const recordPayload = (
  verificationId: VerificationId,
  evidenceId: EvidenceId,
  criterionId: string,
): RecordVerificationEvidencePayload => ({
  verificationId,
  evidence: {
    evidenceId,
    criterionId,
    kind: "ToolObservation",
    recordedAt: "t",
  },
});

const submitStart = (commandId: CommandId, payload: StartVerificationPayload) =>
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    return yield* gateway.execute<StartVerificationPayload, unknown>(
      envelopeOf("StartVerification", commandId, payload),
      externalContext,
      {
        _tag: "StartVerificationAuthority",
        principal: p7TestPrincipal,
        commandId,
        semanticRequestFingerprint: fingerprintOf("StartVerification", payload),
        projectId: p7Project,
        targetWorkspaceId: p7RootWorkspace,
        workId: payload.workId,
      },
    );
  });

const submitRecord = (
  commandId: CommandId,
  payload: RecordVerificationEvidencePayload,
  executionId: ExecutionId,
) =>
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    return yield* gateway.execute<RecordVerificationEvidencePayload, unknown>(
      envelopeOf("RecordVerificationEvidence", commandId, payload),
      verifierContextOf(executionId),
      {
        _tag: "VerifierExecutionAuthority",
        principal: p7TestPrincipal,
        commandId,
        semanticRequestFingerprint: fingerprintOf(
          "RecordVerificationEvidence",
          payload,
        ),
        projectId: p7Project,
        verificationId: payload.verificationId,
        executionId,
      },
    );
  });

const submitConclude = (
  commandId: CommandId,
  payload: ConcludeVerificationPayload,
  executionId: ExecutionId,
) =>
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    return yield* gateway.execute<ConcludeVerificationPayload, unknown>(
      envelopeOf("ConcludeVerification", commandId, payload),
      verifierContextOf(executionId),
      {
        _tag: "VerifierExecutionAuthority",
        principal: p7TestPrincipal,
        commandId,
        semanticRequestFingerprint: fingerprintOf(
          "ConcludeVerification",
          payload,
        ),
        projectId: p7Project,
        verificationId: payload.verificationId,
        executionId,
      },
    );
  });

const submitConcludeOrphaned = (
  commandId: CommandId,
  payload: ConcludeVerificationPayload,
) =>
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    return yield* gateway.execute<ConcludeVerificationPayload, unknown>(
      envelopeOf("ConcludeVerification", commandId, payload),
      externalContext,
      {
        _tag: "OrphanConclusionAuthority",
        principal: p7TestPrincipal,
        commandId,
        semanticRequestFingerprint: fingerprintOf(
          "ConcludeVerification",
          payload,
        ),
        projectId: p7Project,
        targetWorkspaceId: p7RootWorkspace,
        verificationId: payload.verificationId,
      },
    );
  });

const submitAccept = (
  commandId: CommandId,
  payload: AcceptWorkOutcomePayload,
) =>
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    return yield* gateway.execute<AcceptWorkOutcomePayload, unknown>(
      envelopeOf("AcceptWorkOutcome", commandId, payload),
      externalContext,
      {
        _tag: "AcceptanceAuthority",
        principal: p7TestPrincipal,
        commandId,
        semanticRequestFingerprint: fingerprintOf("AcceptWorkOutcome", payload),
        projectId: p7Project,
        targetWorkspaceId: p7RootWorkspace,
        workId: payload.workId,
        verificationId: payload.verificationId,
      },
    );
  });

interface ReceiptLike {
  readonly resolution: {
    readonly _tag: string;
    readonly error?: { readonly _tag: string };
  };
}

const expectTerminalRejected = (receipt: ReceiptLike, tag: string) => {
  expect(receipt.resolution._tag).toBe("TerminalRejected");
  if (
    receipt.resolution._tag === "TerminalRejected" &&
    receipt.resolution.error
  ) {
    expect(receipt.resolution.error._tag).toBe(tag);
  }
};

const makeConsumerADeps = Effect.gen(function* () {
  const gateway = yield* CommandGateway;
  const tx = yield* TransactionPort;
  const verifications = yield* VerificationRepository;
  const works = yield* WorkRepository;
  const workspaces = yield* WorkspaceRepository;
  return {
    gateway,
    verifications: {
      findOpenByWorkRevision: (workId: WorkId, targetWorkRevision: number) =>
        tx.transact(
          verifications.findOpenByWorkRevision(workId, targetWorkRevision),
        ),
      findById: (verificationId: VerificationId) =>
        tx.transact(verifications.findById(verificationId)),
    },
    works: {
      findById: (workId: WorkId) => tx.transact(works.findById(workId)),
    },
    workspaces: {
      findById: (workspaceId: WorkspaceId) =>
        tx.transact(workspaces.findById(workspaceId)),
    },
  };
});

const makeConsumerBDeps = Effect.gen(function* () {
  const gateway = yield* CommandGateway;
  const tx = yield* TransactionPort;
  const verifications = yield* VerificationRepository;
  const acceptances = yield* AcceptanceRepository;
  const works = yield* WorkRepository;
  return {
    gateway,
    verifications: {
      findById: (verificationId: VerificationId) =>
        tx.transact(verifications.findById(verificationId)),
    },
    acceptances: {
      findByWorkRevision: (workId: WorkId, targetWorkRevision: number) =>
        tx.transact(acceptances.findByWorkRevision(workId, targetWorkRevision)),
    },
    works: {
      findById: (workId: WorkId) => tx.transact(works.findById(workId)),
    },
  };
});

const makeWakeDeps = Effect.gen(function* () {
  return {
    tx: yield* TransactionPort,
    waits: yield* WorkWaitStore,
    works: yield* WorkRepository,
    scheduler: yield* ExecutionScheduler,
  } satisfies VerificationWakeDependencies;
});

const makeSpawnDeps = Effect.gen(function* () {
  return {
    gateway: yield* CommandGateway,
    verifications: yield* VerificationRepository,
    executions: yield* ExecutionRepository,
    tx: yield* TransactionPort,
    clock: yield* Clock,
    principal: VERIFIER_PRINCIPAL,
  } satisfies VerifierSpawnDependencies;
});

const spawnFor = (
  verification: Verification,
  verifierExecutionId: ExecutionId,
) =>
  Effect.gen(function* () {
    const deps = yield* makeSpawnDeps;
    return yield* ensureVerifierSpawned(
      {
        verification,
        projectId: p7Project,
        ownerWorkspaceId: p7RootWorkspace,
        verifierExecutionId,
        missionDigest: missionDigestOf(verification.missionSnapshot),
      },
      deps,
    );
  });

const deliverConclusion = (
  verdict: VerificationVerdict,
  workId: WorkId,
  verificationId: VerificationId,
) =>
  Effect.gen(function* () {
    const deps = yield* makeWakeDeps;
    return yield* deliverVerificationWake(
      {
        workId,
        targetWorkRevision: WREV(0),
        verdict,
        verificationId,
        ownerWorkspaceId: p7RootWorkspace,
      },
      deps,
    );
  });

describe("p8-acceptance", () => {
  it("Story A (06 §1): CompletionClaimed → Consumer A Start → verifier spawn → evidence ×2 → Conclude(Pass) → Accept → Consumer B CompleteWork; revision constant, binding chain, channel 1 only", async () => {
    const { app, calls } = makeStoryApp();
    await runStory(
      app,
      Effect.gen(function* () {
        yield* seedProject;
        yield* seedWork(WORK_A, cmd("89a0000000a1"));
        yield* seedWork(WORK_A_WAITER, cmd("89a0000000a2"));
        yield* setMission(WORK_A, MISSION_A);
        yield* setCurrentWork(WORK_A);
        yield* insertWait(WORK_A_WAITER, [
          {
            _tag: "VerificationChanged",
            workId: WORK_A,
            targetWorkRevision: 0,
          },
        ]);

        const consumerA = yield* makeConsumerADeps;
        const records = yield* runVerificationConsumer(
          [settledEventOf("evt-a-settled-1", WORK_A, "claim-a-1")],
          consumerA,
          p7Project,
          p7TestPrincipal,
        );
        expect(records).toEqual(["StartVerification"]);

        const ids = verificationSpawnIds(WORK_A, 0, "claim-a-1");
        const verification = yield* requireVerification(ids.verificationId);
        expect(verification.workId).toBe(WORK_A);
        expect(verification.targetWorkRevision).toBe(0);
        expect(verification.state).toEqual({ status: "Open" });
        expect(verification.missionSnapshot).toEqual(MISSION_A);
        expect(verification.verificationExecutionIds).toEqual([
          ids.verifierExecutionId,
        ]);
        expect(yield* countEvents("VerificationStarted")).toBe(1);
        expect(yield* receiptResolution(ids.commandId)).toBe("Committed");

        const spawn = yield* spawnFor(verification, ids.verifierExecutionId);
        expect(spawn).toEqual({ _tag: "Spawned", admitted: true });
        const executionRow = yield* executionRowOf(ids.verifierExecutionId);
        expect(executionRow.binding_kind).toBe("execution_bound");
        expect(executionRow.parent_execution_id).toBeNull();

        const record1 = yield* submitRecord(
          cmd("89a0000000a3"),
          recordPayload(ids.verificationId, EV_A1, "c1"),
          ids.verifierExecutionId,
        );
        expect(record1.resolution._tag).toBe("Committed");
        const record2 = yield* submitRecord(
          cmd("89a0000000a4"),
          recordPayload(ids.verificationId, EV_A2, "c2"),
          ids.verifierExecutionId,
        );
        expect(record2.resolution._tag).toBe("Committed");
        expect(yield* countRows("verification_evidence")).toBe(2);

        const conclude = yield* submitConclude(
          cmd("89a0000000a5"),
          {
            verificationId: ids.verificationId,
            verdict: "Pass",
            criteriaResults: [
              criterionResult(MISSION_A, "c1", "Pass", [EV_A1]),
              criterionResult(MISSION_A, "c2", "Pass", [EV_A2]),
            ],
            summaryRef: "summary:a",
          },
          ids.verifierExecutionId,
        );
        expect(conclude.resolution._tag).toBe("Committed");

        expect(yield* countEvents("VerificationConcluded")).toBe(1);
        const concludedPayloads = yield* eventPayloads("VerificationConcluded");
        expect(concludedPayloads[0]).toEqual({
          verificationId: ids.verificationId,
          workId: WORK_A,
          targetWorkRevision: 0,
          verdict: "Pass",
          conclusionReason: "",
          evidenceRefs: [EV_A1, EV_A2],
        });

        const accept = yield* submitAccept(cmd("89a0000000a6"), {
          acceptanceId: ACC_A,
          workId: WORK_A,
          targetWorkRevision: WREV(0),
          verificationId: ids.verificationId,
        });
        expect(accept.resolution._tag).toBe("Committed");
        expect(yield* countEvents("WorkOutcomeAccepted")).toBe(1);

        const consumerB = yield* makeConsumerBDeps;
        const completed = yield* runCompletionConsumer(
          [
            acceptedEventOf("evt-a-accepted-1", {
              acceptanceId: ACC_A,
              workId: WORK_A,
              targetWorkRevision: 0,
              verificationId: ids.verificationId,
            }),
          ],
          consumerB,
          p7Project,
          p7TestPrincipal,
        );
        expect(completed).toEqual(["CompleteWork"]);
        expect(
          yield* receiptResolution(
            completionCommandId(WORK_A, WREV(0), ids.verificationId),
          ),
        ).toBe("Committed");

        const workRow = yield* workRowOf(WORK_A);
        expect(workRow.lifecycle).toBe("Completed");
        expect(workRow.revision).toBe(0);
        expect(yield* storedCurrentWorkId).toBe(null);
        expect(yield* countEvents("WorkCompleted")).toBe(1);

        const concluded = yield* requireVerification(ids.verificationId);
        expect(concluded.workId).toBe(WORK_A);
        expect(concluded.targetWorkRevision).toBe(0);
        expect(concluded.state).toEqual({
          status: "Concluded",
          verdict: "Pass",
        });
        const acceptance = yield* acceptanceOf(WORK_A, 0);
        expect(Option.isSome(acceptance)).toBe(true);
        if (Option.isSome(acceptance)) {
          expect(acceptance.value.acceptanceId).toBe(ACC_A);
          expect(acceptance.value.verificationId).toBe(ids.verificationId);
          expect(acceptance.value.targetWorkRevision).toBe(0);
        }

        const delivery = yield* deliverConclusion(
          "Pass",
          WORK_A,
          ids.verificationId,
        );
        expect(delivery.releasedWaits).toBeGreaterThanOrEqual(1);
        expect(delivery.routed).toBe(false);
        expect(calls).toEqual([]);
        const tx = yield* TransactionPort;
        const waits = yield* WorkWaitStore;
        expect(yield* tx.transact(waits.findByWork(WORK_A_WAITER))).toEqual(
          Option.none(),
        );
      }),
    );
  });

  it("Story B (06 §2): Conclude(Fail) routes channel 2 (VerificationReturned); same Producer work stays Open, no new Work, verifier writes zero works rows", async () => {
    const { app, calls } = makeStoryApp();
    await runStory(
      app,
      Effect.gen(function* () {
        yield* seedProject;
        yield* seedWork(WORK_B, cmd("89b0000000b1"));
        yield* setMission(WORK_B, MISSION_B);

        const consumerA = yield* makeConsumerADeps;
        const records = yield* runVerificationConsumer(
          [settledEventOf("evt-b-settled-1", WORK_B, "claim-b-1")],
          consumerA,
          p7Project,
          p7TestPrincipal,
        );
        expect(records).toEqual(["StartVerification"]);
        const ids = verificationSpawnIds(WORK_B, 0, "claim-b-1");
        const verification = yield* requireVerification(ids.verificationId);
        yield* spawnFor(verification, ids.verifierExecutionId);

        const before = yield* worksSnapshot;
        const record1 = yield* submitRecord(
          cmd("89b0000000b2"),
          recordPayload(ids.verificationId, EV_B1, "c1"),
          ids.verifierExecutionId,
        );
        expect(record1.resolution._tag).toBe("Committed");
        const record2 = yield* submitRecord(
          cmd("89b0000000b3"),
          recordPayload(ids.verificationId, EV_B2, "c2"),
          ids.verifierExecutionId,
        );
        expect(record2.resolution._tag).toBe("Committed");

        const conclude = yield* submitConclude(
          cmd("89b0000000b4"),
          {
            verificationId: ids.verificationId,
            verdict: "Fail",
            criteriaResults: [
              criterionResult(MISSION_B, "c1", "Fail", [EV_B1]),
              criterionResult(MISSION_B, "c2", "Pass", [EV_B2]),
            ],
            summaryRef: "summary:b",
          },
          ids.verifierExecutionId,
        );
        expect(conclude.resolution._tag).toBe("Committed");
        if (conclude.resolution._tag === "Committed") {
          expect(conclude.resolution.result).toMatchObject({
            state: "Concluded",
            verdict: "Fail",
          });
        }

        const delivery = yield* deliverConclusion(
          "Fail",
          WORK_B,
          ids.verificationId,
        );
        expect(delivery).toEqual({ releasedWaits: 0, routed: true });
        expect(calls).toEqual([
          {
            workspaceId: p7RootWorkspace,
            wakeReasonTag: "VerificationReturned",
          },
        ]);

        expect(yield* worksSnapshot).toBe(before);
        const workRow = yield* workRowOf(WORK_B);
        expect(workRow.lifecycle).toBe("Open");
        expect(workRow.revision).toBe(0);
        expect(yield* countRows("works")).toBe(1);
        expect(yield* countRows("verifications")).toBe(1);
        expect(yield* countEvents("WorkCompleted")).toBe(0);
        expect(yield* countEvents("WorkRefined")).toBe(0);
      }),
    );
  });

  it("Story C (06 §3): insufficient evidence aggregates Unknown; channel 2 still fires; no FAIL semantics, no rework branch, no auto-PASS, zero automatic Work mutation", async () => {
    const { app, calls } = makeStoryApp();
    await runStory(
      app,
      Effect.gen(function* () {
        yield* seedProject;
        yield* seedWork(WORK_C, cmd("89c0000000c1"));
        yield* setMission(WORK_C, MISSION_C);

        const consumerA = yield* makeConsumerADeps;
        const records = yield* runVerificationConsumer(
          [settledEventOf("evt-c-settled-1", WORK_C, "claim-c-1")],
          consumerA,
          p7Project,
          p7TestPrincipal,
        );
        expect(records).toEqual(["StartVerification"]);
        const ids = verificationSpawnIds(WORK_C, 0, "claim-c-1");
        const verification = yield* requireVerification(ids.verificationId);
        yield* spawnFor(verification, ids.verifierExecutionId);

        const before = yield* worksSnapshot;
        const record1 = yield* submitRecord(
          cmd("89c0000000c2"),
          recordPayload(ids.verificationId, EV_C1, "c1"),
          ids.verifierExecutionId,
        );
        expect(record1.resolution._tag).toBe("Committed");
        const record2 = yield* submitRecord(
          cmd("89c0000000c3"),
          recordPayload(ids.verificationId, EV_C2, "c2"),
          ids.verifierExecutionId,
        );
        expect(record2.resolution._tag).toBe("Committed");

        const conclude = yield* submitConclude(
          cmd("89c0000000c4"),
          {
            verificationId: ids.verificationId,
            verdict: "Unknown",
            criteriaResults: [
              criterionResult(MISSION_C, "c1", "Unknown", [EV_C1]),
              criterionResult(MISSION_C, "c2", "Pass", [EV_C2]),
            ],
            summaryRef: "summary:c",
          },
          ids.verifierExecutionId,
        );
        expect(conclude.resolution._tag).toBe("Committed");
        if (conclude.resolution._tag === "Committed") {
          expect(conclude.resolution.result).toMatchObject({
            state: "Concluded",
            verdict: "Unknown",
          });
        }
        const concluded = yield* requireVerification(ids.verificationId);
        expect(concluded.state).toEqual({
          status: "Concluded",
          verdict: "Unknown",
        });

        const delivery = yield* deliverConclusion(
          "Unknown",
          WORK_C,
          ids.verificationId,
        );
        expect(delivery).toEqual({ releasedWaits: 0, routed: true });
        expect(calls).toEqual([
          {
            workspaceId: p7RootWorkspace,
            wakeReasonTag: "VerificationReturned",
          },
        ]);

        expect(yield* worksSnapshot).toBe(before);
        const workRow = yield* workRowOf(WORK_C);
        expect(workRow.lifecycle).toBe("Open");
        expect(workRow.revision).toBe(0);
        expect(yield* countRows("verifications")).toBe(1);
        expect(yield* countRows("work_acceptances")).toBe(0);
        expect(yield* countEvents("WorkCompleted")).toBe(0);
        expect(yield* countEvents("WorkRefined")).toBe(0);
      }),
    );
  });

  it("Story D (06 §4): Pass then RefineWork invalidates the acceptance; stale AcceptWorkOutcome rejected; forged old-revision event skips in Consumer B; new revision re-chains", async () => {
    const { app } = makeStoryApp();
    await runStory(
      app,
      Effect.gen(function* () {
        yield* seedProject;
        yield* seedWork(WORK_D, cmd("89d0000000d1"));
        yield* setMission(WORK_D, MISSION_D);

        const consumerA = yield* makeConsumerADeps;
        const records = yield* runVerificationConsumer(
          [settledEventOf("evt-d-settled-1", WORK_D, "claim-d-1")],
          consumerA,
          p7Project,
          p7TestPrincipal,
        );
        expect(records).toEqual(["StartVerification"]);
        const ids = verificationSpawnIds(WORK_D, 0, "claim-d-1");
        const verification = yield* requireVerification(ids.verificationId);
        yield* spawnFor(verification, ids.verifierExecutionId);
        const record1 = yield* submitRecord(
          cmd("89d0000000d2"),
          recordPayload(ids.verificationId, EV_D1, "c1"),
          ids.verifierExecutionId,
        );
        expect(record1.resolution._tag).toBe("Committed");
        const record2 = yield* submitRecord(
          cmd("89d0000000d3"),
          recordPayload(ids.verificationId, EV_D2, "c2"),
          ids.verifierExecutionId,
        );
        expect(record2.resolution._tag).toBe("Committed");
        const conclude = yield* submitConclude(
          cmd("89d0000000d4"),
          {
            verificationId: ids.verificationId,
            verdict: "Pass",
            criteriaResults: [
              criterionResult(MISSION_D, "c1", "Pass", [EV_D1]),
              criterionResult(MISSION_D, "c2", "Pass", [EV_D2]),
            ],
            summaryRef: "summary:d",
          },
          ids.verifierExecutionId,
        );
        expect(conclude.resolution._tag).toBe("Committed");

        const accept = yield* submitAccept(cmd("89d0000000d5"), {
          acceptanceId: ACC_D1,
          workId: WORK_D,
          targetWorkRevision: WREV(0),
          verificationId: ids.verificationId,
        });
        expect(accept.resolution._tag).toBe("Committed");

        yield* refineWork(WORK_D);
        const refinedRow = yield* workRowOf(WORK_D);
        expect(refinedRow.lifecycle).toBe("Open");
        expect(refinedRow.revision).toBe(1);

        const staleAccept = yield* submitAccept(cmd("89d0000000d6"), {
          acceptanceId: ACC_D2,
          workId: WORK_D,
          targetWorkRevision: WREV(0),
          verificationId: ids.verificationId,
        });
        expectTerminalRejected(staleAccept, "VerificationAcceptanceMismatch");

        const consumerB = yield* makeConsumerBDeps;
        const completed = yield* runCompletionConsumer(
          [
            acceptedEventOf("evt-d-accepted-1", {
              acceptanceId: ACC_D1,
              workId: WORK_D,
              targetWorkRevision: 0,
              verificationId: ids.verificationId,
            }),
          ],
          consumerB,
          p7Project,
          p7TestPrincipal,
        );
        expect(completed).toEqual(["skip:VerificationAcceptanceMismatch"]);
        const afterSkip = yield* workRowOf(WORK_D);
        expect(afterSkip.lifecycle).toBe("Open");
        expect(afterSkip.revision).toBe(1);
        expect(yield* countEvents("WorkCompleted")).toBe(0);

        const retained = yield* requireVerification(ids.verificationId);
        expect(retained.state).toEqual({
          status: "Concluded",
          verdict: "Pass",
        });
        const retainedAcceptance = yield* acceptanceOf(WORK_D, 0);
        expect(Option.isSome(retainedAcceptance)).toBe(true);

        const restart = yield* submitStart(
          cmd("89d0000000d7"),
          startPayload(VER_D2, WORK_D, 1, MISSION_D, EXE_D2),
        );
        expect(restart.resolution._tag).toBe("Committed");
        const openAtNewRevision = yield* openVerificationOf(WORK_D, 1);
        expect(Option.isSome(openAtNewRevision)).toBe(true);
        if (Option.isSome(openAtNewRevision)) {
          expect(openAtNewRevision.value.verificationId).toBe(VER_D2);
        }
      }),
    );
  });

  it("Story E (06 §5): legacy placeholder mission typed-rejected; formation placeholder passes; deliverable sourceWorkRevision consistency enforced; executable mission requires environmentRevision", async () => {
    const { app } = makeStoryApp();
    await runStory(
      app,
      Effect.gen(function* () {
        yield* seedProject;
        yield* seedWork(WORK_E1, cmd("89e0000000e1"));
        yield* seedWork(WORK_E2, cmd("89e0000000e2"));
        yield* seedWork(WORK_E3, cmd("89e0000000e3"));

        yield* setMission(WORK_E1, LEGACY_PLACEHOLDER_MISSION);
        const legacy = yield* submitStart(
          cmd("89e0000000e4"),
          startPayload(VER_E1, WORK_E1, 0, LEGACY_PLACEHOLDER_MISSION, EXE_E1),
        );
        expectTerminalRejected(legacy, "InvalidVerificationMission");
        expect(yield* countRows("verifications")).toBe(0);

        yield* setMission(WORK_E1, FORMATION_PLACEHOLDER_MISSION);
        const formation = yield* submitStart(
          cmd("89e0000000e5"),
          startPayload(
            VER_E1,
            WORK_E1,
            0,
            FORMATION_PLACEHOLDER_MISSION,
            EXE_E1,
          ),
        );
        expect(formation.resolution._tag).toBe("Committed");
        const formationVerification = yield* requireVerification(VER_E1);
        expect(formationVerification.state).toEqual({ status: "Open" });

        yield* setMission(WORK_E2, MISSION_E);
        yield* seedDeliverable(DEL_E, WORK_E2, ART_E);
        const bound = yield* submitStart(
          cmd("89e0000000e6"),
          startPayload(VER_E2, WORK_E2, 0, MISSION_E, EXE_E2, {
            targetDeliverables: [DEL_E],
          }),
        );
        expect(bound.resolution._tag).toBe("Committed");
        const boundVerification = yield* requireVerification(VER_E2);
        expect(boundVerification.targetDeliverables).toEqual([DEL_E]);
        expect(boundVerification.targetArtifactVersions).toEqual([ART_E]);

        const sql = yield* SqlClient;
        yield* sql.unsafe(
          "UPDATE deliverables SET source_work_revision = 1 WHERE deliverable_id = ?",
          [DEL_E],
        );
        const mismatch = yield* submitStart(
          cmd("89e0000000e7"),
          startPayload(VER_E3, WORK_E2, 0, MISSION_E, EXE_E3, {
            targetDeliverables: [DEL_E],
          }),
        );
        expectTerminalRejected(mismatch, "InvalidVerificationMission");

        yield* setMission(WORK_E3, MISSION_E);
        const noEnvironment = yield* submitStart(
          cmd("89e0000000e8"),
          startPayload(VER_E4, WORK_E3, 0, MISSION_E, EXE_E4, {
            executableMission: true,
          }),
        );
        expectTerminalRejected(noEnvironment, "InvalidVerificationMission");

        const tx = yield* TransactionPort;
        const environmentRevisions = yield* EnvironmentRevisionStore;
        yield* tx.transact(environmentRevisions.record(p7Project, "env-e3"));
        const withEnvironment = yield* submitStart(
          cmd("89e0000000e9"),
          startPayload(VER_E5, WORK_E3, 0, MISSION_E, EXE_E5, {
            executableMission: true,
          }),
        );
        expect(withEnvironment.resolution._tag).toBe("Committed");
        const executable = yield* requireVerification(VER_E5);
        expect(executable.targetEnvironmentRevision).toBe("env-e3");
      }),
    );
  });

  it("Story F (06 §5 programs): six families eval green; verification forbidden-phrase negative; query-inspection read-only contract negative", async () => {
    const results = await Effect.runPromise(evalAllPrograms());
    expect(results).toHaveLength(6);
    expect(results.map((result) => result.familyId).sort()).toEqual(
      [
        "p6-bootstrap",
        "p6-communication",
        "p6-formation",
        "p6-human-steer",
        "p8-query-inspection",
        "p8-verification",
      ].sort(),
    );
    for (const result of results) {
      expect(result.passed).toBe(true);
      expect(result.missingClauses).toEqual([]);
      expect(result.presentForbidden).toEqual([]);
      expect(result.versionGate).toBe(true);
      expect(result.hashMatches).toBe(true);
    }
    const gate = await Effect.runPromise(assertProgramGate());
    expect(gate.passed).toBe(true);

    const verification = PROGRAM_REGISTRY.find(
      (entry) => entry.familyId === "p8-verification",
    ) as ProgramRegistryEntry;
    const content = readFileSync(programFilePath(verification), "utf8");
    const heading = content.match(/^#[^\n]*$/m);
    expect(heading).not.toBeNull();
    const headingIndex = heading?.index ?? 0;
    const bodyWithForbidden = `${content.slice(headingIndex)}\nAn auto-pass shortcut is exactly what this program forbids.\n`;
    const forged =
      `${content.slice(0, headingIndex)}${bodyWithForbidden}`.replace(
        /^textHash:.*$/m,
        `textHash: ${sha256Hex(bodyWithForbidden)}`,
      );
    const forbidden = evaluateProgramContent(verification, forged);
    expect(forbidden.hashMatches).toBe(true);
    expect(forbidden.versionGate).toBe(true);
    expect(forbidden.presentForbidden).toEqual(["auto-pass"]);
    expect(forbidden.passed).toBe(false);

    const queryInspection = PROGRAM_REGISTRY.find(
      (entry) => entry.familyId === "p8-query-inspection",
    ) as ProgramRegistryEntry;
    const writer: ProgramRegistryEntry = {
      ...queryInspection,
      mandatoryClauses: ["a query result may upsert canonical state"],
    };
    const writerResult = evaluateProgramContent(
      writer,
      readFileSync(programFilePath(queryInspection), "utf8"),
    );
    expect(writerResult.missingClauses).toEqual([
      "a query result may upsert canonical state",
    ]);
    expect(writerResult.passed).toBe(false);
  });

  it("Story G (06 §4 owner snapshot): Start records owner; retirement never auto-aborts the verifier; Unknown(Orphaned) carries conclusionReason and allows re-Start; second same-revision Start is VerificationAlreadyOpen", async () => {
    const { app } = makeStoryApp();
    await runStory(
      app,
      Effect.gen(function* () {
        yield* seedProject;
        yield* seedWork(WORK_G1, cmd("89f0000000f1"));
        yield* seedWork(WORK_G2, cmd("89f0000000f2"));
        yield* setMission(WORK_G1, MISSION_G);
        yield* setMission(WORK_G2, MISSION_G);

        const consumerA = yield* makeConsumerADeps;
        const records = yield* runVerificationConsumer(
          [settledEventOf("evt-g-settled-1", WORK_G1, "claim-g-1")],
          consumerA,
          p7Project,
          p7TestPrincipal,
        );
        expect(records).toEqual(["StartVerification"]);
        const ids = verificationSpawnIds(WORK_G1, 0, "claim-g-1");
        expect(yield* ownerWorkspaceIdOf(ids.verificationId)).toBe(
          p7RootWorkspace,
        );
        const verification = yield* requireVerification(ids.verificationId);
        yield* spawnFor(verification, ids.verifierExecutionId);

        const sql = yield* SqlClient;
        yield* sql.unsafe(
          "UPDATE workspaces SET lifecycle = 'Retired' WHERE workspace_id = ?",
          [p7RootWorkspace],
        );
        const executionRow = yield* executionRowOf(ids.verifierExecutionId);
        expect(executionRow.settlement_kind).toBeNull();
        expect(executionRow.stop_requested_at).toBeNull();
        const stillOpen = yield* requireVerification(ids.verificationId);
        expect(stillOpen.state).toEqual({ status: "Open" });

        const orphaned = yield* submitConcludeOrphaned(cmd("89f0000000f3"), {
          verificationId: ids.verificationId,
          verdict: "Unknown",
          criteriaResults: [],
          summaryRef: "summary:g",
          conclusionReason: "Orphaned",
        });
        expect(orphaned.resolution._tag).toBe("Committed");
        const concludedPayloads = yield* eventPayloads("VerificationConcluded");
        expect(concludedPayloads[0]).toMatchObject({
          verificationId: ids.verificationId,
          verdict: "Unknown",
          conclusionReason: "Orphaned",
          evidenceRefs: [],
        });
        const orphanedVerification = yield* requireVerification(
          ids.verificationId,
        );
        expect(orphanedVerification.state).toEqual({
          status: "Concluded",
          verdict: "Unknown",
          conclusionReason: "Orphaned",
        });

        const restart = yield* submitStart(
          cmd("89f0000000f4"),
          startPayload(VER_G1B, WORK_G1, 0, MISSION_G, EXE_G1B),
        );
        expect(restart.resolution._tag).toBe("Committed");
        const reopened = yield* openVerificationOf(WORK_G1, 0);
        expect(Option.isSome(reopened)).toBe(true);
        if (Option.isSome(reopened)) {
          expect(reopened.value.verificationId).toBe(VER_G1B);
          expect(reopened.value.verificationId).not.toBe(ids.verificationId);
        }

        const first = yield* submitStart(
          cmd("89f0000000f5"),
          startPayload(VER_G3, WORK_G2, 0, MISSION_G, EXE_G3),
        );
        expect(first.resolution._tag).toBe("Committed");
        const second = yield* submitStart(
          cmd("89f0000000f6"),
          startPayload(VER_G4, WORK_G2, 0, MISSION_G, EXE_G4),
        );
        expectTerminalRejected(second, "VerificationAlreadyOpen");
      }),
    );
  });
});
