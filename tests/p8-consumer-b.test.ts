import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  AcceptanceRepositoryLive,
  ClockLive,
  CommandStoreLive,
  DomainEventJournalLive,
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
} from "../adapters/persistence-sqlite/src/index.js";
import { makeCompleteWorkHandler } from "../packages/application/src/commands/accept-complete.js";
import {
  completionCommandId,
  runCompletionConsumer,
} from "../packages/application/src/completion-consumer.js";
import {
  type CommandAuthorityFact,
  CommandGateway,
  CommandGatewayLive,
  type CommandGatewayService,
  type CommandHandler,
  CommandHandlerRegistry,
  FenceStopCheckInertLive,
  type GatewayEnvelope,
  makeP1CommandHandlers,
} from "../packages/application/src/index.js";
import {
  AcceptanceId,
  CommandId,
  type CommandSubmissionContext,
  parse,
  startVerification,
  VerificationId,
  type VerificationMission,
  type VerificationVerdict,
  WorkId,
  WorkRevision,
} from "../packages/domain/dist/index.js";
import {
  AcceptanceRepository,
  ProjectRepository,
  SessionRepository,
  TransactionPort,
  VerificationRepository,
  WorkRepository,
  WorkspaceRepository,
} from "../packages/ports/src/index.js";
import {
  p7Project,
  p7RootWorkspace,
  p7SeedProject,
  p7SeedWork,
  p7TestActor,
  p7TestPrincipal,
} from "./support/p7-app.js";

const WORK_1 = parse(WorkId)("wrk_00000000-0000-7000-8000-000000000001");
const ASSIGN_CMD = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789a1");

const VER = (n: number) =>
  parse(VerificationId)(`ver_00000000-0000-7000-8000-00000000000${n}`);
const ACC = (n: number) =>
  parse(AcceptanceId)(`acc_00000000-0000-7000-8000-00000000000${n}`);
const WREV = (n: number) => parse(WorkRevision)(n);

const mission: VerificationMission = {
  goal: "g",
  criteria: [{ criterionId: "c1", requirement: "r1", required: true }],
  riskRequirements: [],
};

const seed = Effect.gen(function* () {
  yield* runMigrations(P8_MIGRATIONS);
  yield* p7SeedProject;
  const receipt = yield* p7SeedWork(WORK_1, ASSIGN_CMD);
  expect(receipt.resolution._tag).toBe("Committed");
});

/** Seeds one Concluded-Pass verification for WORK_1 at revision 0
 * (p8-acceptance-commands repository pattern). */
const seedVerification = (
  verificationId: VerificationId,
  verdict: VerificationVerdict | undefined,
) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const verifications = yield* VerificationRepository;
    yield* tx.transact(
      verifications.insert(
        startVerification({
          verificationId,
          workId: WORK_1,
          targetWorkRevision: WREV(0),
          missionSnapshot: mission,
        }),
        p7Project,
        p7RootWorkspace,
      ),
    );
    if (verdict !== undefined) {
      const concluded = yield* tx.transact(
        verifications.concludeIfOpen(verificationId, verdict, undefined),
      );
      expect(Option.isSome(concluded)).toBe(true);
    }
  });

/** Seeds the acceptance row directly (repository insert): the whole chain
 * up to the WorkOutcomeAccepted fact is store state — the consumer starts
 * from the event object alone. */
const seedAcceptance = (
  acceptanceId: AcceptanceId,
  verificationId: VerificationId,
) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const acceptances = yield* AcceptanceRepository;
    yield* tx.transact(
      acceptances.insert(
        {
          acceptanceId,
          workId: WORK_1,
          targetWorkRevision: WREV(0),
          verificationId,
          actor: p7TestActor,
          acceptedAt: "t",
        },
        p7Project,
      ),
    );
  });

const storedWorkRow = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{
    lifecycle: string;
    revision: number;
  }>("SELECT lifecycle, revision FROM works WHERE work_id = ?", [WORK_1]);
  return rows[0]!;
});

const storedCurrentWorkId = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{ current_work_id: string | null }>(
    "SELECT current_work_id FROM workspaces WHERE workspace_id = ?",
    [p7RootWorkspace],
  );
  return rows[0]!.current_work_id;
});

const setCurrentWorkBySql = (workId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "UPDATE workspaces SET current_work_id = ? WHERE workspace_id = ?",
      [workId, p7RootWorkspace],
    );
  });

