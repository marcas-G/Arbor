import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ClockLive,
  CommandStoreLive,
  DeliverableRepositoryLive,
  DomainEventJournalLive,
  EnvironmentRevisionStoreLive,
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
import type { CommandAuthorityFact } from "../packages/application/src/authority.js";
import { makeP1CommandHandlers } from "../packages/application/src/commands/registry.js";
import { makeStartVerificationHandler } from "../packages/application/src/commands/start-verification.js";
import { semanticRequestFingerprint } from "../packages/application/src/fingerprint.js";
import {
  CommandGateway,
  CommandGatewayLive,
  type CommandGatewayService,
  type CommandHandler,
  CommandHandlerRegistry,
  FenceStopCheckInertLive,
  type GatewayEnvelope,
} from "../packages/application/src/gateway.js";
import {
  runVerificationConsumer,
  verificationSpawnIds,
} from "../packages/application/src/verification-consumer.js";
import {
  CommandId,
  type CommandSubmissionContext,
  parse,
  startVerification,
  VerificationId,
  type VerificationMission,
  WorkId,
  type WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  DeliverableRepository,
  type DeliverableRepositoryError,
  EnvironmentRevisionStore,
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
const VER = (suffix: string) =>
  parse(VerificationId)(`ver_00000000-0000-7000-8000-00000000${suffix}`);

/** Handler-valid structured mission (the seeded P6 placeholder has empty
 * criteria and would be InvalidVerificationMission). */
const MISSION: VerificationMission = {
  goal: "verify the completed outcome",
  criteria: [
    { criterionId: "c1", requirement: "tests pass", required: true },
    { criterionId: "c2", requirement: "lint clean", required: false },
  ],
  riskRequirements: [],
};

const seed = Effect.gen(function* () {
  yield* runMigrations(P8_MIGRATIONS);
  yield* p7SeedProject;
  const receipt = yield* p7SeedWork(WORK_1, ASSIGN_CMD);
  expect(receipt.resolution._tag).toBe("Committed");
  // Refine the placeholder mission in place (direct-row precedent from
  // p8-start-verification lifecycle edits) so the consumer's
  // missionSnapshot passes handler validation.
  const sql = yield* SqlClient;
  yield* sql.unsafe(
    "UPDATE works SET verification_mission = ? WHERE work_id = ?",
    [JSON.stringify(MISSION), WORK_1],
  );
});

/** M-4 enriched ExecutionSettled(CompletionClaimed) — plain objects passed
 * straight to the consumer, not journaled (p7-coordinator precedent). */
const settledEvent = (n: number) => ({
  eventType: "ExecutionSettled",
  eventId: `evt-settled-${n}`,
  payload: {
    executionId: `exe_00000000-0000-7000-8000-00000000000${n}`,
    workId: WORK_1,
    workRevision: 0,
    claimRef: `claim-${n}`,
  },
});

const countVerifications = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{ readonly n: number }>(
    "SELECT COUNT(*) AS n FROM verifications",
  );
  return rows[0]?.n ?? 0;
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

const receiptResolution = (commandId: CommandId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ readonly resolution: string }>(
      "SELECT resolution FROM commands WHERE command_id = ?",
      [commandId],
    );
    return rows.length === 1 ? rows[0]!.resolution : null;
  });

const storedFingerprint = (commandId: CommandId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ readonly f: string }>(
      "SELECT semantic_request_fingerprint AS f FROM commands WHERE command_id = ?",
      [commandId],
    );
    return rows.length === 1 ? rows[0]!.f : null;
  });

