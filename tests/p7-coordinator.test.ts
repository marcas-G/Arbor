import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ClockLive,
  CommandStoreLive,
  DeliverableRepositoryLive,
  DependencyRepositoryLive,
  DomainEventJournalLive,
  IdGeneratorLive,
  layer,
  P7_MIGRATIONS,
  ProjectRepositoryLive,
  runMigrations,
  SessionRepositoryLive,
  TransactionPortLive,
  WorkRepositoryLive,
  WorkspaceRepositoryLive,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  makeSatisfyDependencyHandler,
  satisfactionCommandId,
} from "../packages/application/src/commands/satisfy-dependency.js";
import { runDependencyCoordinator } from "../packages/application/src/dependency-coordinator.js";
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
  ArtifactId,
  type ArtifactRole,
  CommandId,
  type CommandSubmissionContext,
  DeliverableId,
  type DeliverableKind,
  DependencyId,
  DependencyRevision,
  declareDependency,
  type ExpectedDeliverable,
  type ProducerBinding,
  type ProjectId,
  parse,
  WorkId,
} from "../packages/domain/dist/index.js";
import {
  DeliverableRepository,
  DependencyRepository,
  ProjectRepository,
  SessionRepository,
  TransactionPort,
  TransactionScope,
  WorkRepository,
  WorkspaceRepository,
} from "../packages/ports/src/index.js";
import {
  p7Project,
  p7SeedProject,
  p7SeedWork,
  p7TestPrincipal,
} from "./support/p7-app.js";

const WORK_C = parse(WorkId)("wrk_00000000-0000-7000-8000-000000000001");
const WORK_P = parse(WorkId)("wrk_00000000-0000-7000-8000-000000000002");
const ASSIGN_CMD_C = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const ASSIGN_CMD_P = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789a2",
);

const DEP = (n: number) =>
  parse(DependencyId)(`dep_00000000-0000-7000-8000-00000000000${n}`);
const DEL = (n: number) =>
  parse(DeliverableId)(`del_00000000-0000-7000-8000-00000000000${n}`);
const ART_1 = parse(ArtifactId)("art_00000000-0000-7000-8000-000000000001");
const REV = (n: number) => parse(DependencyRevision)(n);

const expectedOf = (
  kind: string,
  roles: ReadonlyArray<string>,
): ExpectedDeliverable =>
  ({
    kind: kind as never as DeliverableKind,
    requiredArtifactRoles: roles as never as ReadonlyArray<ArtifactRole>,
  }) as ExpectedDeliverable;

const seed = Effect.gen(function* () {
  yield* runMigrations(P7_MIGRATIONS);
  yield* p7SeedProject;
  const consumer = yield* p7SeedWork(WORK_C, ASSIGN_CMD_C);
  expect(consumer.resolution._tag).toBe("Committed");
  const producer = yield* p7SeedWork(WORK_P, ASSIGN_CMD_P);
  expect(producer.resolution._tag).toBe("Committed");
});

const seedDependency = (
  dependencyId: DependencyId,
  producerBinding: ProducerBinding,
  expected: ExpectedDeliverable,
) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const dependencies = yield* DependencyRepository;
    yield* tx.transact(
      dependencies.insert(
        declareDependency({
          dependencyId,
          consumerWorkId: WORK_C,
          producerBinding,
          revision: REV(0),
          expectedDeliverable: expected,
        }),
        p7Project,
      ),
    );
  });

const seedDeliverable = (
  deliverableId: DeliverableId,
  kind: string,
  roles: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const deliverables = yield* DeliverableRepository;
    yield* tx.transact(
      deliverables.insert(
        {
          deliverableId,
          sourceWorkId: WORK_P,
          sourceWorkRevision: 0,
          kind,
        },
        roles.map((role) => ({ role, artifactId: ART_1 })),
        p7Project,
      ),
    );
  });

const storedDependency = (dependencyId: DependencyId) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const dependencies = yield* DependencyRepository;
    const found = yield* tx.transact(dependencies.findById(dependencyId));
    expect(Option.isSome(found)).toBe(true);
    return Option.isSome(found) ? found.value : undefined;
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

/** Trigger events shaped exactly as the producing commands journal them. */
const producedEvent = (n: number) => ({
  eventType: "DeliverableProduced",
  eventId: `evt-produced-${n}`,
  payload: {
    deliverableId: DEL(n),
    sourceWorkId: WORK_P,
    sourceWorkRevision: 0,
    kind: "report",
    artifactRoles: ["summary"],
  },
});

