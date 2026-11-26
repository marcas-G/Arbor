import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { expect } from "vitest";
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
} from "../../adapters/persistence-sqlite/src/index.js";
import {
  makeAcceptWorkOutcomeHandler,
  makeCompleteWorkHandler,
} from "../../packages/application/src/commands/accept-complete.js";
import {
  type CriterionResultInput,
  makeConcludeVerificationHandler,
  makeRecordVerificationEvidenceHandler,
} from "../../packages/application/src/commands/conclude-verification.js";
import { makeStartVerificationHandler } from "../../packages/application/src/commands/start-verification.js";
import {
  type CommandGateway,
  CommandGatewayLive,
  type CommandHandler,
  CommandHandlerRegistry,
  FenceStopCheckInertLive,
  makeP1CommandHandlers,
} from "../../packages/application/src/index.js";
import {
  AcceptanceId,
  ArtifactId,
  CommandId,
  DeliverableId,
  EvidenceId,
  ExecutionId,
  Principal,
  parse,
  VerificationId,
  type VerificationMission,
  type VerificationVerdict,
  WorkId,
  WorkRevision,
  type WorkspaceId,
} from "../../packages/domain/dist/index.js";
import { makeP2CommandHandlers } from "../../packages/execution-runtime/src/index.js";
import {
  AcceptanceRepository,
  type Clock,
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
} from "../../packages/ports/src/index.js";
import { NoHoldWorkReadmissionGateStoreService } from "../../packages/testkit/src/index.js";
import {
  p7Project,
  p7RootWorkspace,
  p7SeedProject,
  p7SeedWork,
  p7TestActor,
} from "../support/consumer-harness.js";

export const wrk = (tail: string) =>
  parse(WorkId)(`wrk_00000000-0000-7000-8000-000000${tail}`);
export const ver = (tail: string) =>
  parse(VerificationId)(`ver_00000000-0000-7000-8000-000000${tail}`);
export const exe = (tail: string) =>
  parse(ExecutionId)(`exe_00000000-0000-7000-8000-000000${tail}`);
export const evd = (tail: string) =>
  parse(EvidenceId)(`evd_00000000-0000-7000-8000-000000${tail}`);
export const acc = (tail: string) =>
  parse(AcceptanceId)(`acc_00000000-0000-7000-8000-000000${tail}`);
export const art = (tail: string) =>
  parse(ArtifactId)(`art_00000000-0000-7000-8000-000000${tail}`);
export const del = (tail: string) =>
  parse(DeliverableId)(`del_00000000-0000-7000-8000-000000${tail}`);
export const cmd = (tail: string) =>
  parse(CommandId)(`cmd_018f2b3c-4d5e-7abc-8def-${tail}`);
export const WREV = (n: number) => parse(WorkRevision)(n);

export const VERIFIER_PRINCIPAL = parse(Principal)("runtime:verifier");

export const WORK_A = wrk("00a001");
export const WORK_A_WAITER = wrk("00a002");
export const EV_A1 = evd("00a011");
export const EV_A2 = evd("00a012");
export const ACC_A = acc("00a021");

export const WORK_B = wrk("00b001");
export const EV_B1 = evd("00b011");
export const EV_B2 = evd("00b012");

export const WORK_C = wrk("00c001");
export const EV_C1 = evd("00c011");
export const EV_C2 = evd("00c012");

export const WORK_D = wrk("00d001");
export const EV_D1 = evd("00d011");
export const EV_D2 = evd("00d012");
export const ACC_D1 = acc("00d021");
export const ACC_D2 = acc("00d022");
export const VER_D2 = ver("00d002");
export const EXE_D2 = exe("00d042");

export const WORK_E1 = wrk("00e001");
export const WORK_E2 = wrk("00e002");
export const WORK_E3 = wrk("00e003");
export const DEL_E = del("00e011");
export const ART_E = art("00e012");
export const VER_E1 = ver("00e021");
export const VER_E2 = ver("00e022");
export const VER_E3 = ver("00e023");
export const VER_E4 = ver("00e024");
export const VER_E5 = ver("00e025");
export const EXE_E1 = exe("00e031");
export const EXE_E2 = exe("00e032");
export const EXE_E3 = exe("00e033");
export const EXE_E4 = exe("00e034");
export const EXE_E5 = exe("00e035");

export const WORK_G1 = wrk("00f001");
export const WORK_G2 = wrk("00f002");
export const VER_G1B = ver("00f011");
export const VER_G3 = ver("00f012");
export const VER_G4 = ver("00f013");
export const EXE_G1B = exe("00f021");
export const EXE_G3 = exe("00f022");
export const EXE_G4 = exe("00f023");

export const missionOf = (goal: string): VerificationMission => ({
  goal,
  criteria: [
    { criterionId: "c1", requirement: "tests pass", required: true },
    { criterionId: "c2", requirement: "lint clean", required: true },
  ],
  riskRequirements: [],
});

export const MISSION_A = missionOf("verify the completed outcome");
export const MISSION_B = missionOf("verify the rework outcome");
export const MISSION_C = missionOf("verify the uncertain outcome");
export const MISSION_D = missionOf("verify before refine");
export const MISSION_E = missionOf("verify the bound deliverable");
export const MISSION_G = missionOf("verify the orphan-prone outcome");