const openVerification = Effect.gen(function* () {
  const tx = yield* TransactionPort;
  const verifications = yield* VerificationRepository;
  return yield* tx.transact(verifications.findOpenByWorkRevision(WORK_1, 0));
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
    const verifications = yield* VerificationRepository;
    const works = yield* WorkRepository;
    const workspaces = yield* WorkspaceRepository;
    return {
      gateway: wrapGateway === undefined ? gateway : wrapGateway(gateway),
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

/** Mini gateway (p7-coordinator pattern): P1 handlers (seeding only) +
 * exactly one StartVerification handler — any other commandType the
 * consumer submits finds no handler and dies, making the single-command-
 * face assertion mechanical. */
type MiniAppServices =
  | CommandGateway
  | SqlClient
  | TransactionPort
  | WorkspaceRepository
  | WorkRepository
  | VerificationRepository;

const makeMiniApp = (): Layer.Layer<MiniAppServices> => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const repositories = Layer.mergeAll(
    Layer.provide(ProjectRepositoryLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(SessionRepositoryLive, infra),
    Layer.provide(WorkRepositoryLive, infra),
    Layer.provide(DeliverableRepositoryLive, infra),
    Layer.provide(VerificationRepositoryLive, infra),
    Layer.provide(EnvironmentRevisionStoreLive, infra),
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
        const deliverableService = yield* DeliverableRepository;
        const environmentRevisions = yield* EnvironmentRevisionStore;
        const sql = yield* SqlClient;
        const handlers: ReadonlyArray<CommandHandler<unknown, unknown>> = [
          ...makeP1CommandHandlers({ projects, workspaces, sessions, works }),
          makeStartVerificationHandler({
            works,
            verifications,
            environmentRevisions,
            deliverables: {
              ...deliverableService,
              // role→artifactId binding read (p8-start-verification test
              // seam until the port grows an id lister).
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
                        }) as DeliverableRepositoryError,
                    ),
                  ),
            },
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
    // infra alongside the repositories: the registry itself reads SqlClient
    // for the deliverable-artifact seam.
    Layer.mergeAll(repositories, infra),
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

const consume = (
  events: ReadonlyArray<
    | ReturnType<typeof settledEvent>
    | {
        readonly eventType: string;
        readonly payload: unknown;
        readonly eventId: string;
      }
  >,
  wrapGateway?: (gateway: CommandGatewayService) => CommandGatewayService,
) =>
  Effect.gen(function* () {
    const deps = yield* makeConsumerDeps(wrapGateway);
    return yield* runVerificationConsumer(
      events,
      deps,
      p7Project,
      p7TestPrincipal,
    );
  });

describe("p8-consumer-a", () => {
  it("consumes ExecutionSettled(CompletionClaimed): submits StartVerification, verification lands Open with the preallocated verifier id, VerificationStarted journaled", async () => {
    await runMini(
      Effect.gen(function* () {
        yield* seed;
        const records = yield* consume([settledEvent(1)]);
        expect(records).toEqual(["StartVerification"]);
        const ids = verificationSpawnIds(WORK_1, 0, "claim-1");
        const open = yield* openVerification;
        expect(Option.isSome(open)).toBe(true);
        if (Option.isSome(open)) {
          expect(open.value.verificationId).toBe(ids.verificationId);
          expect(open.value.state).toEqual({ status: "Open" });
          expect(open.value.missionSnapshot).toEqual(MISSION);
          expect(open.value.verificationExecutionIds).toEqual([
            ids.verifierExecutionId,
          ]);
          expect(open.value.targetEnvironmentRevision).toBeNull();
        }
        expect(yield* countDomainEvents("VerificationStarted")).toBe(1);
        // Deterministic CommandId: the committed receipt is stored under
        // the re-derivable id — the at-least-once absorption face.
        expect(yield* receiptResolution(ids.commandId)).toBe("Committed");
      }),
    );
  });

  it("replaying the same event is idempotent: AlreadyOpen skip record, no second verification row, no second event", async () => {
    await runMini(
      Effect.gen(function* () {
        yield* seed;
        const event = settledEvent(2);
        const first = yield* consume([event]);
        expect(first).toEqual(["StartVerification"]);
        const replay = yield* consume([event]);
        expect(replay).toEqual([`skipped:VerificationAlreadyOpen:${WORK_1}`]);
        expect(yield* countVerifications).toBe(1);
        expect(yield* countDomainEvents("VerificationStarted")).toBe(1);
      }),
    );
  });

  it("skips without submission when the work revision moved (no replay burn)", async () => {
    await runMini(
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient;
        yield* sql.unsafe("UPDATE works SET revision = 1 WHERE work_id = ?", [
          WORK_1,
        ]);
        const records = yield* consume([settledEvent(3)]);
        expect(records).toEqual([`skipped:RevisionConflict:${WORK_1}`]);
        expect(yield* countVerifications).toBe(0);
        expect(yield* countDomainEvents("VerificationStarted")).toBe(0);
      }),
    );
  });

  it("skips a Cancelled work", async () => {
    await runMini(
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient;
        yield* sql.unsafe(
          "UPDATE works SET lifecycle = 'Cancelled' WHERE work_id = ?",
          [WORK_1],
        );
        const records = yield* consume([settledEvent(4)]);
        expect(records).toEqual([
          `skipped:TerminalLifecycleMutation:${WORK_1}`,
        ]);
        expect(yield* countVerifications).toBe(0);
      }),
    );
  });

  it("skips claimRef-missing and legacy (no workId) events, and ignores unrelated event types", async () => {
    await runMini(
      Effect.gen(function* () {
        yield* seed;
        const legacy = {
          eventType: "ExecutionSettled",
          eventId: "evt-legacy",
          payload: {
            executionId: "exe_00000000-0000-7000-8000-00000000009a",
          },
        };
        const noClaim = {
          eventType: "ExecutionSettled",
          eventId: "evt-noclaim",
          payload: {
            executionId: "exe_00000000-0000-7000-8000-00000000009b",
            workId: WORK_1,
            workRevision: 0,
          },
        };
        const unrelated = {
          eventType: "DeliverableProduced",
          eventId: "evt-unrelated",
          payload: { deliverableId: "del_x" },
        };
        const records = yield* consume([unrelated, legacy, noClaim]);
        expect(records).toEqual([
          `skipped:LegacyExecutionSettled:evt-legacy`,
          `skipped:NotCompletionClaimed:evt-noclaim`,
        ]);
        expect(yield* countVerifications).toBe(0);
      }),
    );
  });

  it("re-spawn branch (02 §1): an Open verification with un-backfilled execution ids yields a needSpawn hint instead of a submission", async () => {
    await runMini(
      Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const verifications = yield* VerificationRepository;
        // Crash window: the verification row committed but the execution
        // backfill never happened (empty verificationExecutionIds).
        const orphanedId = VER("0001");
        yield* tx.transact(
          verifications.insert(
            startVerification({
              verificationId: orphanedId,
              workId: WORK_1,
              targetWorkRevision: 0 as never,
              missionSnapshot: MISSION,
            }),
            p7Project,
            p7RootWorkspace,
          ),
        );
        const ids = verificationSpawnIds(WORK_1, 0, "claim-5");
        const records = yield* consume([settledEvent(5)]);
        expect(records).toEqual([
          `needSpawn:${orphanedId}:${ids.verifierExecutionId}`,
        ]);
        expect(yield* countVerifications).toBe(1);
        expect(yield* countDomainEvents("VerificationStarted")).toBe(0);
      }),
    );
  });

  it("single command face: exactly one StartVerification with StartVerificationAuthority, System origin, deterministic ids, full-payload fingerprint", async () => {
    await runMini(
      Effect.gen(function* () {
        yield* seed;
        const submissions: Array<SubmissionRecord> = [];
        const records = yield* consume([settledEvent(7)], (gateway) =>
          spyGateway(gateway, submissions),
        );
        expect(records).toEqual(["StartVerification"]);
        const ids = verificationSpawnIds(WORK_1, 0, "claim-7");
        const payload = {
          verificationId: ids.verificationId,
          workId: WORK_1,
          observedWorkRevision: 0,
          missionSnapshot: MISSION,
          verifierExecutionId: ids.verifierExecutionId,
          executableMission: false,
        };
        expect(submissions).toEqual([
          {
            commandType: "StartVerification",
            commandId: ids.commandId,
            causationRef: "evt-settled-7",
            contextTag: "System",
            contextCausationRef: "p8-verification-consumer:evt-settled-7",
            authorityTag: "StartVerificationAuthority",
            payload,
          },
        ]);
        // Same command the governance path uses: this registry knows
        // exactly one StartVerification handler and the receipt committed
        // through it — a wrong authority would have been
        // TerminalRejected(AuthorityDenied) and recorded as a skip.
        expect(yield* receiptResolution(ids.commandId)).toBe("Committed");
        // Fingerprint covers the complete payload (authority fact carried
        // the same fingerprint or the gateway would have rejected).
        expect(yield* storedFingerprint(ids.commandId)).toBe(
          semanticRequestFingerprint({
            commandType: "StartVerification",
            projectId: p7Project,
            actor: p7TestActor,
            schemaVersion: "1",
            payload,
          }),
        );
      }),
    );
  });
});
