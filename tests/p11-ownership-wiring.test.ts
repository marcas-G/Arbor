import { readFileSync } from "node:fs";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { ProjectEnvironmentPortLive } from "../adapters/environment-local/src/index.js";
import {
  ClockTest,
  CommandStoreLive,
  DomainEventJournalLive,
  EnvironmentRevisionStoreLive,
  IdGeneratorLive,
  layer,
  OwnershipWriteServiceLive,
  P11_MIGRATIONS,
  ResourceOwnershipRepositoryLive,
  runMigrations,
  SessionRepositoryLive,
  TransactionPortLive,
  WorkspaceRepositoryLive,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  type CreateChildWorkspacePayload,
  makeCreateChildWorkspaceHandler,
} from "../packages/application/src/commands/create-child-workspace.js";
import {
  type CreateWorktreePayload,
  makeCreateWorktreeHandler,
  makeRetireWorktreeHandler,
  type RetireWorktreePayload,
} from "../packages/application/src/commands/worktree-lifecycle.js";
import {
  CommandGateway,
  CommandGatewayLive,
  type CommandGatewayService,
  type CommandHandler,
  CommandHandlerRegistry,
  FenceStopCheckInertLive,
  semanticRequestFingerprint,
} from "../packages/application/src/index.js";
import {
  activateWorkspaceBoundary,
  enforceRetirePreconditions,
  type ReleaseClaimsInRegionsDependencies,
  type ReleaseShrunkRegionsDependencies,
  releaseClaimsInRegions,
  releaseShrunkRegions,
} from "../packages/application/src/ownership-wiring.js";
import {
  Actor,
  CommandId,
  ContextEpochNumber,
  createWorkspace,
  makeWorkspacePolicy,
  Principal,
  type ProjectId,
  parse,
  type ResourceAddress,
  ResourceBoundaryRevision,
  ResponsibilityRevision,
  Revision,
  responsibilityBound,
  retireWorkspace,
  SessionId,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  type ClockService,
  type IdGeneratorService,
  OwnershipWriteService,
  ProjectEnvironmentPort,
  type ProjectEnvironmentPortService,
  ResourceOwnershipRepository,
  type ResourceOwnershipRepositoryService,
  SessionRepository,
  TransactionPort,
  type TransactionPortService,
  TransactionScope,
  WorkspaceRepository,
  type WorktreeRecord,
  WorktreeStore,
  type WorktreeStoreService,
} from "../packages/ports/src/index.js";

// --- fixed identities -------------------------------------------------------

const PROJECT_A =
  "prj_018f2b3c-4d5e-7abc-8def-0123456789e1" as never as ProjectId;
const WS_A = parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789e1");
const WS_C = parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789e2");
const SES_A = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789e1");
const SES_C = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789e2");
const principal = parse(Principal)("user:operator");
const actor = parse(Actor)("user:operator");
const cmd = (suffix: string) =>
  parse(CommandId)(`cmd_018f2b3c-4d5e-7abc-8def-01234567${suffix}`);

// --- scripted environment (counter-style ProjectEnvironmentPort stand-in) ---
// The real resolver (P11 `04`) observes the anchor counter; the scripted
// fake emulates that: a steady revision plus one-shot overrides so tests
// can move the observed revision between the pre-resolve and the CAS
// re-resolve inside OwnershipWriteService.

const regionOf = (
  address: ResourceAddress,
): { resourceSpaceId: string; normalizedRegion: unknown } => {
  switch (address._tag) {
    case "FileTree":
      return {
        resourceSpaceId: "filesystem",
        normalizedRegion: { kind: "FileTree", path: address.path },
      };
    case "GitWorktree":
      return {
        resourceSpaceId: "filesystem",
        normalizedRegion: { kind: "GitWorktree", path: address.path },
      };
    case "DatabaseNamespace":
      return {
        resourceSpaceId: "database",
        normalizedRegion: {
          kind: "DatabaseNamespace",
          namespace: address.namespace,
        },
      };
    case "ExternalResource":
      return {
        resourceSpaceId: "external",
        normalizedRegion: {
          kind: "ExternalResource",
          address: address.address,
        },
      };
  }
};

interface ScriptedEnvironment
  extends Pick<ProjectEnvironmentPortService, "resolve"> {
  readonly setSteadyRevision: (revision: string) => void;
  readonly enqueue: (...revisions: ReadonlyArray<string>) => void;
  readonly callCount: () => number;
}

