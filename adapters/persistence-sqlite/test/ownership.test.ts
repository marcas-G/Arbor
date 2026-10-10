import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CanonicalResourceRegion,
  ContextEpochNumber,
  makeProjectPolicy,
  makeWorkspacePolicy,
  ProjectId,
  parse,
  type ResourceAddress,
  ResourceBoundaryRevision,
  ResponsibilityRevision,
  Revision,
  responsibilityBound,
  SessionId,
  WorkspaceId,
} from "@arbor/domain";
import {
  DomainEventJournal,
  type DomainEventJournalError,
  EnvironmentRevisionStore,
  OwnershipWriteService,
  ProjectEnvironmentPort,
  ProjectRepository,
  type ResourceOwnershipClaimRecord,
  ResourceOwnershipRepository,
  SessionRepository,
  TransactionPort,
  WorkspaceRepository,
  WorkspaceResourceActivationStore,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClockLive,
  DomainEventJournalLive,
  EnvironmentRevisionStoreLive,
  IdGeneratorLive,
  layer,
  OwnershipWriteServiceLive,
  P1_MIGRATIONS,
  P35_MIGRATIONS,
  ProjectRepositoryLive,
  ResourceOwnershipRepositoryLive,
  runMigrations,
  SessionRepositoryLive,
  TransactionPortLive,
  WorkspaceRepositoryLive,
  WorkspaceResourceActivationStoreLive,
} from "../src/index.js";

const OBSERVED = "rev-observed";
const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const FakeEnvironment: Layer.Layer<ProjectEnvironmentPort> = Layer.succeed(
  ProjectEnvironmentPort,
  {
    resolve: (_projectId, addresses) =>
      Effect.sync(() => ({
        regions: addresses.map(
          (address): CanonicalResourceRegion => ({
            resourceSpaceId:
              address._tag === "DatabaseNamespace" ? "database" : "filesystem",
            normalizedRegion: address,
          }),
        ),
        observedEnvironmentRevision: OBSERVED,
      })),
  },
);

const makeApp = (
  environmentLayer: Layer.Layer<ProjectEnvironmentPort> = FakeEnvironment,
  journalLayer?: Layer.Layer<DomainEventJournal>,
  filename = ":memory:",
) => {
  const base = layer({ filename });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const services = Layer.mergeAll(
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(ResourceOwnershipRepositoryLive, infra),
    Layer.provide(EnvironmentRevisionStoreLive, infra),
    journalLayer ?? Layer.provide(DomainEventJournalLive, infra),
    Layer.provide(ProjectRepositoryLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(WorkspaceResourceActivationStoreLive, infra),
    Layer.provide(SessionRepositoryLive, infra),
    environmentLayer,
  );
  return Layer.mergeAll(
    infra,
    services,
    Layer.provide(OwnershipWriteServiceLive, Layer.mergeAll(services, infra)),
  );
};

const runInApp = <A, E, R>(
  program: Effect.Effect<A, E, R>,
  app: ReturnType<typeof makeApp>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(Effect.provide(program, app) as Effect.Effect<A, E, never>),
  );

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789ab");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789ab");

const definition = {
  purpose: "p",
  ownedResponsibilities: [],
  obligations: [],
  includes: [],
  excludes: [],
  interfaces: [],
};
const boundary = {
  basisResponsibilityRevision: parse(ResponsibilityRevision)(0),
  addresses: [],
};

