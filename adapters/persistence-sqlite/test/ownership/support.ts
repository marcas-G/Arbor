import { rmSync } from "node:fs";
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
  type DomainEventJournal,
  type EnvironmentResolverError,
  EnvironmentResolverPort,
  ProjectEnvironmentPort,
  ProjectRepository,
  type ResourceOwnershipClaimRecord,
  ResourceOwnershipRepository,
  SessionRepository,
  TransactionPort,
  WorkspaceRepository,
  WorkspaceResourceActivationStore,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterEach } from "vitest";
import {
  ClockLive,
  DomainEventJournalLive,
  EnvironmentRevisionStoreLive,
  IdGeneratorLive,
  layer,
  OwnershipWriteServiceLive,
  ProjectRepositoryLive,
  ResourceOwnershipRepositoryLive,
  SessionRepositoryLive,
  TransactionPortLive,
  WorkspaceRepositoryLive,
  WorkspaceResourceActivationStoreLive,
} from "../../src/index.js";

export const OBSERVED = "rev-observed";
export const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

export const FakeEnvironment: Layer.Layer<ProjectEnvironmentPort> =
  Layer.succeed(ProjectEnvironmentPort, {
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
  });

export const fakeEnvironmentResolver = (
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

export const FakeEnvironmentResolver = fakeEnvironmentResolver(() => true);

export const makeApp = (
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

export const runInApp = <A, E, R>(
  program: Effect.Effect<A, E, R>,
  app: ReturnType<typeof makeApp>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(Effect.provide(program, app) as Effect.Effect<A, E, never>),
  );

export const projectId = parse(ProjectId)(
  "prj_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
export const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
export const sessionId = parse(SessionId)(
  "ses_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
export const childWorkspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789ac",
);
export const childSessionId = parse(SessionId)(
  "ses_018f2b3c-4d5e-7abc-8def-0123456789ac",
);
export const competingWorkspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789ad",
);
export const competingSessionId = parse(SessionId)(
  "ses_018f2b3c-4d5e-7abc-8def-0123456789ad",
);
export const delegatedAddress: ResourceAddress = {
  _tag: "FileTree",
  path: "/repo/child",
};
export const address: ResourceAddress = { _tag: "FileTree", path: "/repo/a" };

export const definition = {
  purpose: "p",
  ownedResponsibilities: [],
  obligations: [],
  includes: [],
  excludes: [],
  interfaces: [],
};
export const boundary = {
  basisResponsibilityRevision: parse(ResponsibilityRevision)(0),
  addresses: [],
};

export const seed = Effect.gen(function* () {
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

export const makeSeedActivationBoundaryAndIntent = (
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

export const seedDelegatedOwnershipIntent = (
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

export const seedCompetingDelegatedScopeOwner = Effect.gen(function* () {
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

export const seedActivationBoundaryAndIntent =
  makeSeedActivationBoundaryAndIntent(address);
export const gitWorktreeAddress: ResourceAddress = {
  _tag: "GitWorktree",
  path: "C:/repo/.git",
};
export const seedGitWorktreeActivationBoundaryAndIntent =
  makeSeedActivationBoundaryAndIntent(gitWorktreeAddress);

export const claim = (
  id: string,
  path: string,
): ResourceOwnershipClaimRecord => ({
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