const makeScriptedEnvironment = (): ScriptedEnvironment => {
  let steady = "rev-1";
  let calls = 0;
  const queue: string[] = [];
  return {
    resolve: (_projectId, addresses) =>
      Effect.sync(() => {
        calls += 1;
        const observed = queue.length > 0 ? (queue.shift() as string) : steady;
        return {
          regions: addresses.map(regionOf),
          observedEnvironmentRevision: observed,
        };
      }),
    setSteadyRevision: (revision) => {
      steady = revision;
    },
    enqueue: (...revisions) => {
      queue.push(...revisions);
    },
    callCount: () => calls,
  };
};

// --- test-local worktrees DDL (production migration is main-session owned;
// mirrors tests/p11-worktree.test.ts) ---------------------------------------

const WORKTREES_TEST_DDL = `
CREATE TABLE worktrees (
  worktree_id     TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(project_id),
  workspace_id    TEXT NOT NULL REFERENCES workspaces(workspace_id),
  path            TEXT NOT NULL,
  repository_ref  TEXT,
  branch          TEXT,
  state           TEXT NOT NULL CHECK (state IN ('Active','Retired')),
  created_at      TEXT NOT NULL,
  retired_at      TEXT,
  CHECK ((state = 'Active') = (retired_at IS NULL))
);
CREATE INDEX idx_worktrees_workspace ON worktrees(workspace_id);
`;

interface WorktreeRow {
  readonly worktree_id: string;
  readonly project_id: string;
  readonly workspace_id: string;
  readonly path: string;
  readonly repository_ref: string | null;
  readonly branch: string | null;
  readonly state: string;
  readonly created_at: string;
  readonly retired_at: string | null;
}

const toRecord = (row: WorktreeRow): WorktreeRecord => ({
  worktreeId: row.worktree_id,
  projectId: row.project_id as ProjectId,
  workspaceId: row.workspace_id as never,
  address: {
    _tag: "GitWorktree",
    path: row.path,
    ...(row.repository_ref === null
      ? {}
      : { repositoryRef: row.repository_ref }),
    ...(row.branch === null ? {} : { branch: row.branch }),
  },
  state: row.state as "Active" | "Retired",
  createdAt: row.created_at,
  ...(row.retired_at === null ? {} : { retiredAt: row.retired_at }),
});

const WorktreeStoreTestLive: Layer.Layer<WorktreeStore, never, SqlClient> =
  Layer.effect(
    WorktreeStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const selectById = (worktreeId: string) =>
        sql.unsafe<WorktreeRow>(
          "SELECT * FROM worktrees WHERE worktree_id = ?",
          [worktreeId],
        );
      const service = {
        insert: (record: WorktreeRecord) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            yield* sql.unsafe(
              "INSERT INTO worktrees (worktree_id, project_id, workspace_id, path, repository_ref, branch, state, created_at, retired_at) VALUES (?,?,?,?,?,?,?,?,NULL)",
              [
                record.worktreeId,
                record.projectId,
                record.workspaceId,
                record.address.path,
                record.address.repositoryRef ?? null,
                record.address.branch ?? null,
                record.state,
                record.createdAt,
              ],
            );
          }),
        findById: (worktreeId: string) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const rows = yield* selectById(worktreeId);
            return rows.length === 0
              ? Option.none()
              : Option.some(toRecord(rows[0] as WorktreeRow));
          }),
        findByWorkspace: (workspaceId: WorkspaceId) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const rows = yield* sql.unsafe<WorktreeRow>(
              "SELECT * FROM worktrees WHERE workspace_id = ? ORDER BY worktree_id",
              [workspaceId],
            );
            return rows.map(toRecord);
          }),
        retireIfActive: (worktreeId: string, retiredAt: string) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            yield* sql.unsafe(
              "UPDATE worktrees SET state = 'Retired', retired_at = ? WHERE worktree_id = ? AND state = 'Active'",
              [retiredAt, worktreeId],
            );
            const rows = yield* selectById(worktreeId);
            if (rows.length === 0) {
              return Option.none();
            }
            const row = rows[0] as WorktreeRow;
            return row.state === "Retired"
              ? Option.some(toRecord(row))
              : Option.none();
          }),
      };
      return WorktreeStore.of(service as unknown as WorktreeStoreService);
    }),
  );