const declaredEvent = (n: number) => ({
  eventType: "DependencyDeclared",
  eventId: `evt-declared-${n}`,
  payload: {
    dependencyId: DEP(n),
    consumerWorkId: WORK_C,
    producerBinding: { _tag: "AnyProducer" },
    expectedDeliverable: { kind: "report", requiredArtifactRoles: ["summary"] },
    revision: 0,
  },
});

/** Recording proxy: every gateway submission the coordinator makes. */
interface SubmissionRecord {
  readonly commandType: string;
  readonly commandId: string;
  readonly causationRef: string | undefined;
  readonly contextTag: string;
  readonly contextCausationRef: string | undefined;
  readonly authorityTag: string;
  readonly sourceTag: string;
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
      sourceTag:
        authority._tag === "SatisfyDependencyAuthority"
          ? authority.source._tag
          : "",
      payload: envelope.payload,
    });
    return gateway.execute<C, R>(envelope, context, authority);
  },
});

const makeCoordinatorDeps = (
  wrapGateway?: (gateway: CommandGatewayService) => CommandGatewayService,
) =>
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    const tx = yield* TransactionPort;
    const sql = yield* SqlClient;
    const dependencies = yield* DependencyRepository;
    const deliverables = yield* DeliverableRepository;
    const works = yield* WorkRepository;
    return {
      gateway: wrapGateway === undefined ? gateway : wrapGateway(gateway),
      dependencies: {
        listUnsatisfiedByProject: (projectId: ProjectId) =>
          tx.transact(dependencies.listUnsatisfiedByProject(projectId)),
      },
      deliverables: {
        findById: (deliverableId: DeliverableId) =>
          tx.transact(deliverables.findById(deliverableId)),
        listArtifactRoles: (deliverableId: DeliverableId) =>
          tx.transact(deliverables.listArtifactRoles(deliverableId)),
        // Lookup shape not frozen (G5): project-scoped direct SQL here; a
        // scan / index / materialized view is a production wiring choice.
        deliverablesByProject: (projectId: ProjectId) =>
          tx.transact(
            Effect.gen(function* () {
              yield* TransactionScope;
              const rows = yield* sql.unsafe<{
                readonly deliverable_id: string;
                readonly source_work_id: string;
                readonly source_work_revision: number;
                readonly kind: string;
                readonly role: string | null;
              }>(
                "SELECT d.deliverable_id, d.source_work_id, d.source_work_revision, d.kind, a.role FROM deliverables d LEFT JOIN deliverable_artifacts a ON a.deliverable_id = d.deliverable_id WHERE d.project_id = ? ORDER BY d.deliverable_id, a.role",
                [projectId],
              );
              const snapshots = new Map<
                string,
                {
                  deliverableId: DeliverableId;
                  sourceWorkId: WorkId;
                  sourceWorkRevision: number;
                  kind: string;
                  artifactRoles: string[];
                }
              >();
              for (const row of rows) {
                const current = snapshots.get(row.deliverable_id);
                if (current === undefined) {
                  snapshots.set(row.deliverable_id, {
                    deliverableId: row.deliverable_id as DeliverableId,
                    sourceWorkId: row.source_work_id as WorkId,
                    sourceWorkRevision: row.source_work_revision,
                    kind: row.kind,
                    artifactRoles: row.role === null ? [] : [row.role],
                  });
                } else if (row.role !== null) {
                  current.artifactRoles.push(row.role);
                }
              }
              return [...snapshots.values()];
            }),
          ),
      },
      works: {
        findById: (workId: WorkId) => tx.transact(works.findById(workId)),
      },
    };
  });

/** Mini gateway (p7-app assembly, minimal segment): P1 handlers (seeding
 * only) + exactly one satisfaction handler — any commandType the
 * coordinator submits other than SatisfyDependency finds no handler and
 * dies, making the single-command-face assertion mechanical. */
type MiniAppServices =
  | CommandGateway
  | SqlClient
  | TransactionPort
  | DependencyRepository
  | DeliverableRepository
  | WorkRepository;