const seed = Effect.gen(function* () {
  const tx = yield* TransactionPort;
  const projects = yield* ProjectRepository;
  const workspaces = yield* WorkspaceRepository;
  const sessions = yield* SessionRepository;
  yield* tx.transact(
    Effect.gen(function* () {
      yield* projects.create({
        projectId,
        name: "Arbor",
        rootWorkspaceId: workspaceId,
        projectPolicy: makeProjectPolicy(),
        projectPolicyRevision: parse(Revision)(0),
        defaultConfiguration: {},
        environmentRef: "local",
        lifecycle: "Open",
        revision: parse(Revision)(0),
      });
      yield* workspaces.create({
        workspaceId,
        projectId,
        parentWorkspaceId: null,
        name: "root",
        responsibilityDefinition: definition,
        responsibilityRevision: parse(ResponsibilityRevision)(0),
        resourceBoundary: boundary,
        resourceBoundaryRevision: parse(ResourceBoundaryRevision)(0),
        agentBinding: responsibilityBound(workspaceId),
        primarySessionId: sessionId,
        currentWorkId: null,
        workspacePolicy: makeWorkspacePolicy(),
        workspacePolicyRevision: parse(Revision)(0),
        revision: parse(Revision)(0),
        lifecycle: "Active",
      });
      yield* sessions.create({
        sessionId,
        binding: { _tag: "WorkspacePrimary", workspaceId },
        contextEpoch: parse(ContextEpochNumber)(0),
        entries: [],
        checkpoints: [],
        providerContinuation: { state: null },
        modelContinuation: null,
      });
    }),
  );
});

const seedActivationBoundaryAndIntent = Effect.gen(function* () {
  const tx = yield* TransactionPort;
  const workspaces = yield* WorkspaceRepository;
  const activationIntents = yield* WorkspaceResourceActivationStore;
  const pinnedBoundary = {
    ...boundary,
    addresses: [address],
  };
  const resourceBoundaryRevision = parse(ResourceBoundaryRevision)(1);
  yield* tx.transact(
    workspaces.updateResourceBoundaryIfRevision(
      workspaceId,
      parse(Revision)(0),
      pinnedBoundary,
      resourceBoundaryRevision,
      parse(Revision)(1),
    ),
  );
  yield* tx.transact(
    activationIntents.insertPending({
      projectId,
      workspaceId,
      resourceBoundaryRevision,
      status: "Pending",
      createdAt: "t0",
      updatedAt: "t0",
      activatedAt: null,
    }),
  );
});

const claim = (id: string, path: string): ResourceOwnershipClaimRecord => ({
  claimId: id,
  workspaceId,
  region: {
    resourceSpaceId: "filesystem",
    normalizedRegion: { kind: "FileTree", path },
  },
  sourceAddressSnapshot: { _tag: "FileTree", path },
  resourceBoundaryRevision: parse(ResourceBoundaryRevision)(1),
  resolvedAtEnvironmentRevision: OBSERVED,
  createdAt: "t0",
  releasedAt: null,
});

const address: ResourceAddress = { _tag: "FileTree", path: "/repo/a" };