// --- app assembly -----------------------------------------------------------

const makeRegistry = (): Layer.Layer<
  CommandHandlerRegistry,
  never,
  | WorktreeStore
  | WorkspaceRepository
  | SessionRepository
  | ProjectEnvironmentPort
  | ResourceOwnershipRepository
> =>
  Layer.effect(
    CommandHandlerRegistry,
    Effect.gen(function* () {
      const worktrees = yield* WorktreeStore;
      const workspaces = yield* WorkspaceRepository;
      const sessions = yield* SessionRepository;
      const environment = yield* ProjectEnvironmentPort;
      const ownership = yield* ResourceOwnershipRepository;
      const handlers: ReadonlyArray<CommandHandler<unknown, unknown>> = [
        makeCreateChildWorkspaceHandler({
          workspaces,
          sessions,
        }) as unknown as CommandHandler<unknown, unknown>,
        makeCreateWorktreeHandler({
          worktrees,
          workspaces,
        }) as unknown as CommandHandler<unknown, unknown>,
        makeRetireWorktreeHandler({
          worktrees,
          environment,
          ownership,
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

type AppEnv =
  | CommandGateway
  | SqlClient
  | TransactionPort
  | OwnershipWriteService
  | ProjectEnvironmentPort
  | ResourceOwnershipRepository;

const makeApp = (
  environmentLayer: Layer.Layer<ProjectEnvironmentPort> = ProjectEnvironmentPortLive,
): Layer.Layer<AppEnv> => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockTest("t"), IdGeneratorLive);
  const tx = Layer.provide(TransactionPortLive, base);
  const stores = Layer.mergeAll(
    tx,
    Layer.provide(ResourceOwnershipRepositoryLive, infra),
    Layer.provide(EnvironmentRevisionStoreLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(SessionRepositoryLive, infra),
    Layer.provide(WorktreeStoreTestLive, base),
    environmentLayer,
  );
  const registry = Layer.provide(makeRegistry(), stores);
  const gatewayDeps = Layer.mergeAll(
    infra,
    tx,
    registry,
    Layer.provide(CommandStoreLive, infra),
    Layer.provide(DomainEventJournalLive, infra),
    FenceStopCheckInertLive,
  );
  return Layer.mergeAll(
    gatewayDeps,
    stores,
    Layer.provide(OwnershipWriteServiceLive, stores),
    Layer.provide(CommandGatewayLive, gatewayDeps),
  ) as Layer.Layer<AppEnv>;
};

const run = <A, E>(
  program: Effect.Effect<A, E, AppEnv>,
  environmentLayer?: Layer.Layer<ProjectEnvironmentPort>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(Effect.provide(program, makeApp(environmentLayer))),
  );

// --- seed: sessions -> project -> root workspace (FK-safe) ------------------

const seed = Effect.gen(function* () {
  yield* runMigrations(P11_MIGRATIONS);
  const sql = yield* SqlClient;
  const tx = yield* TransactionPort;
  yield* sql.unsafe(WORKTREES_TEST_DDL, []);
  yield* tx.transact(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,'WorkspacePrimary',?,NULL,0,'t')",
        [SES_A, WS_A],
      );
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,'p',?,'{}',0,'{}','local','Open',0,'t','t')",
        [PROJECT_A, WS_A],
      );
      yield* sql.unsafe(
        "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,'root','{}',1,'{}',1,'{}',?,'{}',0,0,'Active','t','t')",
        [WS_A, PROJECT_A, SES_A],
      );
    }),
  );
});

// --- wiring deps (real services; deterministic ids/clock) -------------------

const makeIds = (): Pick<IdGeneratorService, "generate"> => {
  let counter = 0;
  return {
    generate: <T>(_kind: string) => {
      counter += 1;
      return Effect.succeed(
        `clm_${String(counter).padStart(2, "0")}` as unknown as T,
      );
    },
  };
};

const testClock: Pick<ClockService, "now"> = {
  now: () => Effect.succeed("tr"),
};

const shrinkDeps = (
  environment: Pick<ProjectEnvironmentPortService, "resolve">,
  ownership: Pick<
    ResourceOwnershipRepositoryService,
    "listActiveByWorkspace" | "loadActiveConflicts" | "releaseClaim"
  >,
  tx: Pick<TransactionPortService, "transact">,
): ReleaseShrunkRegionsDependencies => ({
  environment,
  ownership,
  tx,
  clock: testClock,
});

