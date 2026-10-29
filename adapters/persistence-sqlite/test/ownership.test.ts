import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Actor,
  type CanonicalResourceRegion,
  CommandId,
  ContextEpochNumber,
  EnvironmentFingerprint,
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
  type EnvironmentResolverError,
  EnvironmentResolverPort,
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

const fakeEnvironmentResolver = (
  exists: (address: ResourceAddress) => boolean,
) =>
  Layer.effect(
    EnvironmentResolverPort,
    Effect.gen(function* () {
      const environment = yield* ProjectEnvironmentPort;
      const digest = "0".repeat(64);
      return EnvironmentResolverPort.of({
        observe: (targetProjectId, addresses) =>
          Effect.mapError(
            Effect.map(
              environment.resolve(targetProjectId, addresses),
              (resolved) => ({
                projectId: targetProjectId,
                observedRevision: resolved.observedEnvironmentRevision,
                fingerprint: EnvironmentFingerprint.of(digest),
                snapshotBlobRef: `blob:${digest}` as never,
                changedRegions: resolved.regions,
                entries: resolved.regions.map((region, index) => {
                  const address = addresses[index];
                  if (address === undefined) {
                    throw new Error("fake resolver lost an input address");
                  }
                  const isAvailable = exists(address);
                  return {
                    address,
                    resolved: region,
                    probe:
                      address._tag === "GitWorktree"
                        ? {
                            kind: "GitWorktree" as const,
                            exists: isAvailable,
                            ...(isAvailable ? { head: "HEAD" } : {}),
                            dirty: false,
                          }
                        : {
                            kind: "FileTree" as const,
                            exists: isAvailable,
                            ...(isAvailable ? { mtime: "t0" } : {}),
                          },
                  };
                }),
              }),
            ),
            (cause): EnvironmentResolverError => ({
              _tag: "ProbeFailed",
              cause,
            }),
          ),
      });
    }),
  );

const FakeEnvironmentResolver = fakeEnvironmentResolver(() => true);

const makeApp = (
  environmentLayer: Layer.Layer<ProjectEnvironmentPort> = FakeEnvironment,
  journalLayer?: Layer.Layer<DomainEventJournal>,
  filename = ":memory:",
  resolverLayer: Layer.Layer<
    EnvironmentResolverPort,
    never,
    ProjectEnvironmentPort
  > | null = FakeEnvironmentResolver,
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
    ...(resolverLayer === null
      ? []
      : [Layer.provide(resolverLayer, environmentLayer)]),
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
const childWorkspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789ac",
);
const childSessionId = parse(SessionId)(
  "ses_018f2b3c-4d5e-7abc-8def-0123456789ac",
);
const competingWorkspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789ad",
);
const competingSessionId = parse(SessionId)(
  "ses_018f2b3c-4d5e-7abc-8def-0123456789ad",
);
const delegatedAddress: ResourceAddress = {
  _tag: "FileTree",
  path: "/repo/child",
};
const address: ResourceAddress = { _tag: "FileTree", path: "/repo/a" };

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
  const sql = yield* SqlClient;
  yield* sql.unsafe(
    `ALTER TABLE projects ADD COLUMN resource_source_json TEXT NOT NULL DEFAULT '{"_tag":"LegacyUnknown"}' CHECK (json_valid(resource_source_json))`,
  );
  const ownershipColumns = yield* sql.unsafe<{ name: string }>(
    "PRAGMA table_info(resource_ownership)",
  );
  const existingOwnershipColumns = new Set(
    ownershipColumns.map((column) => column.name),
  );
  for (const [name, declaration] of [
    [
      "exclusions_json",
      "TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(exclusions_json))",
    ],
    ["delegating_workspace_id", "TEXT REFERENCES workspaces(workspace_id)"],
    ["delegation_source_id", "TEXT"],
    [
      "claim_revision",
      "INTEGER NOT NULL DEFAULT 0 CHECK (claim_revision >= 0)",
    ],
  ] as const) {
    if (!existingOwnershipColumns.has(name)) {
      yield* sql.unsafe(
        `ALTER TABLE resource_ownership ADD COLUMN ${name} ${declaration}`,
      );
    }
  }
  yield* sql.unsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS resource_ownership_delegation_source_unique
       ON resource_ownership(delegation_source_id)
       WHERE delegation_source_id IS NOT NULL`,
  );
  const activationTables = yield* sql.unsafe<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_resource_activation_intents'",
  );
  if (activationTables.length > 0) {
    const activationColumns = yield* sql.unsafe<{ name: string }>(
      "PRAGMA table_info(workspace_resource_activation_intents)",
    );
    const existingActivationColumns = new Set(
      activationColumns.map((column) => column.name),
    );
    for (const [name, declaration] of [
      ["parent_workspace_id", "TEXT REFERENCES workspaces(workspace_id)"],
      ["delegation_source_id", "TEXT"],
      [
        "delegation_json",
        "TEXT CHECK (delegation_json IS NULL OR json_valid(delegation_json))",
      ],
      ["expected_parent_workspace_revision", "INTEGER"],
      ["expected_child_workspace_revision", "INTEGER"],
      ["expected_parent_boundary_revision", "INTEGER"],
      ["expected_parent_ownership_revision", "INTEGER"],
      ["expected_child_ownership_revision", "INTEGER"],
    ] as const) {
      if (!existingActivationColumns.has(name)) {
        yield* sql.unsafe(
          `ALTER TABLE workspace_resource_activation_intents ADD COLUMN ${name} ${declaration}`,
        );
      }
    }
    yield* sql.unsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS workspace_resource_activation_delegation_source_unique
         ON workspace_resource_activation_intents(delegation_source_id)
         WHERE delegation_source_id IS NOT NULL`,
    );
  }
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
        resourceSource: { _tag: "ConversationOnly" },
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