describe("ownership write service", () => {
  it("writes claims and records the observed environment revision", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P1_MIGRATIONS);
      yield* seed;
      const ownership = yield* OwnershipWriteService;
      const revisions = yield* EnvironmentRevisionStore;
      const repository = yield* ResourceOwnershipRepository;
      const tx = yield* TransactionPort;
      const result = yield* ownership.resolveAndWrite(
        projectId,
        [address],
        [claim("c1", "/repo/a")],
      );
      const current = yield* tx.transact(revisions.current(projectId));
      const active = yield* tx.transact(
        repository.listActiveByWorkspace(workspaceId),
      );
      return { result, current, active };
    });
    const { result, current, active } = await Effect.runPromise(
      Effect.provide(program, makeApp()),
    );
    expect(result.regions).toHaveLength(1);
    expect(result.claims).toHaveLength(1);
    expect(Option.isSome(current) && current.value).toBe(OBSERVED);
    expect(active.map((entry) => entry.claimId)).toEqual(["c1"]);
    expect(active[0]?.releasedAt).toBeNull();
  });

  it("rejects overlapping active claims", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P1_MIGRATIONS);
      yield* seed;
      const ownership = yield* OwnershipWriteService;
      yield* ownership.resolveAndWrite(
        projectId,
        [address],
        [claim("c1", "/repo/a")],
      );
      return yield* ownership
        .resolveAndWrite(projectId, [address], [claim("c2", "/repo/a/b")])
        .pipe(Effect.flip);
    });
    const error = await Effect.runPromise(Effect.provide(program, makeApp()));
    expect(error).toMatchObject({
      _tag: "PersistenceConstraintViolation",
      repository: "ResourceOwnershipRepository",
      constraint: "active-resource-overlap",
    });
  });

  it("allows a new claim once the conflicting claim is released", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P1_MIGRATIONS);
      yield* seed;
      const ownership = yield* OwnershipWriteService;
      const repository = yield* ResourceOwnershipRepository;
      const tx = yield* TransactionPort;
      yield* ownership.resolveAndWrite(
        projectId,
        [address],
        [claim("c1", "/repo/a")],
      );
      yield* tx.transact(repository.releaseClaim("c1", "t1"));
      return yield* ownership.resolveAndWrite(
        projectId,
        [address],
        [claim("c2", "/repo/a/b")],
      );
    });
    const result = await Effect.runPromise(Effect.provide(program, makeApp()));
    expect(result.claims.map((entry) => entry.claimId)).toEqual(["c2"]);
  });

  it("fails with ResourceResolutionStale when the revision moved", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P1_MIGRATIONS);
      yield* seed;
      const revisions = yield* EnvironmentRevisionStore;
      const ownership = yield* OwnershipWriteService;
      const tx = yield* TransactionPort;
      yield* tx.transact(revisions.record(projectId, "rev-old"));
      return yield* ownership
        .resolveAndWrite(projectId, [address], [claim("c1", "/repo/a")])
        .pipe(Effect.flip);
    });
    const error = await Effect.runPromise(Effect.provide(program, makeApp()));
    expect(error._tag).toBe("ResourceResolutionStale");
  });

  it("activates the pinned Workspace boundary once and returns AlreadyActive on replay", async () => {
    let resolveCalls = 0;
    const environment = Layer.succeed(ProjectEnvironmentPort, {
      resolve: (_projectId, addresses) =>
        Effect.sync(() => {
          resolveCalls += 1;
          return {
            regions: addresses.map(
              (candidate): CanonicalResourceRegion => ({
                resourceSpaceId: "filesystem",
                normalizedRegion: candidate,
              }),
            ),
            observedEnvironmentRevision: OBSERVED,
          };
        }),
    });
    const program = Effect.gen(function* () {
      yield* runMigrations(P35_MIGRATIONS);
      yield* seed;
      yield* seedActivationBoundaryAndIntent;
      const ownership = yield* OwnershipWriteService;
      const intents = yield* WorkspaceResourceActivationStore;
      const repository = yield* ResourceOwnershipRepository;
      const tx = yield* TransactionPort;
      const sql = yield* SqlClient;
      const first = yield* ownership.activatePendingWorkspaceResource(
        projectId,
        workspaceId,
        parse(ResourceBoundaryRevision)(1),
        [address],
      );
      const replay = yield* ownership.activatePendingWorkspaceResource(
        projectId,
        workspaceId,
        parse(ResourceBoundaryRevision)(1),
        [address],
      );
      const intent = yield* tx.transact(
        intents.find(
          projectId,
          workspaceId,
          parse(ResourceBoundaryRevision)(1),
        ),
      );
      const claims = yield* tx.transact(
        repository.listActiveByWorkspace(workspaceId),
      );
      const events = yield* sql.unsafe<{
        event_type: string;
        event_version: number;
        actor: string;
        aggregate_ref: string;
        payload_json: string;
      }>(
        `SELECT event_type, event_version, actor, aggregate_ref, payload_json
           FROM domain_events
          WHERE event_type = 'WorkspaceResourceActivationChanged'
          ORDER BY sequence`,
      );
      return { first, replay, intent, claims, events };
    });
    const result = await Effect.runPromise(
      Effect.provide(program, makeApp(environment)),
    );
    expect(result.first).toEqual({ _tag: "Activated" });
    expect(result.replay).toEqual({ _tag: "AlreadyActive" });
    expect(resolveCalls).toBe(1);
    expect(Option.isSome(result.intent)).toBe(true);
    if (Option.isSome(result.intent)) {
      expect(result.intent.value).toMatchObject({
        status: "Active",
        resourceBoundaryRevision: 1,
        activatedAt: expect.any(String),
      });
    }
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]).toMatchObject({
      workspaceId,
      region: {
        resourceSpaceId: "filesystem",
        normalizedRegion: address,
      },
      sourceAddressSnapshot: address,
      resourceBoundaryRevision: 1,
      resolvedAtEnvironmentRevision: OBSERVED,
      releasedAt: null,
    });
    expect(result.events).toHaveLength(1);
    expect(
      result.events.map((event) => ({
        ...event,
        payload_json: JSON.parse(event.payload_json) as unknown,
      })),
    ).toEqual([
      {
        event_type: "WorkspaceResourceActivationChanged",
        event_version: 1,
        actor: "system:workspace-resource-activation",
        aggregate_ref: workspaceId,
        payload_json: {
          _tag: "WorkspaceResourceActivationChanged",
          workspaceId,
          resourceBoundaryRevision: 1,
          status: "Active",
        },
      },
    ]);
  });

  it("refuses a caller boundary that differs from the persisted Workspace", async () => {
    let resolveCalls = 0;
    const environment = Layer.succeed(ProjectEnvironmentPort, {
      resolve: (_projectId, addresses) =>
        Effect.sync(() => {
          resolveCalls += 1;
          return {
            regions: addresses.map(
              (candidate): CanonicalResourceRegion => ({
                resourceSpaceId: "filesystem",
                normalizedRegion: candidate,
              }),
            ),
            observedEnvironmentRevision: OBSERVED,
          };
        }),
    });
    const alternate: ResourceAddress = {
      _tag: "FileTree",
      path: "C:/other-boundary",
    };
    const program = Effect.gen(function* () {
      yield* runMigrations(P35_MIGRATIONS);
      yield* seed;
      yield* seedActivationBoundaryAndIntent;
      const ownership = yield* OwnershipWriteService;
      const repository = yield* ResourceOwnershipRepository;
      const tx = yield* TransactionPort;
      const sql = yield* SqlClient;
      const failure = yield* ownership
        .activatePendingWorkspaceResource(
          projectId,
          workspaceId,
          parse(ResourceBoundaryRevision)(1),
          [alternate],
        )
        .pipe(Effect.flip);
      const intent = yield* tx.transact(
        (yield* WorkspaceResourceActivationStore).find(
          projectId,
          workspaceId,
          parse(ResourceBoundaryRevision)(1),
        ),
      );
      const claims = yield* tx.transact(
        repository.listActiveByWorkspace(workspaceId),
      );
      const events = yield* sql.unsafe<{ count: number }>(
        `SELECT COUNT(*) AS count FROM domain_events
          WHERE event_type = 'WorkspaceResourceActivationChanged'`,
      );
      return {
        failure,
        intent,
        claims,
        eventCount: Number(events[0]?.count ?? 0),
      };
    });
    const result = await Effect.runPromise(
      Effect.provide(program, makeApp(environment)),
    );
    expect(result.failure).toMatchObject({
      _tag: "PersistenceCorruption",
      repository: "WorkspaceResourceActivationStore",
    });
    expect(resolveCalls).toBe(0);
    expect(result.claims).toEqual([]);
    expect(result.eventCount).toBe(0);
    expect(Option.isSome(result.intent)).toBe(true);
    if (Option.isSome(result.intent)) {
      expect(result.intent.value.status).toBe("Pending");
    }
  });

  it("serializes competing Pending activations to one claim, CAS, and Active event", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-f21-activation-race-"));
    tempRoots.push(root);
    const databaseFile = join(root, "activation.db");
    const daemonA = makeApp(FakeEnvironment, undefined, databaseFile);
    const daemonB = makeApp(FakeEnvironment, undefined, databaseFile);
    const setup = Effect.gen(function* () {
      yield* runMigrations(P35_MIGRATIONS);
      yield* seed;
      yield* seedActivationBoundaryAndIntent;
    });
    await runInApp(setup, daemonA);

    const activate = Effect.gen(function* () {
      const ownership = yield* OwnershipWriteService;
      return yield* ownership.activatePendingWorkspaceResource(
        projectId,
        workspaceId,
        parse(ResourceBoundaryRevision)(1),
        [address],
      );
    });
    const [resultA, resultB] = await Promise.all([
      runInApp(activate, daemonA),
      runInApp(activate, daemonB),
    ]);
    const results = [resultA, resultB];
    const verify = Effect.gen(function* () {
      const repository = yield* ResourceOwnershipRepository;
      const activationStore = yield* WorkspaceResourceActivationStore;
      const tx = yield* TransactionPort;
      const sql = yield* SqlClient;
      const claims = yield* tx.transact(
        repository.listActiveByWorkspace(workspaceId),
      );
      const intents = yield* tx.transact(
        activationStore.find(
          projectId,
          workspaceId,
          parse(ResourceBoundaryRevision)(1),
        ),
      );
      const events = yield* sql.unsafe<{ count: number }>(
        `SELECT COUNT(*) AS count FROM domain_events
          WHERE event_type = 'WorkspaceResourceActivationChanged'`,
      );
      return {
        claims,
        intents,
        eventCount: Number(events[0]?.count ?? 0),
      };
    });
    const result = await runInApp(verify, daemonA);
    expect(results.map((entry) => entry._tag).sort()).toEqual([
      "Activated",
      "AlreadyActive",
    ]);
    expect(result.claims).toHaveLength(1);
    expect(Option.isSome(result.intents)).toBe(true);
    if (Option.isSome(result.intents)) {
      expect(result.intents.value.status).toBe("Active");
    }
    expect(result.eventCount).toBe(1);
  });

  it("rolls claims and Pending→Active back when the Active event append fails", async () => {
    const journalFailure: DomainEventJournalError = {
      _tag: "PersistenceUnavailable",
      repository: "DomainEventJournal",
      operation: "append",
      retryDisposition: "retryable",
      sourceTag: "InjectedFailure",
      cause: "before event commit",
    };
    const failingJournal = Layer.succeed(DomainEventJournal, {
      append: () => Effect.fail(journalFailure),
      appendReturningIds: () => Effect.fail(journalFailure),
      readAfter: () => Effect.succeed([]),
      lastSequence: () => Effect.succeed(0),
    });
    const program = Effect.gen(function* () {
      yield* runMigrations(P35_MIGRATIONS);
      yield* seed;
      yield* seedActivationBoundaryAndIntent;
      const ownership = yield* OwnershipWriteService;
      const intents = yield* WorkspaceResourceActivationStore;
      const repository = yield* ResourceOwnershipRepository;
      const tx = yield* TransactionPort;
      const sql = yield* SqlClient;
      const failure = yield* ownership
        .activatePendingWorkspaceResource(
          projectId,
          workspaceId,
          parse(ResourceBoundaryRevision)(1),
          [address],
        )
        .pipe(Effect.flip);
      const intent = yield* tx.transact(
        intents.find(
          projectId,
          workspaceId,
          parse(ResourceBoundaryRevision)(1),
        ),
      );
      const claims = yield* tx.transact(
        repository.listActiveByWorkspace(workspaceId),
      );
      const events = yield* sql.unsafe<{ count: number }>(
        `SELECT COUNT(*) AS count FROM domain_events
          WHERE event_type = 'WorkspaceResourceActivationChanged'`,
      );
      return {
        failure,
        intent,
        claims,
        eventCount: Number(events[0]?.count ?? 0),
      };
    });
    const result = await Effect.runPromise(
      Effect.provide(program, makeApp(FakeEnvironment, failingJournal)),
    );
    expect(result.failure).toEqual(journalFailure);
    expect(Option.isSome(result.intent)).toBe(true);
    if (Option.isSome(result.intent)) {
      expect(result.intent.value.status).toBe("Pending");
      expect(result.intent.value.activatedAt).toBeNull();
    }
    expect(result.claims).toEqual([]);
    expect(result.eventCount).toBe(0);
  });
});