const makeMiniApp = (): Layer.Layer<MiniAppServices> => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const repositories = Layer.mergeAll(
    Layer.provide(ProjectRepositoryLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(SessionRepositoryLive, infra),
    Layer.provide(WorkRepositoryLive, infra),
    Layer.provide(DependencyRepositoryLive, infra),
    Layer.provide(DeliverableRepositoryLive, infra),
  );
  const registry = Layer.provide(
    Layer.effect(
      CommandHandlerRegistry,
      Effect.gen(function* () {
        const projects = yield* ProjectRepository;
        const workspaces = yield* WorkspaceRepository;
        const sessions = yield* SessionRepository;
        const works = yield* WorkRepository;
        const dependencies = yield* DependencyRepository;
        const deliverables = yield* DeliverableRepository;
        const handlers: ReadonlyArray<CommandHandler<unknown, unknown>> = [
          ...makeP1CommandHandlers({ projects, workspaces, sessions, works }),
          makeSatisfyDependencyHandler({
            dependencies,
            deliverables,
            works,
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

describe("p7-coordinator", () => {
  it("DeliverableProduced primary trigger: AnyProducer match auto-satisfies through SatisfyDependency, transitions the dependency and journals DependencySatisfied", async () => {
    await runMini(
      Effect.gen(function* () {
        yield* seed;
        yield* seedDependency(
          DEP(1),
          { _tag: "AnyProducer" },
          expectedOf("report", ["summary"]),
        );
        yield* seedDeliverable(DEL(1), "report", ["summary"]);
        const deps = yield* makeCoordinatorDeps();
        const executed = yield* runDependencyCoordinator(
          [producedEvent(1)],
          deps,
          p7Project,
          p7TestPrincipal,
        );
        expect(executed).toEqual(["SatisfyDependency"]);
        const stored = yield* storedDependency(DEP(1));
        expect(stored?.state).toBe("Satisfied");
        expect(stored?.satisfiedByDeliverableId).toBe(DEL(1));
        expect(stored?.satisfiedAtDependencyRevision).toBe(0);
        expect(yield* countDomainEvents("DependencySatisfied")).toBe(1);
        // Deterministic CommandId (§2): the committed receipt is stored
        // under the re-derivable id — the at-least-once absorption face.
        expect(
          yield* receiptResolution(
            satisfactionCommandId(DEL(1), DEP(1), REV(0)),
          ),
        ).toBe("Committed");
      }),
    );
  });

  it("replaying the same events is idempotent: dependency stays Satisfied, no second DependencySatisfied event", async () => {
    await runMini(
      Effect.gen(function* () {
        yield* seed;
        yield* seedDependency(
          DEP(2),
          { _tag: "AnyProducer" },
          expectedOf("report", ["summary"]),
        );
        yield* seedDeliverable(DEL(2), "report", ["summary"]);
        const deps = yield* makeCoordinatorDeps();
        const events = [producedEvent(2)];
        const first = yield* runDependencyCoordinator(
          events,
          deps,
          p7Project,
          p7TestPrincipal,
        );
        expect(first).toEqual(["SatisfyDependency"]);
        const replay = yield* runDependencyCoordinator(
          events,
          deps,
          p7Project,
          p7TestPrincipal,
        );
        expect(replay).toEqual([]);
        const stored = yield* storedDependency(DEP(2));
        expect(stored?.state).toBe("Satisfied");
        expect(stored?.satisfiedByDeliverableId).toBe(DEL(2));
        expect(yield* countDomainEvents("DependencySatisfied")).toBe(1);
      }),
    );
  });

  it("matcher negative (kind mismatch): skipped record, no submission, state unchanged — the batch is not interrupted", async () => {
    await runMini(
      Effect.gen(function* () {
        yield* seed;
        yield* seedDependency(
          DEP(3),
          { _tag: "AnyProducer" },
          expectedOf("report", ["summary"]),
        );
        yield* seedDependency(
          DEP(4),
          { _tag: "AnyProducer" },
          expectedOf("diagram", ["summary"]),
        );
        yield* seedDeliverable(DEL(3), "report", ["summary"]);
        const deps = yield* makeCoordinatorDeps();
        const records = yield* runDependencyCoordinator(
          [producedEvent(3)],
          deps,
          p7Project,
          p7TestPrincipal,
        );
        expect(records).toHaveLength(2);
        expect(records).toContain("SatisfyDependency");
        expect(records).toContain(`skipped:DependencyNotSatisfiable:${DEP(4)}`);
        const matched = yield* storedDependency(DEP(3));
        expect(matched?.state).toBe("Satisfied");
        const mismatched = yield* storedDependency(DEP(4));
        expect(mismatched?.state).toBe("Unsatisfied");
        expect(mismatched?.satisfiedByDeliverableId).toBeUndefined();
        expect(yield* countDomainEvents("DependencySatisfied")).toBe(1);
        // Advisory skip means no submission at all for the negative pair.
        expect(
          yield* receiptResolution(
            satisfactionCommandId(DEL(3), DEP(4), REV(0)),
          ),
        ).toBeNull();
      }),
    );
  });

  it("WorkBound producer: a deliverable from a different source Work is skipped", async () => {
    await runMini(
      Effect.gen(function* () {
        yield* seed;
        yield* seedDependency(
          DEP(5),
          { _tag: "WorkBound", workId: WORK_C },
          expectedOf("report", ["summary"]),
        );
        yield* seedDeliverable(DEL(5), "report", ["summary"]);
        const deps = yield* makeCoordinatorDeps();
        const records = yield* runDependencyCoordinator(
          [producedEvent(5)],
          deps,
          p7Project,
          p7TestPrincipal,
        );
        expect(records).toEqual([`skipped:DependencyNotSatisfiable:${DEP(5)}`]);
        const stored = yield* storedDependency(DEP(5));
        expect(stored?.state).toBe("Unsatisfied");
        expect(yield* countDomainEvents("DependencySatisfied")).toBe(0);
      }),
    );
  });

  it("DependencyDeclared re-check: a deliverable produced before the declaration still satisfies the new requirement", async () => {
    await runMini(
      Effect.gen(function* () {
        yield* seed;
        yield* seedDeliverable(DEL(6), "report", ["summary"]);
        yield* seedDependency(
          DEP(6),
          { _tag: "AnyProducer" },
          expectedOf("report", ["summary"]),
        );
        const deps = yield* makeCoordinatorDeps();
        const records = yield* runDependencyCoordinator(
          [declaredEvent(6)],
          deps,
          p7Project,
          p7TestPrincipal,
        );
        expect(records).toEqual(["SatisfyDependency"]);
        const stored = yield* storedDependency(DEP(6));
        expect(stored?.state).toBe("Satisfied");
        expect(stored?.satisfiedByDeliverableId).toBe(DEL(6));
        expect(yield* countDomainEvents("DependencySatisfied")).toBe(1);
        expect(
          yield* receiptResolution(
            satisfactionCommandId(DEL(6), DEP(6), REV(0)),
          ),
        ).toBe("Committed");
      }),
    );
  });

  it("single command face (G6): the coordinator submits exactly one SatisfyDependency with P7Coordinator authority, System origin and the deterministic CommandId", async () => {
    await runMini(
      Effect.gen(function* () {
        yield* seed;
        yield* seedDependency(
          DEP(7),
          { _tag: "AnyProducer" },
          expectedOf("report", ["summary"]),
        );
        yield* seedDeliverable(DEL(7), "report", ["summary"]);
        const submissions: Array<SubmissionRecord> = [];
        const deps = yield* makeCoordinatorDeps((gateway) =>
          spyGateway(gateway, submissions),
        );
        const records = yield* runDependencyCoordinator(
          [producedEvent(7)],
          deps,
          p7Project,
          p7TestPrincipal,
        );
        expect(records).toEqual(["SatisfyDependency"]);
        expect(submissions).toEqual([
          {
            commandType: "SatisfyDependency",
            commandId: satisfactionCommandId(DEL(7), DEP(7), REV(0)),
            causationRef: "evt-produced-7",
            contextTag: "System",
            contextCausationRef: "p7-coordinator:evt-produced-7",
            authorityTag: "SatisfyDependencyAuthority",
            sourceTag: "P7Coordinator",
            payload: {
              dependencyId: DEP(7),
              targetDependencyRevision: 0,
              deliverableId: DEL(7),
            },
          },
        ]);
        // Same command the agent path uses: this registry knows exactly one
        // satisfaction handler, and the receipt committed through it — a
        // wrong authority (e.g. a non-P7Coordinator source) would have been
        // TerminalRejected(AuthorityDenied) and recorded as a skip instead.
        expect(
          yield* receiptResolution(
            satisfactionCommandId(DEL(7), DEP(7), REV(0)),
          ),
        ).toBe("Committed");
        expect(yield* countDomainEvents("DependencySatisfied")).toBe(1);
      }),
    );
  });
});