const makeSeedActivationBoundaryAndIntent = (
  resourceAddress: ResourceAddress,
) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const workspaces = yield* WorkspaceRepository;
    const activationIntents = yield* WorkspaceResourceActivationStore;
    const pinnedBoundary = {
      ...boundary,
      addresses: [resourceAddress],
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

const seedDelegatedOwnershipIntent = (
  sourceAddress: ResourceAddress = delegatedAddress,
) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const workspaces = yield* WorkspaceRepository;
    const sessions = yield* SessionRepository;
    const ownership = yield* ResourceOwnershipRepository;
    const activations = yield* WorkspaceResourceActivationStore;
    const parentBoundaryRevision = parse(ResourceBoundaryRevision)(1);
    const childBoundaryRevision = parse(ResourceBoundaryRevision)(1);
    const sourceId = "formation:proposal-s3-1:1";
    yield* tx.transact(
      Effect.gen(function* () {
        yield* workspaces.updateResourceBoundaryIfRevision(
          workspaceId,
          parse(Revision)(0),
          { ...boundary, addresses: [sourceAddress] },
          parentBoundaryRevision,
          parse(Revision)(1),
        );
        yield* workspaces.create({
          workspaceId: childWorkspaceId,
          projectId,
          parentWorkspaceId: workspaceId,
          name: "child",
          responsibilityDefinition: definition,
          responsibilityRevision: parse(ResponsibilityRevision)(0),
          resourceBoundary: { ...boundary, addresses: [sourceAddress] },
          resourceBoundaryRevision: childBoundaryRevision,
          agentBinding: responsibilityBound(childWorkspaceId),
          primarySessionId: childSessionId,
          currentWorkId: null,
          workspacePolicy: makeWorkspacePolicy(),
          workspacePolicyRevision: parse(Revision)(0),
          revision: parse(Revision)(0),
          lifecycle: "Active",
        });
        yield* sessions.create({
          sessionId: childSessionId,
          binding: { _tag: "WorkspacePrimary", workspaceId: childWorkspaceId },
          contextEpoch: parse(ContextEpochNumber)(0),
          entries: [],
          checkpoints: [],
          providerContinuation: { state: null },
          modelContinuation: null,
        });
        yield* ownership.insertClaim({
          ...(sourceAddress._tag === "ExternalResource"
            ? {
                ...claim("parent-claim", "/repo"),
                region: {
                  resourceSpaceId: "filesystem",
                  normalizedRegion: sourceAddress,
                },
                sourceAddressSnapshot: sourceAddress,
                createdAt: "2026-01-01T00:00:00.000Z",
              }
            : claim("parent-claim", "/repo")),
          resourceBoundaryRevision: parentBoundaryRevision,
          claimRevision: 0,
          exclusions: [],
        });
        yield* activations.insertPending({
          projectId,
          workspaceId: childWorkspaceId,
          resourceBoundaryRevision: childBoundaryRevision,
          status: "Pending",
          createdAt: "t0",
          updatedAt: "t0",
          activatedAt: null,
          delegation: {
            delegationSourceId: sourceId,
            formationProposalId: "proposal-s3-1",
            formationProposalRevision: 1,
            addresses: [sourceAddress],
            approvedBy: parse(Actor)("user:gaolei"),
            causedByCommandId: parse(CommandId)(
              "cmd_018f2b3c-4d5e-7abc-8def-0123456789ac",
            ),
            parentWorkspaceId: workspaceId,
            expectedParentWorkspaceRevision: parse(Revision)(1),
            expectedChildWorkspaceRevision: parse(Revision)(0),
            expectedParentBoundaryRevision: parentBoundaryRevision,
            expectedParentOwnershipRevision: 0,
            expectedChildOwnershipRevision: 0,
          },
        });
      }),
    );
  });