/** Bumps the Work revision via the repository CAS (fields unchanged). */
const refineWorkBySql = Effect.gen(function* () {
  const tx = yield* TransactionPort;
  const works = yield* WorkRepository;
  yield* tx.transact(
    Effect.gen(function* () {
      const found = yield* works.findById(WORK_1);
      if (Option.isSome(found)) {
        yield* works.refineIfRevision(
          WORK_1,
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

const countDomainEvents = (eventType: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ readonly n: number }>(
      "SELECT COUNT(*) AS n FROM domain_events WHERE event_type = ?",
      [eventType],
    );
    return rows[0]?.n ?? 0;
  });

const workCompletedRow = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{
    aggregate_ref: string;
    caused_by_command_id: string | null;
  }>(
    "SELECT aggregate_ref, caused_by_command_id FROM domain_events WHERE event_type = 'WorkCompleted'",
  );
  return rows[0]!;
});

const receiptResolution = (commandId: CommandId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ resolution: string }>(
      "SELECT resolution FROM commands WHERE command_id = ?",
      [commandId],
    );
    return rows.length === 1 ? rows[0]!.resolution : null;
  });

/** Trigger event shaped exactly as AcceptWorkOutcome journals it
 * (WorkOutcomeAccepted payload: acceptanceId/workId/targetWorkRevision/
 * verificationId/actor). */
const acceptedEvent = (n: number) => ({
  eventType: "WorkOutcomeAccepted",
  eventId: `evt-accepted-${n}`,
  payload: {
    acceptanceId: ACC(n),
    workId: WORK_1,
    targetWorkRevision: 0,
    verificationId: VER(n),
    actor: p7TestActor,
  },
});

/** Recording proxy: every gateway submission the consumer makes. */
interface SubmissionRecord {
  readonly commandType: string;
  readonly commandId: string;
  readonly causationRef: string | undefined;
  readonly contextTag: string;
  readonly contextCausationRef: string | undefined;
  readonly authorityTag: string;
  readonly payload: unknown;
}

const spyGateway = (
  gateway: CommandGatewayService,
  sink: Array<SubmissionRecord>,
): CommandGatewayService => ({
  execute: <C, R>(
    envelope: GatewayEnvelope<C>,
    context: CommandSubmissionContext,
    authority: CommandAuthorityFact,
  ) => {
    sink.push({
      commandType: envelope.commandType,
      commandId: envelope.commandId,
      causationRef: envelope.causationRef,
      contextTag: context._tag,
      contextCausationRef:
        context._tag === "System" ? context.causationRef : undefined,
      authorityTag: authority._tag,
      payload: envelope.payload,
    });
    return gateway.execute<C, R>(envelope, context, authority);
  },
});

const makeConsumerDeps = (
  wrapGateway?: (gateway: CommandGatewayService) => CommandGatewayService,
) =>
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    const tx = yield* TransactionPort;
    const works = yield* WorkRepository;
    const verifications = yield* VerificationRepository;
    const acceptances = yield* AcceptanceRepository;
    return {
      gateway: wrapGateway === undefined ? gateway : wrapGateway(gateway),
      verifications: {
        findById: (verificationId: VerificationId) =>
          tx.transact(verifications.findById(verificationId)),
      },
      acceptances: {
        findByWorkRevision: (workId: WorkId, targetWorkRevision: number) =>
          tx.transact(
            acceptances.findByWorkRevision(workId, targetWorkRevision),
          ),
      },
      works: {
        findById: (workId: WorkId) => tx.transact(works.findById(workId)),
      },
    };
  });

/** Mini gateway (p7-coordinator assembly, minimal segment): P1 handlers
 * (seeding only) + exactly one CompleteWork handler — any commandType the
 * consumer submits other than CompleteWork finds no handler and dies,
 * making the single-command-face assertion mechanical. */
type MiniAppServices =
  | CommandGateway
  | SqlClient
  | TransactionPort
  | WorkspaceRepository
  | WorkRepository
  | VerificationRepository
  | AcceptanceRepository;