const regionsDeps = (
  ownership: Pick<
    ResourceOwnershipRepositoryService,
    "loadActiveConflicts" | "releaseClaim"
  >,
  tx: Pick<TransactionPortService, "transact">,
): ReleaseClaimsInRegionsDependencies => ({
  ownership,
  tx,
  clock: testClock,
});

// --- command submission -----------------------------------------------------

const childPayload = (
  boundaryAddresses: ReadonlyArray<ResourceAddress>,
): CreateChildWorkspacePayload => ({
  parentWorkspaceId: WS_A,
  workspaceId: WS_C,
  primarySession: {
    sessionId: SES_C,
    contextEpoch: parse(ContextEpochNumber)(0),
  },
  name: "child",
  responsibilityDefinition: {
    purpose: "p",
    ownedResponsibilities: [],
    obligations: [],
    includes: [],
    excludes: [],
    interfaces: [],
  },
  responsibilityRevision: parse(ResponsibilityRevision)(0),
  resourceBoundary: {
    basisResponsibilityRevision: parse(ResponsibilityRevision)(0),
    addresses: boundaryAddresses,
  },
  resourceBoundaryRevision: parse(ResourceBoundaryRevision)(0),
  agentBinding: responsibilityBound(WS_C),
  workspacePolicy: makeWorkspacePolicy(),
  workspacePolicyRevision: parse(Revision)(0),
  revision: parse(Revision)(0),
});

const submitChild = (
  gw: CommandGatewayService,
  args: {
    readonly commandId: CommandId;
    readonly payload: CreateChildWorkspacePayload;
  },
) =>
  gw.execute(
    {
      commandType: "CreateChildWorkspace",
      commandId: args.commandId,
      projectId: PROJECT_A,
      actor,
      issuedAt: "t0",
      payload: args.payload,
    },
    { _tag: "External", principal },
    {
      _tag: "CreateChildWorkspaceAuthority",
      principal,
      commandId: args.commandId,
      semanticRequestFingerprint: semanticRequestFingerprint({
        commandType: "CreateChildWorkspace",
        projectId: PROJECT_A,
        actor,
        schemaVersion: "1",
        payload: args.payload,
      }),
      projectId: PROJECT_A,
      parentWorkspaceId: args.payload.parentWorkspaceId,
    },
  );

const worktreeCreatePayload = (
  overrides: Partial<CreateWorktreePayload> = {},
): CreateWorktreePayload => ({
  worktreeId: "wt_0001",
  projectId: PROJECT_A,
  workspaceId: WS_A,
  address: { _tag: "GitWorktree", path: "/repo/wt-0001" },
  ...overrides,
});

const worktreeRetirePayload = (
  overrides: Partial<RetireWorktreePayload> = {},
): RetireWorktreePayload => ({
  worktreeId: "wt_0001",
  expectedState: "Active",
  ...overrides,
});

type GatewayAuthority = Parameters<CommandGatewayService["execute"]>[2];

const submitWorktree = <P>(
  gw: CommandGatewayService,
  args: {
    readonly commandType: "CreateWorktree" | "RetireWorktree";
    readonly commandId: CommandId;
    readonly payload: P;
  },
) =>
  gw.execute(
    {
      commandType: args.commandType,
      commandId: args.commandId,
      projectId: PROJECT_A,
      actor,
      issuedAt: "t9",
      payload: args.payload,
    },
    { _tag: "External", principal },
    {
      _tag:
        args.commandType === "CreateWorktree"
          ? "CreateWorktreeAuthority"
          : "RetireWorktreeAuthority",
      principal,
      commandId: args.commandId,
      semanticRequestFingerprint: semanticRequestFingerprint({
        commandType: args.commandType,
        projectId: PROJECT_A,
        actor,
        schemaVersion: "1",
        payload: args.payload,
      }),
      projectId: PROJECT_A,
      ...(args.commandType === "CreateWorktree"
        ? {
            targetWorkspaceId: (args.payload as CreateWorktreePayload)
              .workspaceId,
            worktreeId: (args.payload as CreateWorktreePayload).worktreeId,
          }
        : { worktreeId: (args.payload as RetireWorktreePayload).worktreeId }),
    } as GatewayAuthority,
  );