const seedCompetingDelegatedScopeOwner = Effect.gen(function* () {
  const tx = yield* TransactionPort;
  const workspaces = yield* WorkspaceRepository;
  const sessions = yield* SessionRepository;
  const ownership = yield* ResourceOwnershipRepository;
  yield* tx.transact(
    Effect.gen(function* () {
      yield* workspaces.create({
        workspaceId: competingWorkspaceId,
        projectId,
        parentWorkspaceId: workspaceId,
        name: "competing",
        responsibilityDefinition: definition,
        responsibilityRevision: parse(ResponsibilityRevision)(0),
        resourceBoundary: { ...boundary, addresses: [delegatedAddress] },
        resourceBoundaryRevision: parse(ResourceBoundaryRevision)(1),
        agentBinding: responsibilityBound(competingWorkspaceId),
        primarySessionId: competingSessionId,
        currentWorkId: null,
        workspacePolicy: makeWorkspacePolicy(),
        workspacePolicyRevision: parse(Revision)(0),
        revision: parse(Revision)(0),
        lifecycle: "Active",
      });
      yield* sessions.create({
        sessionId: competingSessionId,
        binding: {
          _tag: "WorkspacePrimary",
          workspaceId: competingWorkspaceId,
        },
        contextEpoch: parse(ContextEpochNumber)(0),
        entries: [],
        checkpoints: [],
        providerContinuation: { state: null },
        modelContinuation: null,
      });
      yield* ownership.insertClaim({
        ...claim("competing-claim", "/repo/child"),
        workspaceId: competingWorkspaceId,
        sourceAddressSnapshot: delegatedAddress,
        resourceBoundaryRevision: parse(ResourceBoundaryRevision)(1),
        claimRevision: 0,
        exclusions: [],
      });
    }),
  );
});

const seedActivationBoundaryAndIntent =
  makeSeedActivationBoundaryAndIntent(address);