const makeMiniApp = (): Layer.Layer<MiniAppServices> => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const repositories = Layer.mergeAll(
    Layer.provide(ProjectRepositoryLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(SessionRepositoryLive, infra),
    Layer.provide(WorkRepositoryLive, infra),
    Layer.provide(VerificationRepositoryLive, infra),
    Layer.provide(AcceptanceRepositoryLive, infra),
  );
  const registry = Layer.provide(
    Layer.effect(
      CommandHandlerRegistry,
      Effect.gen(function* () {
        const projects = yield* ProjectRepository;
        const workspaces = yield* WorkspaceRepository;
        const sessions = yield* SessionRepository;
        const works = yield* WorkRepository;
        const verifications = yield* VerificationRepository;
        const acceptances = yield* AcceptanceRepository;
        const handlers: ReadonlyArray<CommandHandler<unknown, unknown>> = [
          ...makeP1CommandHandlers({ projects, workspaces, sessions, works }),
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
    ),
    repositories,
  );
  const gatewayDeps = Layer.mergeAll(
    infra,
    registry,
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(CommandStoreLive, infra),
    Layer.provide(DomainEventJournalLive, infra),
    repositories,
    FenceStopCheckInertLive,
  );
  return Layer.mergeAll(
    gatewayDeps,
    Layer.provide(CommandGatewayLive, gatewayDeps),
  ) as Layer.Layer<MiniAppServices>;
};

const runMini = <A>(
  program: Effect.Effect<A, unknown, MiniAppServices>,
): Promise<A> =>
  Effect.runPromise(Effect.scoped(Effect.provide(program, makeMiniApp())));

describe("p8-consumer-b", () => {
  it("WorkOutcomeAccepted completes the Work through CompleteWork: lifecycle Completed, WorkCompleted journaled under the deterministic CommandId, currentWorkId cleared", async () => {
    await runMini(
      Effect.gen(function* () {
        yield* seed;
        yield* setCurrentWorkBySql(WORK_1);
        yield* seedVerification(VER(1), "Pass");
        yield* seedAcceptance(ACC(1), VER(1));
        const submissions: Array<SubmissionRecord> = [];
        const deps = yield* makeConsumerDeps((gateway) =>
          spyGateway(gateway, submissions),
        );
        const records = yield* runCompletionConsumer(
          [acceptedEvent(1)],
          deps,
          p7Project,
          p7TestPrincipal,
        );
        expect(records).toEqual(["CompleteWork"]);
        // Single command face (契约 §2): exactly one CompleteWork submission
        // via the CommandGateway, System origin with the event-causation
        // ref, CompleteWorkAuthority, full-payload fingerprint input.
        const commandId = completionCommandId(WORK_1, WREV(0), VER(1));
        expect(submissions).toEqual([
          {
            commandType: "CompleteWork",
            commandId,
            causationRef: "evt-accepted-1",
            contextTag: "System",
            contextCausationRef: "p8-completion-consumer:evt-accepted-1",
            authorityTag: "CompleteWorkAuthority",
            payload: { workId: WORK_1, expectedWorkRevision: 0 },
          },
        ]);
        // Deterministic CommandId (§2): the committed receipt is stored
        // under the re-derivable id — the at-least-once absorption face.
        expect(yield* receiptResolution(commandId)).toBe("Committed");
        const workRow = yield* storedWorkRow;
        expect(workRow.lifecycle).toBe("Completed");
        expect(yield* storedCurrentWorkId).toBe(null);
        const completed = yield* workCompletedRow;
        expect(completed.aggregate_ref).toBe(WORK_1);
        expect(completed.caused_by_command_id).toBe(commandId);
      }),
    );
  });

  it("replaying the same event is idempotent: TerminalLifecycleMutation skip, no second mutation", async () => {
    await runMini(
      Effect.gen(function* () {
        yield* seed;
        yield* setCurrentWorkBySql(WORK_1);
        yield* seedVerification(VER(2), "Pass");
        yield* seedAcceptance(ACC(2), VER(2));
        const deps = yield* makeConsumerDeps();
        const event = acceptedEvent(2);
        const first = yield* runCompletionConsumer(
          [event],
          deps,
          p7Project,
          p7TestPrincipal,
        );
        expect(first).toEqual(["CompleteWork"]);
        expect(yield* storedCurrentWorkId).toBe(null);
        const replay = yield* runCompletionConsumer(
          [event],
          deps,
          p7Project,
          p7TestPrincipal,
        );
        expect(replay).toEqual(["skip:TerminalLifecycleMutation"]);
        const workRow = yield* storedWorkRow;
        expect(workRow.lifecycle).toBe("Completed");
        expect(yield* countDomainEvents("WorkCompleted")).toBe(1);
        expect(yield* storedCurrentWorkId).toBe(null);
      }),
    );
  });

  it("forged event without an acceptance row: the handler re-validation Mismatch is recorded as a skip, no mutation", async () => {
    await runMini(
      Effect.gen(function* () {
        yield* seed;
        yield* seedVerification(VER(3), "Pass");
        const deps = yield* makeConsumerDeps();
        const records = yield* runCompletionConsumer(
          [acceptedEvent(3)],
          deps,
          p7Project,
          p7TestPrincipal,
        );
        expect(records).toEqual(["skip:VerificationAcceptanceMismatch"]);
        const workRow = yield* storedWorkRow;
        expect(workRow.lifecycle).toBe("Open");
        expect(yield* countDomainEvents("WorkCompleted")).toBe(0);
      }),
    );
  });

  it("refine after acceptance (revision moved forward): Mismatch skip, Work stays Open at the new revision", async () => {
    await runMini(
      Effect.gen(function* () {
        yield* seed;
        yield* seedVerification(VER(4), "Pass");
        yield* seedAcceptance(ACC(4), VER(4));
        yield* refineWorkBySql;
        const deps = yield* makeConsumerDeps();
        const records = yield* runCompletionConsumer(
          [acceptedEvent(4)],
          deps,
          p7Project,
          p7TestPrincipal,
        );
        expect(records).toEqual(["skip:VerificationAcceptanceMismatch"]);
        const workRow = yield* storedWorkRow;
        expect(workRow.lifecycle).toBe("Open");
        expect(workRow.revision).toBe(1);
        expect(yield* countDomainEvents("WorkCompleted")).toBe(0);
      }),
    );
  });
});