export const LEGACY_PLACEHOLDER_MISSION: VerificationMission = {
  goal: "p6-placeholder",
  criteria: [],
  riskRequirements: [],
};

export const FORMATION_PLACEHOLDER_MISSION: VerificationMission = {
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

export const missionDigestOf = (mission: VerificationMission): string =>
  `${mission.goal} [criteria=${mission.criteria.length} required=${mission.criteria.filter((criterion) => criterion.required).length}]`;

export const criterionResult = (
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

export const settledEventOf = (
  eventId: string,
  workId: WorkId,
  claimRef: string,
): {
  eventType: string;
  eventId: string;
  occurredAt: string;
  payload: unknown;
} => ({
  eventType: "ExecutionSettled",
  eventId,
  occurredAt: "2026-01-01T00:00:00.000Z",
  payload: {
    executionId: `exe_acceptance_${claimRef}`,
    workId,
    workRevision: 0,
    claimRef,
  },
});

export const acceptedEventOf = (
  eventId: string,
  payload: {
    acceptanceId: AcceptanceId;
    workId: WorkId;
    targetWorkRevision: number;
    verificationId: VerificationId;
  },
): {
  eventType: string;
  eventId: string;
  occurredAt: string;
  payload: unknown;
} => ({
  eventType: "WorkOutcomeAccepted",
  eventId,
  occurredAt: "2026-01-01T00:00:00.000Z",
  payload: { ...payload, actor: p7TestActor },
});

export interface SchedulerCall {
  readonly workspaceId: WorkspaceId;
  readonly wakeReasonTag: string;
}

export const makeSchedulerStub = () => {
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

export type RegistryDeps =
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

export const StoryRegistryLive: Layer.Layer<
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
        readmissionGate: NoHoldWorkReadmissionGateStoreService,
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
                      _tag: "PersistenceUnavailable",
                      repository: "DeliverableRepository",
                      operation: "list-artifacts",
                      retryDisposition: "non-retryable",
                      sourceTag: "SqlError",
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

export type StoryServices =
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

export const makeStoryApp = () => {
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

export const runStory = <A>(
  app: Layer.Layer<StoryServices>,
  program: Effect.Effect<A, unknown, StoryServices>,
): Promise<A> => Effect.runPromise(Effect.scoped(Effect.provide(program, app)));

export const seedProject = Effect.gen(function* () {
  yield* runMigrations(P8_MIGRATIONS);
  yield* p7SeedProject;
});

export const seedWork = (workId: WorkId, commandId: CommandId) =>
  Effect.gen(function* () {
    const receipt = yield* p7SeedWork(workId, commandId);
    expect(receipt.resolution._tag).toBe("Committed");
  });

export const setMission = (workId: WorkId, mission: VerificationMission) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "UPDATE works SET verification_mission = ? WHERE work_id = ?",
      [JSON.stringify(mission), workId],
    );
  });

export const setCurrentWork = (workId: WorkId | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "UPDATE workspaces SET current_work_id = ? WHERE workspace_id = ?",
      [workId, p7RootWorkspace],
    );
  });

export const insertWait = (
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

export const refineWork = (workId: WorkId) =>
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

export const seedDeliverable = (
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

export const countRows = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ readonly n: number }>(
      `SELECT COUNT(*) AS n FROM ${table}`,
    );
    return Number(rows[0]?.n ?? 0);
  });

export const countEvents = (eventType: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ readonly n: number }>(
      "SELECT COUNT(*) AS n FROM domain_events WHERE event_type = ?",
      [eventType],
    );
    return Number(rows[0]?.n ?? 0);
  });

export const eventPayloads = (eventType: string) =>
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

export const receiptResolution = (commandId: CommandId) =>
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

export const worksSnapshot = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe("SELECT * FROM works ORDER BY work_id");
  return JSON.stringify(rows);
});

export const workRowOf = (workId: WorkId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ lifecycle: string; revision: number }>(
      "SELECT lifecycle, revision FROM works WHERE work_id = ?",
      [workId],
    );
    return rows[0] as { lifecycle: string; revision: number };
  });

export const storedCurrentWorkId = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{ current_work_id: string | null }>(
    "SELECT current_work_id FROM workspaces WHERE workspace_id = ?",
    [p7RootWorkspace],
  );
  return rows[0]?.current_work_id ?? null;
});

export const executionRowOf = (executionId: ExecutionId) =>
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

export const ownerWorkspaceIdOf = (verificationId: VerificationId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ owner_workspace_id: string }>(
      "SELECT owner_workspace_id FROM verifications WHERE verification_id = ?",
      [verificationId],
    );
    return rows[0]?.owner_workspace_id ?? null;
  });

export const requireVerification = (verificationId: VerificationId) =>
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

export const openVerificationOf = (
  workId: WorkId,
  targetWorkRevision: number,
) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const verifications = yield* VerificationRepository;
    return yield* tx.transact(
      verifications.findOpenByWorkRevision(workId, targetWorkRevision),
    );
  });

export const acceptanceOf = (workId: WorkId, targetWorkRevision: number) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const acceptances = yield* AcceptanceRepository;
    return yield* tx.transact(
      acceptances.findByWorkRevision(workId, targetWorkRevision),
    );
  });