const gitWorktreeAddress: ResourceAddress = {
  _tag: "GitWorktree",
  path: "C:/repo/.git",
};
const seedGitWorktreeActivationBoundaryAndIntent =
  makeSeedActivationBoundaryAndIntent(gitWorktreeAddress);

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
      const revisions = yield* EnvironmentRevisionStore;
      const sql = yield* SqlClient;
      const anchorBefore = yield* tx.transact(revisions.current(projectId));
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
      const anchorAfter = yield* tx.transact(revisions.current(projectId));
      const events = yield* sql.unsafe<{ count: number }>(
        `SELECT COUNT(*) AS count FROM domain_events
          WHERE event_type = 'WorkspaceResourceActivationChanged'`,
      );
      return {
        failure,
        intent,
        claims,
        anchorBefore,
        anchorAfter,
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
    expect(Option.isNone(result.anchorBefore)).toBe(true);
    expect(Option.isNone(result.anchorAfter)).toBe(true);
    expect(result.eventCount).toBe(0);
    expect(Option.isSome(result.intent)).toBe(true);
    if (Option.isSome(result.intent)) {
      expect(result.intent.value.status).toBe("Pending");
    }
  });

  it("fails closed when activation has no full resource-availability resolver", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P35_MIGRATIONS);
      yield* seed;
      yield* seedActivationBoundaryAndIntent;
      const ownership = yield* OwnershipWriteService;
      const repository = yield* ResourceOwnershipRepository;
      const tx = yield* TransactionPort;
      const intents = yield* WorkspaceResourceActivationStore;
      const failure = yield* ownership
        .activatePendingWorkspaceResource(
          projectId,
          workspaceId,
          parse(ResourceBoundaryRevision)(1),
          [address],
        )
        .pipe(Effect.flip);
      return {
        failure,
        claims: yield* tx.transact(
          repository.listActiveByWorkspace(workspaceId),
        ),
        intent: yield* tx.transact(
          intents.find(
            projectId,
            workspaceId,
            parse(ResourceBoundaryRevision)(1),
          ),
        ),
      };
    });
    const result = await Effect.runPromise(
      Effect.provide(
        program,
        makeApp(FakeEnvironment, undefined, ":memory:", null),
      ),
    );
    expect(result.failure).toMatchObject({ _tag: "EnvironmentError" });
    expect(result.claims).toEqual([]);
    expect(Option.isSome(result.intent)).toBe(true);
    if (Option.isSome(result.intent)) {
      expect(result.intent.value.status).toBe("Pending");
    }
  });

  it("fails closed when a GitWorktree probe reports exists:false", async () => {
    const missingGitWorktreeResolver = fakeEnvironmentResolver(
      (candidate) => candidate._tag !== "GitWorktree",
    );
    const program = Effect.gen(function* () {
      yield* runMigrations(P35_MIGRATIONS);
      yield* seed;
      yield* seedGitWorktreeActivationBoundaryAndIntent;
      const ownership = yield* OwnershipWriteService;
      const repository = yield* ResourceOwnershipRepository;
      const tx = yield* TransactionPort;
      const intents = yield* WorkspaceResourceActivationStore;
      const failure = yield* ownership
        .activatePendingWorkspaceResource(
          projectId,
          workspaceId,
          parse(ResourceBoundaryRevision)(1),
          [gitWorktreeAddress],
        )
        .pipe(Effect.flip);
      return {
        failure,
        claims: yield* tx.transact(
          repository.listActiveByWorkspace(workspaceId),
        ),
        intent: yield* tx.transact(
          intents.find(
            projectId,
            workspaceId,
            parse(ResourceBoundaryRevision)(1),
          ),
        ),
      };
    });
    const result = await Effect.runPromise(
      Effect.provide(
        program,
        makeApp(
          FakeEnvironment,
          undefined,
          ":memory:",
          missingGitWorktreeResolver,
        ),
      ),
    );
    expect(result.failure).toMatchObject({ _tag: "EnvironmentError" });
    expect(result.claims).toEqual([]);
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
      readAfterRaw: () => Effect.succeed([]),
      decodeRaw: () =>
        Effect.succeed({
          _tag: "Poison" as const,
          reason: "MalformedEnvelope" as const,
        }),
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
      const revisions = yield* EnvironmentRevisionStore;
      const sql = yield* SqlClient;
      const anchorBefore = yield* tx.transact(revisions.current(projectId));
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
      const anchorAfter = yield* tx.transact(revisions.current(projectId));
      const events = yield* sql.unsafe<{ count: number }>(
        `SELECT COUNT(*) AS count FROM domain_events
          WHERE event_type = 'WorkspaceResourceActivationChanged'`,
      );
      return {
        failure,
        intent,
        claims,
        anchorBefore,
        anchorAfter,
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
    expect(Option.isNone(result.anchorBefore)).toBe(true);
    expect(Option.isNone(result.anchorAfter)).toBe(true);
    expect(result.eventCount).toBe(0);
  });

  it("atomically activates, replays, and serializes one exact delegation", async () => {
    const root = mkdtempSync(join(tmpdir(), "arbor-s3-delegation-race-"));
    tempRoots.push(root);
    const databaseFile = join(root, "delegation.db");
    const daemonA = makeApp(FakeEnvironment, undefined, databaseFile);
    const daemonB = makeApp(FakeEnvironment, undefined, databaseFile);
    const setup = Effect.gen(function* () {
      yield* runMigrations(P35_MIGRATIONS);
      yield* seed;
      yield* seedDelegatedOwnershipIntent();
    });
    await runInApp(setup, daemonA);

    const activation = Effect.gen(function* () {
      const ownership = yield* OwnershipWriteService;
      return yield* ownership.activateDelegatedOwnership({
        projectId,
        childWorkspaceId,
        childResourceBoundaryRevision: parse(ResourceBoundaryRevision)(1),
        delegationSourceId: "formation:proposal-s3-1:1",
      });
    });
    const raced = await Promise.all([
      runInApp(activation, daemonA),
      runInApp(activation, daemonB),
    ]);
    const replay = await runInApp(activation, daemonA);
    const verify = Effect.gen(function* () {
      const repository = yield* ResourceOwnershipRepository;
      const activations = yield* WorkspaceResourceActivationStore;
      const tx = yield* TransactionPort;
      const sql = yield* SqlClient;
      const parentClaims = yield* tx.transact(
        repository.listActiveByWorkspace(workspaceId),
      );
      const childClaims = yield* tx.transact(
        repository.listActiveByWorkspace(childWorkspaceId),
      );
      const intent = yield* tx.transact(
        activations.find(
          projectId,
          childWorkspaceId,
          parse(ResourceBoundaryRevision)(1),
        ),
      );
      const events = yield* sql.unsafe<{
        event_type: string;
        event_version: number;
        actor: string;
        caused_by_command_id: string | null;
        payload_json: string;
      }>(
        `SELECT event_type, event_version, actor, caused_by_command_id,
                payload_json
           FROM domain_events
          WHERE event_type IN ('ResourceOwnershipChanged',
                               'WorkspaceResourceActivationChanged')
          ORDER BY sequence`,
      );
      return { parentClaims, childClaims, intent, events };
    });
    const result = await runInApp(verify, daemonA);
    expect(raced.map((item) => item._tag).sort()).toEqual([
      "Activated",
      "AlreadyActive",
    ]);
    expect(replay._tag).toBe("AlreadyActive");
    expect(result.parentClaims).toHaveLength(1);
    expect(result.parentClaims[0]?.claimRevision).toBe(1);
    expect(
      result.parentClaims[0]?.exclusions?.map((entry) =>
        JSON.stringify(entry.normalizedRegion),
      ),
    ).toEqual(['{"_tag":"FileTree","path":"/repo/child"}']);
    expect(result.childClaims).toHaveLength(1);
    expect(result.childClaims[0]).toMatchObject({
      delegatingWorkspaceId: workspaceId,
      delegationSourceId: "formation:proposal-s3-1:1",
      claimRevision: 1,
      region: {
        resourceSpaceId: "filesystem",
        normalizedRegion: { _tag: "FileTree", path: "/repo/child" },
      },
    });
    expect(Option.isSome(result.intent) && result.intent.value.status).toBe(
      "Active",
    );
    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({
      event_type: "ResourceOwnershipChanged",
      event_version: 2,
      actor: "user:gaolei",
      caused_by_command_id: "cmd_018f2b3c-4d5e-7abc-8def-0123456789ac",
    });
    const eventPayload = JSON.parse(result.events[0]?.payload_json ?? "null");
    expect(eventPayload).toMatchObject({
      _tag: "ResourceOwnershipChanged",
      operation: "Delegated",
      delegation: {
        delegationSourceId: "formation:proposal-s3-1:1",
        parentWorkspaceId: workspaceId,
        childWorkspaceId,
      },
      parentClaim: {
        exclusions: [
          {
            resourceSpaceId: "filesystem",
            normalizedRegion: { _tag: "FileTree", path: "/repo/child" },
          },
        ],
      },
      childClaim: {
        delegationSourceId: "formation:proposal-s3-1:1",
      },
    });
    expect(
      result.events.filter(
        (event) => event.event_type === "ResourceOwnershipChanged",
      ),
    ).toHaveLength(1);
  });

  it("reclaims only the exact delegated Child region and commits ownership and retirement together", async () => {
    const setup = Effect.gen(function* () {
      yield* runMigrations(P35_MIGRATIONS);
      yield* seed;
      yield* seedDelegatedOwnershipIntent();
      const ownership = yield* OwnershipWriteService;
      yield* ownership.activateDelegatedOwnership({
        projectId,
        childWorkspaceId,
        childResourceBoundaryRevision: parse(ResourceBoundaryRevision)(1),
        delegationSourceId: "formation:proposal-s3-1:1",
      });
      return yield* ownership.reclaimDelegatedOwnership({
        projectId,
        childWorkspaceId,
        delegationSourceId: "formation:proposal-s3-1:1",
        expectedParentWorkspaceRevision: 1,
        expectedChildWorkspaceRevision: 0,
        expectedParentBoundaryRevision: parse(ResourceBoundaryRevision)(1),
        expectedChildBoundaryRevision: parse(ResourceBoundaryRevision)(1),
        expectedParentClaimRevision: 1,
        expectedChildClaimRevision: 1,
        actor: parse(Actor)("user:gaolei"),
        causedByCommandId: parse(CommandId)(
          "cmd_018f2b3c-4d5e-7abc-8def-0123456789ac",
        ),
        retireChild: true,
        quiescence: {
          noUnresolvedEffects: true,
          noActiveExecution: true,
          noOpenWork: true,
          noActiveChildren: true,
          noUnresolvedIncomingDependencies: true,
        },
      });
    });
    const result = await runInApp(setup, makeApp());
    expect(result._tag).toBe("Reclaimed");
    expect(result.childRetired).toBe(true);
    expect(result.parentClaim.exclusions).toEqual([]);
    expect(result.parentClaim.claimRevision).toBe(2);
    expect(result.childClaim.releasedAt).not.toBeNull();
  });

  it("rejects reclaim when the resolved environment revision is no longer anchored", async () => {
    const setup = Effect.gen(function* () {
      yield* runMigrations(P35_MIGRATIONS);
      yield* seed;
      yield* seedDelegatedOwnershipIntent();
      const ownership = yield* OwnershipWriteService;
      yield* ownership.activateDelegatedOwnership({
        projectId,
        childWorkspaceId,
        childResourceBoundaryRevision: parse(ResourceBoundaryRevision)(1),
        delegationSourceId: "formation:proposal-s3-1:1",
      });
      const revisions = yield* EnvironmentRevisionStore;
      const tx = yield* TransactionPort;
      yield* tx.transact(revisions.record(projectId, "rev-newer"));
      const reclaimExit = yield* Effect.exit(
        ownership.reclaimDelegatedOwnership({
          projectId,
          childWorkspaceId,
          delegationSourceId: "formation:proposal-s3-1:1",
          expectedParentWorkspaceRevision: 1,
          expectedChildWorkspaceRevision: 0,
          expectedParentBoundaryRevision: parse(ResourceBoundaryRevision)(1),
          expectedChildBoundaryRevision: parse(ResourceBoundaryRevision)(1),
          expectedParentClaimRevision: 1,
          expectedChildClaimRevision: 1,
          actor: parse(Actor)("user:gaolei"),
          causedByCommandId: parse(CommandId)(
            "cmd_018f2b3c-4d5e-7abc-8def-0123456789ac",
          ),
          retireChild: false,
          quiescence: {
            noUnresolvedEffects: true,
            noActiveExecution: true,
            noOpenWork: true,
            noActiveChildren: true,
            noUnresolvedIncomingDependencies: true,
          },
        }),
      );
      return reclaimExit;
    });
    const result = await runInApp(setup, makeApp());
    expect(result._tag).toBe("Failure");
  });

  it("rejects reclaim when canonical open Work appears despite all caller flags", async () => {
    const setup = Effect.gen(function* () {
      yield* runMigrations(P35_MIGRATIONS);
      yield* seed;
      yield* seedDelegatedOwnershipIntent();
      const ownership = yield* OwnershipWriteService;
      yield* ownership.activateDelegatedOwnership({
        projectId,
        childWorkspaceId,
        childResourceBoundaryRevision: parse(ResourceBoundaryRevision)(1),
        delegationSourceId: "formation:proposal-s3-1:1",
      });
      const sql = yield* SqlClient;
      const tx = yield* TransactionPort;
      yield* tx.transact(
        sql.unsafe(
          "INSERT INTO works (work_id, project_id, workspace_id, objective, why, constraints, completion_expectation, verification_mission, provenance, lifecycle, revision, created_at, updated_at) VALUES ('wrk_s3_reclaim_open','prj_018f2b3c-4d5e-7abc-8def-0123456789ab','ws_018f2b3c-4d5e-7abc-8def-0123456789ac','objective','why','[]','done','[]','{}','Open',0,'t0','t0')",
        ),
      );
      return yield* Effect.exit(
        ownership.reclaimDelegatedOwnership({
          projectId,
          childWorkspaceId,
          delegationSourceId: "formation:proposal-s3-1:1",
          expectedParentWorkspaceRevision: 1,
          expectedChildWorkspaceRevision: 0,
          expectedParentBoundaryRevision: parse(ResourceBoundaryRevision)(1),
          expectedChildBoundaryRevision: parse(ResourceBoundaryRevision)(1),
          expectedParentClaimRevision: 1,
          expectedChildClaimRevision: 1,
          actor: parse(Actor)("user:gaolei"),
          causedByCommandId: parse(CommandId)(
            "cmd_018f2b3c-4d5e-7abc-8def-0123456789ac",
          ),
          retireChild: false,
          quiescence: {
            noUnresolvedEffects: true,
            noActiveExecution: true,
            noOpenWork: true,
            noActiveChildren: true,
            noUnresolvedIncomingDependencies: true,
          },
        }),
      );
    });
    expect((await runInApp(setup, makeApp()))._tag).toBe("Failure");
  });

  it.each([
    "active-execution",
    "unresolved-effect",
    "incoming-dependency",
  ] as const)(
    "rejects reclaim for canonical %s despite all caller flags",
    async (scenario) => {
      const setup = Effect.gen(function* () {
        yield* runMigrations(P35_MIGRATIONS);
        yield* seed;
        yield* seedDelegatedOwnershipIntent();
        const ownership = yield* OwnershipWriteService;
        yield* ownership.activateDelegatedOwnership({
          projectId,
          childWorkspaceId,
          childResourceBoundaryRevision: parse(ResourceBoundaryRevision)(1),
          delegationSourceId: "formation:proposal-s3-1:1",
        });
        const sql = yield* SqlClient;
        const tx = yield* TransactionPort;
        if (scenario === "active-execution") {
          yield* tx.transact(
            sql.unsafe(
              "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, episode_kind, episode_ref, episode_revision, parent_execution_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES ('exe_s3_active','prj_018f2b3c-4d5e-7abc-8def-0123456789ab','workspace','ws_018f2b3c-4d5e-7abc-8def-0123456789ac','WorkEpisode','wrk_s3_active',0,NULL,NULL,'ses_018f2b3c-4d5e-7abc-8def-0123456789ac','t0',NULL,NULL,NULL,NULL)",
            ),
          );
        } else if (scenario === "unresolved-effect") {
          yield* tx.transact(
            sql.unsafe(
              "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, episode_kind, episode_ref, episode_revision, parent_execution_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES ('exe_s3_effect','prj_018f2b3c-4d5e-7abc-8def-0123456789ab','workspace','ws_018f2b3c-4d5e-7abc-8def-0123456789ac','WorkEpisode','wrk_s3_effect',0,NULL,NULL,'ses_018f2b3c-4d5e-7abc-8def-0123456789ac','t0',NULL,'Completed','{}','t1')",
            ),
          );
          yield* tx.transact(
            sql.unsafe(
              "INSERT INTO tool_invocations (invocation_id, execution_id, workspace_id, tool_name, tool_version, side_effect_semantics, arguments_json, resolved_regions_json, approval_id, intent_at, settled_at, settlement_kind, settlement_json, result_ref) VALUES ('inv_s3_effect','exe_s3_effect','ws_018f2b3c-4d5e-7abc-8def-0123456789ac','patch','1','NonIdempotent','{}','[{\"resourceSpaceId\":\"filesystem\",\"normalizedRegion\":{\"kind\":\"FileTree\",\"path\":\"/repo/child\"}}]',NULL,'t0',NULL,NULL,NULL,NULL)",
            ),
          );
        } else {
          yield* tx.transact(
            sql.unsafe(
              "INSERT INTO works (work_id, project_id, workspace_id, objective, why, constraints, completion_expectation, verification_mission, provenance, lifecycle, revision, created_at, updated_at) VALUES ('wrk_s3_consumer','prj_018f2b3c-4d5e-7abc-8def-0123456789ab','ws_018f2b3c-4d5e-7abc-8def-0123456789ab','consumer','why','[]','done','[]','{}','Open',0,'t0','t0')",
            ),
          );
          yield* tx.transact(
            sql.unsafe(
              "INSERT INTO dependencies (dependency_id, project_id, consumer_work_id, producer_binding, expected_deliverable, revision, state, satisfied_by_deliverable_id, satisfied_at_dependency_revision, created_at, updated_at) VALUES ('dep_s3_incoming','prj_018f2b3c-4d5e-7abc-8def-0123456789ab','wrk_s3_consumer',?,'{}',0,'Unsatisfied',NULL,NULL,'t0','t0')",
              [
                JSON.stringify({
                  _tag: "WorkspaceBound",
                  workspaceId: childWorkspaceId,
                }),
              ],
            ),
          );
        }
        return yield* Effect.exit(
          ownership.reclaimDelegatedOwnership({
            projectId,
            childWorkspaceId,
            delegationSourceId: "formation:proposal-s3-1:1",
            expectedParentWorkspaceRevision: 1,
            expectedChildWorkspaceRevision: 0,
            expectedParentBoundaryRevision: parse(ResourceBoundaryRevision)(1),
            expectedChildBoundaryRevision: parse(ResourceBoundaryRevision)(1),
            expectedParentClaimRevision: 1,
            expectedChildClaimRevision: 1,
            actor: parse(Actor)("user:gaolei"),
            causedByCommandId: parse(CommandId)(
              "cmd_018f2b3c-4d5e-7abc-8def-0123456789ac",
            ),
            retireChild: false,
            quiescence: {
              noUnresolvedEffects: true,
              noActiveExecution: true,
              noOpenWork: true,
              noActiveChildren: true,
              noUnresolvedIncomingDependencies: true,
            },
          }),
        );
      });
      expect((await runInApp(setup, makeApp()))._tag).toBe("Failure");
    },
  );

  it("transfers and reclaims an equality-only external region without exclusions", async () => {
    const externalAddress: ResourceAddress = {
      _tag: "ExternalResource",
      address: "https://example.test/exact-resource",
    };
    const program = Effect.gen(function* () {
      yield* runMigrations(P35_MIGRATIONS);
      yield* seed;
      yield* seedDelegatedOwnershipIntent(externalAddress);
      const ownership = yield* OwnershipWriteService;
      yield* ownership.activateDelegatedOwnership({
        projectId,
        childWorkspaceId,
        childResourceBoundaryRevision: parse(ResourceBoundaryRevision)(1),
        delegationSourceId: "formation:proposal-s3-1:1",
      });
      const replay = yield* ownership.activateDelegatedOwnership({
        projectId,
        childWorkspaceId,
        childResourceBoundaryRevision: parse(ResourceBoundaryRevision)(1),
        delegationSourceId: "formation:proposal-s3-1:1",
      });
      const repo = yield* ResourceOwnershipRepository;
      const tx = yield* TransactionPort;
      const parentAfterTransfer = yield* tx.transact(
        repo.listActiveByWorkspace(workspaceId),
      );
      const childAfterTransfer = yield* tx.transact(
        repo.listActiveByWorkspace(childWorkspaceId),
      );
      const reclaim = yield* ownership.reclaimDelegatedOwnership({
        projectId,
        childWorkspaceId,
        delegationSourceId: "formation:proposal-s3-1:1",
        expectedParentWorkspaceRevision: 1,
        expectedChildWorkspaceRevision: 0,
        expectedParentBoundaryRevision: parse(ResourceBoundaryRevision)(1),
        expectedChildBoundaryRevision: parse(ResourceBoundaryRevision)(1),
        expectedParentClaimRevision: 1,
        expectedChildClaimRevision: 1,
        actor: parse(Actor)("user:gaolei"),
        causedByCommandId: parse(CommandId)(
          "cmd_018f2b3c-4d5e-7abc-8def-0123456789ac",
        ),
        retireChild: false,
        quiescence: {
          noUnresolvedEffects: true,
          noActiveExecution: true,
          noOpenWork: true,
          noActiveChildren: true,
          noUnresolvedIncomingDependencies: true,
        },
      });
      const parentAfterReclaim = yield* tx.transact(
        repo.listActiveByWorkspace(workspaceId),
      );
      const childAfterReclaim = yield* tx.transact(
        repo.listActiveByWorkspace(childWorkspaceId),
      );
      return {
        parentAfterTransfer,
        childAfterTransfer,
        replay,
        reclaim,
        parentAfterReclaim,
        childAfterReclaim,
      };
    });
    const result = await runInApp(program, makeApp());
    expect(result.parentAfterTransfer).toEqual([]);
    expect(result.childAfterTransfer).toHaveLength(1);
    expect(result.replay._tag).toBe("AlreadyActive");
    expect(result.reclaim._tag).toBe("Reclaimed");
    expect(result.parentAfterReclaim).toHaveLength(1);
    expect(result.parentAfterReclaim[0]?.exclusions).toEqual([]);
    expect(result.childAfterReclaim).toEqual([]);
  });

  it("rolls back the complete delegated post-image when the ownership event fails", async () => {
    const journalFailure: DomainEventJournalError = {
      _tag: "PersistenceUnavailable",
      repository: "DomainEventJournal",
      operation: "append",
      retryDisposition: "retryable",
      sourceTag: "InjectedFailure",
      cause: "before ownership event commit",
    };
    const failingJournal = Layer.succeed(DomainEventJournal, {
      append: () => Effect.fail(journalFailure),
      appendReturningIds: () => Effect.fail(journalFailure),
      readAfter: () => Effect.succeed([]),
      readAfterRaw: () => Effect.succeed([]),
      decodeRaw: () =>
        Effect.succeed({
          _tag: "Poison" as const,
          reason: "MalformedEnvelope" as const,
        }),
      lastSequence: () => Effect.succeed(0),
    });
    const program = Effect.gen(function* () {
      yield* runMigrations(P35_MIGRATIONS);
      yield* seed;
      yield* seedDelegatedOwnershipIntent();
      const ownership = yield* OwnershipWriteService;
      const repository = yield* ResourceOwnershipRepository;
      const activations = yield* WorkspaceResourceActivationStore;
      const tx = yield* TransactionPort;
      const sql = yield* SqlClient;
      const failure = yield* ownership
        .activateDelegatedOwnership({
          projectId,
          childWorkspaceId,
          childResourceBoundaryRevision: parse(ResourceBoundaryRevision)(1),
          delegationSourceId: "formation:proposal-s3-1:1",
        })
        .pipe(Effect.flip);
      const parentClaims = yield* tx.transact(
        repository.listActiveByWorkspace(workspaceId),
      );
      const childClaims = yield* tx.transact(
        repository.listActiveByWorkspace(childWorkspaceId),
      );
      const intent = yield* tx.transact(
        activations.find(
          projectId,
          childWorkspaceId,
          parse(ResourceBoundaryRevision)(1),
        ),
      );
      const events = yield* sql.unsafe<{ count: number }>(
        `SELECT COUNT(*) AS count FROM domain_events
          WHERE event_type IN ('ResourceOwnershipChanged',
                               'WorkspaceResourceActivationChanged')`,
      );
      return {
        failure,
        parentClaims,
        childClaims,
        intent,
        eventCount: Number(events[0]?.count ?? 0),
      };
    });
    const result = await Effect.runPromise(
      Effect.provide(program, makeApp(FakeEnvironment, failingJournal)),
    );
    expect(result.failure).toEqual(journalFailure);
    expect(result.parentClaims).toHaveLength(1);
    expect(result.parentClaims[0]?.claimRevision).toBe(0);
    expect(result.parentClaims[0]?.exclusions).toEqual([]);
    expect(result.childClaims).toEqual([]);
    expect(Option.isSome(result.intent) && result.intent.value.status).toBe(
      "Pending",
    );
    expect(result.eventCount).toBe(0);
  });

  it("rejects a stale Parent Workspace revision before any delegation write", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P35_MIGRATIONS);
      yield* seed;
      yield* seedDelegatedOwnershipIntent();
      const sql = yield* SqlClient;
      yield* sql.unsafe(
        "UPDATE workspaces SET revision = 2 WHERE workspace_id = ?",
        [workspaceId],
      );
      const ownership = yield* OwnershipWriteService;
      const repository = yield* ResourceOwnershipRepository;
      const activations = yield* WorkspaceResourceActivationStore;
      const tx = yield* TransactionPort;
      const result = yield* ownership
        .activateDelegatedOwnership({
          projectId,
          childWorkspaceId,
          childResourceBoundaryRevision: parse(ResourceBoundaryRevision)(1),
          delegationSourceId: "formation:proposal-s3-1:1",
        })
        .pipe(Effect.flip);
      const parentClaims = yield* tx.transact(
        repository.listActiveByWorkspace(workspaceId),
      );
      const childClaims = yield* tx.transact(
        repository.listActiveByWorkspace(childWorkspaceId),
      );
      const intent = yield* tx.transact(
        activations.find(
          projectId,
          childWorkspaceId,
          parse(ResourceBoundaryRevision)(1),
        ),
      );
      return { result, parentClaims, childClaims, intent };
    });
    const result = await runInApp(program, makeApp());
    expect(result.result._tag).toBe("WorkspaceRepositoryRevisionConflict");
    expect(result.parentClaims).toHaveLength(1);
    expect(result.parentClaims[0]?.claimRevision).toBe(0);
    expect(result.parentClaims[0]?.exclusions).toEqual([]);
    expect(result.childClaims).toEqual([]);
    expect(Option.isSome(result.intent) && result.intent.value.status).toBe(
      "Pending",
    );
  });

  it("rejects a globally overlapping effective post-image without partial ownership writes", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P35_MIGRATIONS);
      yield* seed;
      yield* seedDelegatedOwnershipIntent();
      yield* seedCompetingDelegatedScopeOwner;
      const ownership = yield* OwnershipWriteService;
      const repository = yield* ResourceOwnershipRepository;
      const activations = yield* WorkspaceResourceActivationStore;
      const tx = yield* TransactionPort;
      const sql = yield* SqlClient;
      const failure = yield* ownership
        .activateDelegatedOwnership({
          projectId,
          childWorkspaceId,
          childResourceBoundaryRevision: parse(ResourceBoundaryRevision)(1),
          delegationSourceId: "formation:proposal-s3-1:1",
        })
        .pipe(Effect.flip);
      const parentClaims = yield* tx.transact(
        repository.listActiveByWorkspace(workspaceId),
      );
      const childClaims = yield* tx.transact(
        repository.listActiveByWorkspace(childWorkspaceId),
      );
      const competingClaims = yield* tx.transact(
        repository.listActiveByWorkspace(competingWorkspaceId),
      );
      const intent = yield* tx.transact(
        activations.find(
          projectId,
          childWorkspaceId,
          parse(ResourceBoundaryRevision)(1),
        ),
      );
      const events = yield* sql.unsafe<{ count: number }>(
        `SELECT COUNT(*) AS count FROM domain_events
          WHERE event_type = 'ResourceOwnershipChanged'`,
      );
      return {
        failure,
        parentClaims,
        childClaims,
        competingClaims,
        intent,
        eventCount: Number(events[0]?.count ?? 0),
      };
    });
    const result = await runInApp(program, makeApp());
    expect(result.failure).toMatchObject({
      _tag: "PersistenceConstraintViolation",
      repository: "ResourceOwnershipRepository",
      constraint: "effective-resource-ownership-overlap",
    });
    expect(result.parentClaims).toHaveLength(1);
    expect(result.parentClaims[0]?.claimRevision).toBe(0);
    expect(result.parentClaims[0]?.exclusions).toEqual([]);
    expect(result.childClaims).toEqual([]);
    expect(result.competingClaims).toHaveLength(1);
    expect(Option.isSome(result.intent) && result.intent.value.status).toBe(
      "Pending",
    );
    expect(result.eventCount).toBe(0);
  });
});