// --- row assertions ---------------------------------------------------------

interface ClaimRow {
  readonly claim_id: string;
  readonly workspace_id: string;
  readonly resource_space_id: string;
  readonly canonical_region: string;
  readonly source_address_snapshot: string;
  readonly resource_boundary_revision: number;
  readonly resolved_at_environment_revision: string;
  readonly released_at: string | null;
}

const claimRows = (sql: SqlClient, workspaceId?: WorkspaceId) =>
  Effect.gen(function* () {
    return workspaceId === undefined
      ? yield* sql.unsafe<ClaimRow>(
          "SELECT * FROM resource_ownership ORDER BY claim_id",
        )
      : yield* sql.unsafe<ClaimRow>(
          "SELECT * FROM resource_ownership WHERE workspace_id = ? ORDER BY claim_id",
          [workspaceId],
        );
  });

const storedRevision = (sql: SqlClient, projectId: ProjectId) =>
  Effect.gen(function* () {
    const rows = yield* sql.unsafe<{ revision: string | null }>(
      "SELECT revision FROM environment_revisions WHERE project_id = ?",
      [projectId],
    );
    return rows[0]?.revision ?? null;
  });

// --- the suite --------------------------------------------------------------

describe("p11-ownership-wiring", () => {
  it("claim call site: CreateChildWorkspace commits, then activateWorkspaceBoundary writes claims anchored at the observed environment revision", async () => {
    const scripted = makeScriptedEnvironment();
    const envLayer = Layer.succeed(ProjectEnvironmentPort, scripted);
    await run(
      Effect.gen(function* () {
        yield* seed;
        const gw = yield* CommandGateway;
        const sql = yield* SqlClient;
        const ownershipWrite = yield* OwnershipWriteService;

        const boundaryAddresses: ReadonlyArray<ResourceAddress> = [
          { _tag: "FileTree", path: "/repo/child" },
          { _tag: "GitWorktree", path: "/repo/child-wt" },
        ];
        const receipt = yield* submitChild(gw, {
          commandId: cmd("0001"),
          payload: childPayload(boundaryAddresses),
        });
        expect(receipt.resolution._tag).toBe("Committed");

        // Post-commit wiring (the `10` call site): the P1 CAS sequence
        // becomes live against the freshly created child boundary.
        const outcome = yield* activateWorkspaceBoundary(
          {
            projectId: PROJECT_A,
            workspaceId: WS_C,
            resourceBoundaryRevision: parse(ResourceBoundaryRevision)(0),
            addresses: boundaryAddresses,
          },
          {
            environment: scripted,
            ownershipWrite,
            clock: testClock,
            ids: makeIds(),
          },
        );
        expect(outcome._tag).toBe("ClaimsWritten");
        if (outcome._tag !== "ClaimsWritten") {
          return;
        }
        expect(outcome.reResolved).toBe(false);
        expect(outcome.claims.map((claim) => claim.claimId)).toEqual([
          "clm_01",
          "clm_02",
        ]);

        const rows = yield* claimRows(sql, WS_C);
        expect(rows).toHaveLength(2);
        const revision = yield* storedRevision(sql, PROJECT_A);
        expect(revision).toBe("rev-1");
        for (const row of rows) {
          expect(row.workspace_id).toBe(WS_C);
          expect(row.released_at).toBeNull();
          expect(row.resource_boundary_revision).toBe(0);
          // ResolvedAtEnvironmentRevision anchoring (CAS column)
          expect(row.resolved_at_environment_revision).toBe(revision);
        }
        expect(JSON.parse(rows[0]?.canonical_region ?? "{}")).toEqual({
          resourceSpaceId: "filesystem",
          normalizedRegion: { kind: "FileTree", path: "/repo/child" },
        });
        expect(JSON.parse(rows[1]?.source_address_snapshot ?? "{}")).toEqual({
          _tag: "GitWorktree",
          path: "/repo/child-wt",
        });
      }),
      envLayer,
    );
  });

  it("ResourceResolutionStale: one bounded re-resolve converges (claims anchored at the re-observed revision)", async () => {
    const scripted = makeScriptedEnvironment();
    const envLayer = Layer.succeed(ProjectEnvironmentPort, scripted);
    await run(
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient;
        const ownershipWrite = yield* OwnershipWriteService;
        // the store holds a moved counter; the environment observation walks
        // past it twice, then re-observes the stored value
        yield* sql.unsafe(
          "INSERT INTO environment_revisions (project_id, revision, updated_at) VALUES (?, 'rev-old', 't')",
          [PROJECT_A],
        );
        scripted.enqueue("s1", "s2", "rev-old", "rev-old");

        const outcome = yield* activateWorkspaceBoundary(
          {
            projectId: PROJECT_A,
            workspaceId: WS_A,
            resourceBoundaryRevision: parse(ResourceBoundaryRevision)(1),
            addresses: [{ _tag: "FileTree", path: "/repo/a" }],
          },
          {
            environment: scripted,
            ownershipWrite,
            clock: testClock,
            ids: makeIds(),
          },
        );
        expect(outcome).toEqual({
          _tag: "ClaimsWritten",
          claims: [
            expect.objectContaining({
              // clm_01 was consumed by the stale first attempt; the
              // re-resolved attempt anchors at the re-observed revision
              claimId: "clm_02",
              resolvedAtEnvironmentRevision: "rev-old",
            }),
          ],
          reResolved: true,
        });
        // pre-resolve + CAS re-resolve per attempt
        expect(scripted.callCount()).toBe(4);
        const rows = yield* claimRows(sql);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.resolved_at_environment_revision).toBe("rev-old");
        expect(yield* storedRevision(sql, PROJECT_A)).toBe("rev-old");
      }),
      envLayer,
    );
  });

  it("ResourceResolutionStale twice: typed abandonment — workspace stays created, claims stay absent", async () => {
    const scripted = makeScriptedEnvironment();
    const envLayer = Layer.succeed(ProjectEnvironmentPort, scripted);
    await run(
      Effect.gen(function* () {
        yield* seed;
        const gw = yield* CommandGateway;
        const sql = yield* SqlClient;
        const ownershipWrite = yield* OwnershipWriteService;
        yield* sql.unsafe(
          "INSERT INTO environment_revisions (project_id, revision, updated_at) VALUES (?, 'rev-old', 't')",
          [PROJECT_A],
        );
        const receipt = yield* submitChild(gw, {
          commandId: cmd("0002"),
          payload: childPayload([{ _tag: "FileTree", path: "/repo/child" }]),
        });
        expect(receipt.resolution._tag).toBe("Committed");

        // never re-observes the stored revision: both attempts stay stale
        scripted.enqueue("s1", "s2", "s3", "s4");
        const outcome = yield* activateWorkspaceBoundary(
          {
            projectId: PROJECT_A,
            workspaceId: WS_C,
            resourceBoundaryRevision: parse(ResourceBoundaryRevision)(0),
            addresses: [{ _tag: "FileTree", path: "/repo/child" }],
          },
          {
            environment: scripted,
            ownershipWrite,
            clock: testClock,
            ids: makeIds(),
          },
        );
        // typed give-up: claims are governance objects, creation is not
        // blocked and the workspace row remains
        expect(outcome).toEqual({
          _tag: "ClaimsAbandonedStale",
          attempts: 2,
          lastObserved: "s4",
          lastCurrent: "rev-old",
        });
        expect(yield* claimRows(sql)).toHaveLength(0);
        const child = yield* sql.unsafe<{ lifecycle: string }>(
          "SELECT lifecycle FROM workspaces WHERE workspace_id = ?",
          [WS_C],
        );
        expect(child[0]?.lifecycle).toBe("Active");
      }),
      envLayer,
    );
  });

  it("release call site (boundary shrink): only the claims overlapping the removed regions are released", async () => {
    const scripted = makeScriptedEnvironment();
    const envLayer = Layer.succeed(ProjectEnvironmentPort, scripted);
    await run(
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient;
        const ownershipWrite = yield* OwnershipWriteService;
        const environment = yield* ProjectEnvironmentPort;
        const ownership = yield* ResourceOwnershipRepository;
        const tx = yield* TransactionPort;

        const outcome = yield* activateWorkspaceBoundary(
          {
            projectId: PROJECT_A,
            workspaceId: WS_A,
            resourceBoundaryRevision: parse(ResourceBoundaryRevision)(1),
            addresses: [
              { _tag: "FileTree", path: "/repo/keep" },
              { _tag: "FileTree", path: "/repo/shrink-me" },
            ],
          },
          {
            environment: scripted,
            ownershipWrite,
            clock: testClock,
            ids: makeIds(),
          },
        );
        expect(outcome._tag).toBe("ClaimsWritten");

        const released = yield* releaseShrunkRegions(
          {
            projectId: PROJECT_A,
            workspaceId: WS_A,
            removedAddresses: [{ _tag: "FileTree", path: "/repo/shrink-me" }],
          },
          shrinkDeps(environment, ownership, tx),
        );
        expect(released).toEqual({ releasedClaimIds: ["clm_02"] });

        const rows = yield* claimRows(sql, WS_A);
        expect(rows).toHaveLength(2);
        const kept = rows.find((row) => row.claim_id === "clm_01");
        const removed = rows.find((row) => row.claim_id === "clm_02");
        expect(kept?.released_at).toBeNull();
        expect(removed?.released_at).toBe("tr");
      }),
      envLayer,
    );
  });

  it("enforceRetirePreconditions (§1.4A enforce-not-bypass): active claims refuse typed pointing at the release paths; clean passes and feeds the frozen domain transition", async () => {
    const scripted = makeScriptedEnvironment();
    const envLayer = Layer.succeed(ProjectEnvironmentPort, scripted);
    await run(
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient;
        const ownershipWrite = yield* OwnershipWriteService;
        const environment = yield* ProjectEnvironmentPort;
        const ownership = yield* ResourceOwnershipRepository;
        const tx = yield* TransactionPort;

        yield* activateWorkspaceBoundary(
          {
            projectId: PROJECT_A,
            workspaceId: WS_A,
            resourceBoundaryRevision: parse(ResourceBoundaryRevision)(1),
            addresses: [{ _tag: "FileTree", path: "/repo/a" }],
          },
          {
            environment: scripted,
            ownershipWrite,
            clock: testClock,
            ids: makeIds(),
          },
        );

        const blocked = yield* enforceRetirePreconditions(WS_A, {
          ownership,
          tx,
        });
        expect(blocked).toEqual({
          _tag: "ActiveOwnershipClaimsExist",
          workspaceId: WS_A,
          claimIds: ["clm_01"],
          releasePaths: ["boundary-shrink", "worktree-retirement"],
        });

        // the application fact feeds the P1/P6 frozen domain precondition
        const workspace = createWorkspace({
          workspaceId: WS_A,
          projectId: PROJECT_A,
          parentWorkspaceId: null,
          name: "root",
          responsibilityDefinition: {
            purpose: "p",
            ownedResponsibilities: [],
            obligations: [],
            includes: [],
            excludes: [],
            interfaces: [],
          },
          responsibilityRevision: parse(ResponsibilityRevision)(1),
          resourceBoundary: {
            basisResponsibilityRevision: parse(ResponsibilityRevision)(1),
            addresses: [],
          },
          resourceBoundaryRevision: parse(ResourceBoundaryRevision)(1),
          agentBinding: responsibilityBound(WS_A),
          primarySessionId: SES_A,
          workspacePolicy: makeWorkspacePolicy(),
          workspacePolicyRevision: parse(Revision)(0),
          revision: parse(Revision)(0),
        });
        const retireInput = (hasClaims: boolean) => ({
          authorized: true,
          expectedRevision: workspace.revision,
          isRoot: false,
          hasActiveMainExecution: false,
          hasOpenWork: false,
          hasActiveChildWorkspace: false,
          hasActiveResourceOwnershipClaim: hasClaims,
          incomingDependencies: [],
        });
        const refused = retireWorkspace(
          workspace,
          retireInput(
            blocked._tag === "ActiveOwnershipClaimsExist" &&
              blocked.claimIds.length > 0,
          ),
        );
        expect(refused.ok).toBe(false);
        if (!refused.ok) {
          expect(refused.error._tag).toBe("RetirePreconditionFailed");
          expect(
            (refused.error as { readonly reason: string }).reason,
          ).toContain("active resource ownership claim");
        }

        // release-first (the shrink path), then the precondition passes and
        // the frozen domain transition retires
        yield* releaseShrunkRegions(
          {
            projectId: PROJECT_A,
            workspaceId: WS_A,
            removedAddresses: [{ _tag: "FileTree", path: "/repo/a" }],
          },
          shrinkDeps(environment, ownership, tx),
        );
        const clean = yield* enforceRetirePreconditions(WS_A, {
          ownership,
          tx,
        });
        expect(clean).toEqual({ _tag: "RetirePreconditionsSatisfied" });
        const retired = retireWorkspace(
          workspace,
          retireInput(clean._tag !== "RetirePreconditionsSatisfied"),
        );
        expect(retired.ok).toBe(true);
        if (retired.ok) {
          expect(retired.value.lifecycle).toBe("Retired");
        }
        expect(yield* claimRows(sql, WS_A)).toHaveLength(1);
      }),
      envLayer,
    );
  });

  it("releaseClaimsInRegions: worktree-region claims released → the P11-008 RetireWorktree precondition passes (non-overlapping claim untouched)", async () => {
    const scripted = makeScriptedEnvironment();
    const envLayer = Layer.succeed(ProjectEnvironmentPort, scripted);
    await run(
      Effect.gen(function* () {
        yield* seed;
        const gw = yield* CommandGateway;
        const sql = yield* SqlClient;
        const ownershipWrite = yield* OwnershipWriteService;
        const environment = yield* ProjectEnvironmentPort;
        const ownership = yield* ResourceOwnershipRepository;
        const tx = yield* TransactionPort;

        const created = yield* submitWorktree(gw, {
          commandType: "CreateWorktree",
          commandId: cmd("0010"),
          payload: worktreeCreatePayload(),
        });
        expect(created.resolution._tag).toBe("Committed");

        // boundary claims: one inside the worktree region, one elsewhere
        yield* activateWorkspaceBoundary(
          {
            projectId: PROJECT_A,
            workspaceId: WS_A,
            resourceBoundaryRevision: parse(ResourceBoundaryRevision)(1),
            addresses: [
              { _tag: "GitWorktree", path: "/repo/wt-0001/sub" },
              { _tag: "FileTree", path: "/elsewhere" },
            ],
          },
          {
            environment: scripted,
            ownershipWrite,
            clock: testClock,
            ids: makeIds(),
          },
        );

        // P11-008 handler: retirement refused while claims are active
        const blocked = yield* submitWorktree(gw, {
          commandType: "RetireWorktree",
          commandId: cmd("0011"),
          payload: worktreeRetirePayload(),
        });
        expect(blocked.resolution._tag).toBe("TerminalRejected");
        if (blocked.resolution._tag === "TerminalRejected") {
          expect(
            (blocked.resolution.error as { readonly _tag: string })._tag,
          ).toBe("ActiveClaimsExist");
        }

        // the operator release face: release active claims in the worktree
        // regions (resolved canonical regions, not raw paths)
        const resolved = yield* environment.resolve(PROJECT_A, [
          { _tag: "GitWorktree", path: "/repo/wt-0001" },
        ]);
        const released = yield* releaseClaimsInRegions(
          resolved.regions,
          regionsDeps(ownership, tx),
        );
        expect(released).toEqual({ releasedClaimIds: ["clm_01"] });

        const rows = yield* claimRows(sql, WS_A);
        expect(rows.find((row) => row.claim_id === "clm_01")?.released_at).toBe(
          "tr",
        );
        expect(
          rows.find((row) => row.claim_id === "clm_02")?.released_at,
        ).toBeNull();

        // retirement now commits
        const retired = yield* submitWorktree(gw, {
          commandType: "RetireWorktree",
          commandId: cmd("0012"),
          payload: worktreeRetirePayload(),
        });
        expect(retired.resolution._tag).toBe("Committed");
        const worktreeRow = yield* sql.unsafe<{ state: string }>(
          "SELECT state FROM worktrees WHERE worktree_id = ?",
          ["wt_0001"],
        );
        expect(worktreeRow[0]?.state).toBe("Retired");
      }),
      envLayer,
    );
  });

  it("scope fence (P11 `10` §2 verbatim OUT): the wiring source carries none of the fenced vocabulary", () => {
    const source = readFileSync(
      "packages/application/src/ownership-wiring.ts",
      "utf8",
    );
    expect(source).not.toMatch(/\blease\b/i);
    expect(source).not.toMatch(/\bttl\b/i);
    expect(source).not.toMatch(/preempt/i);
    expect(source).not.toMatch(/multi[-\s]owner/i);
    expect(source).not.toMatch(/distributed[-\s]lock/i);
    expect(source).not.toMatch(/arbitrat/i);
  });
});
