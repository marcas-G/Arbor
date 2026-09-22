import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { ProjectEnvironmentPortLive } from "../adapters/environment-local/src/index.js";
import {
  ClockTest,
  CommandStoreLive,
  DomainEventJournalLive,
  IdGeneratorLive,
  layer,
  P11_MIGRATIONS,
  ResourceOwnershipRepositoryLive,
  runMigrations,
  TransactionPortLive,
  WorkspaceRepositoryLive,
} from "../adapters/persistence-sqlite/src/index.js";
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
  type GatewayEnvelope,
  semanticRequestFingerprint,
} from "../packages/application/src/index.js";
import {
  Actor,
  CommandId,
  Principal,
  type ProjectId,
  parse,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  ProjectEnvironmentPort,
  ResourceOwnershipRepository,
  TransactionPort,
  TransactionScope,
  WorkspaceRepository,
  type WorktreeRecord,
  WorktreeStore,
  type WorktreeStoreService,
} from "../packages/ports/src/index.js";

// --- fixed identities ---

const PROJECT_A =
  "prj_018f2b3c-4d5e-7abc-8def-0123456789a1" as never as ProjectId;
const PROJECT_B =
  "prj_018f2b3c-4d5e-7abc-8def-0123456789b1" as never as ProjectId;
const PROJECT_R =
  "prj_018f2b3c-4d5e-7abc-8def-0123456789d1" as never as ProjectId;
const WS_A = parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789a1");
const WS_B = parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789b1");
const WS_R = parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789d1");
const principal = parse(Principal)("user:operator");
const actor = parse(Actor)("user:operator");
const cmd = (suffix: string) =>
  parse(CommandId)(`cmd_018f2b3c-4d5e-7abc-8def-01234567${suffix}`);

// --- test-local worktrees DDL -------------------------------------------
// DDL NOTE (task scope): the production `worktrees` migration is owned by
// the MAIN SESSION (serial migration management, planned migration 10).
// Tests create the table manually after runMigrations(P11_MIGRATIONS).
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

// --- test-local sqlite-backed WorktreeStore (adapter lands with the
// main-session migration) ---

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

// --- app assembly ---

const WorktreeRegistryLive: Layer.Layer<
  CommandHandlerRegistry,
  never,
  | WorktreeStore
  | WorkspaceRepository
  | ProjectEnvironmentPort
  | ResourceOwnershipRepository
> = Layer.effect(
  CommandHandlerRegistry,
  Effect.gen(function* () {
    const worktrees = yield* WorktreeStore;
    const workspaces = yield* WorkspaceRepository;
    const environment = yield* ProjectEnvironmentPort;
    const ownership = yield* ResourceOwnershipRepository;
    const handlers: ReadonlyArray<CommandHandler<unknown, unknown>> = [
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

const makeApp = (): Layer.Layer<
  CommandGateway | SqlClient | TransactionPort
> => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockTest("t"), IdGeneratorLive);
  const registry = Layer.provide(
    WorktreeRegistryLive,
    Layer.mergeAll(
      Layer.provide(WorktreeStoreTestLive, base),
      Layer.provide(WorkspaceRepositoryLive, infra),
      Layer.provide(ResourceOwnershipRepositoryLive, infra),
      ProjectEnvironmentPortLive,
    ),
  );
  const gatewayDeps = Layer.mergeAll(
    infra,
    registry,
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(CommandStoreLive, infra),
    Layer.provide(DomainEventJournalLive, infra),
    FenceStopCheckInertLive,
  );
  return Layer.mergeAll(
    gatewayDeps,
    Layer.provide(CommandGatewayLive, gatewayDeps),
  ) as Layer.Layer<CommandGateway | SqlClient | TransactionPort>;
};

const run = <A, E>(
  program: Effect.Effect<A, E, CommandGateway | SqlClient | TransactionPort>,
): Promise<A> =>
  Effect.runPromise(Effect.scoped(Effect.provide(program, makeApp())));

// --- seed: sessions -> projects -> workspaces (FK-safe), Active + Retired ---

const seed = Effect.gen(function* () {
  yield* runMigrations(P11_MIGRATIONS);
  const sql = yield* SqlClient;
  const tx = yield* TransactionPort;
  yield* sql.unsafe(WORKTREES_TEST_DDL, []);
  yield* tx.transact(
    Effect.gen(function* () {
      const mk = (
        ses: string,
        ws: WorkspaceId,
        prj: ProjectId,
        lifecycle: "Active" | "Retired",
      ) =>
        Effect.gen(function* () {
          yield* sql.unsafe(
            "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,'WorkspacePrimary',?,NULL,0,'t')",
            [ses, ws],
          );
          yield* sql.unsafe(
            "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,'p',?,'{}',0,'{}','local','Open',0,'t','t')",
            [prj, ws],
          );
          yield* sql.unsafe(
            "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,'root','{}',1,'{}',1,'{}',?,'{}',0,0,?,'t','t')",
            [ws, prj, ses, lifecycle],
          );
        });
      yield* mk("ses_a", WS_A, PROJECT_A, "Active");
      yield* mk("ses_b", WS_B, PROJECT_B, "Active");
      yield* mk("ses_r", WS_R, PROJECT_R, "Retired");
    }),
  );
});

/** Active (released_at NULL) ownership claim seeding for §1.4A / CI-3. */
const seedClaim = (
  sql: SqlClient,
  claim: {
    readonly claimId: string;
    readonly workspaceId: WorkspaceId;
    readonly path: string;
    readonly releasedAt: string | null;
  },
) =>
  sql.unsafe(
    "INSERT INTO resource_ownership (claim_id, workspace_id, resource_space_id, canonical_region, source_address_snapshot, resource_boundary_revision, resolved_at_environment_revision, created_at, released_at) VALUES (?,?, 'filesystem', ?, '{\"_tag\":\"GitWorktree\",\"path\":\"/seed\"}', 1, '1', 't', ?)",
    [
      claim.claimId,
      claim.workspaceId,
      JSON.stringify({
        resourceSpaceId: "filesystem",
        normalizedRegion: { kind: "GitWorktree", path: claim.path },
      }),
      claim.releasedAt,
    ],
  );

// --- command submission ---

const createPayload = (
  overrides: Partial<CreateWorktreePayload> = {},
): CreateWorktreePayload => ({
  worktreeId: "wt_0001",
  projectId: PROJECT_A,
  workspaceId: WS_A,
  address: { _tag: "GitWorktree", path: "/repo/wt-0001" },
  ...overrides,
});

const retirePayload = (
  overrides: Partial<RetireWorktreePayload> = {},
): RetireWorktreePayload => ({
  worktreeId: "wt_0001",
  expectedState: "Active",
  ...overrides,
});

const submitCreate = (
  gw: CommandGatewayService,
  args: {
    readonly commandId: CommandId;
    readonly payload: CreateWorktreePayload;
  },
) => {
  const envelope: GatewayEnvelope<CreateWorktreePayload> = {
    commandType: "CreateWorktree",
    commandId: args.commandId,
    projectId: args.payload.projectId,
    actor,
    issuedAt: "t0",
    payload: args.payload,
  };
  return gw.execute(
    envelope,
    { _tag: "External", principal },
    {
      _tag: "CreateWorktreeAuthority",
      principal,
      commandId: args.commandId,
      semanticRequestFingerprint: semanticRequestFingerprint({
        commandType: "CreateWorktree",
        projectId: args.payload.projectId,
        actor,
        schemaVersion: "1",
        payload: args.payload,
      }),
      projectId: args.payload.projectId,
      targetWorkspaceId: args.payload.workspaceId,
      worktreeId: args.payload.worktreeId,
    },
  );
};

const submitRetire = (
  gw: CommandGatewayService,
  args: {
    readonly commandId: CommandId;
    readonly payload: RetireWorktreePayload;
  },
) => {
  const envelope: GatewayEnvelope<RetireWorktreePayload> = {
    commandType: "RetireWorktree",
    commandId: args.commandId,
    projectId: PROJECT_A,
    actor,
    issuedAt: "t9",
    payload: args.payload,
  };
  return gw.execute(
    envelope,
    { _tag: "External", principal },
    {
      _tag: "RetireWorktreeAuthority",
      principal,
      commandId: args.commandId,
      semanticRequestFingerprint: semanticRequestFingerprint({
        commandType: "RetireWorktree",
        projectId: PROJECT_A,
        actor,
        schemaVersion: "1",
        payload: args.payload,
      }),
      projectId: PROJECT_A,
      worktreeId: args.payload.worktreeId,
    },
  );
};

// --- row/event assertions ---

const worktreeRow = (sql: SqlClient, worktreeId: string) =>
  Effect.gen(function* () {
    const rows = yield* sql.unsafe<{
      state: string;
      path: string;
      retired_at: string | null;
    }>("SELECT state, path, retired_at FROM worktrees WHERE worktree_id = ?", [
      worktreeId,
    ]);
    return rows[0] ?? null;
  });

const eventsOf = (sql: SqlClient, eventType: string) =>
  Effect.gen(function* () {
    const rows = yield* sql.unsafe<{ payload_json: string }>(
      "SELECT payload_json FROM domain_events WHERE event_type = ?",
      [eventType],
    );
    return rows.map((row) => JSON.parse(row.payload_json));
  });

describe("p11-worktree", () => {
  it("CreateWorktree commits: WorktreeCreated event + Active row persisted", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const gw = yield* CommandGateway;
        const sql = yield* SqlClient;
        const receipt = yield* submitCreate(gw, {
          commandId: cmd("0001"),
          payload: createPayload({
            address: {
              _tag: "GitWorktree",
              path: "/repo/wt-0001",
              repositoryRef: "refs/heads/main",
              branch: "feature/x",
            },
          }),
        });
        expect(receipt.resolution._tag).toBe("Committed");
        const row = yield* worktreeRow(sql, "wt_0001");
        expect(row?.state).toBe("Active");
        expect(row?.path).toBe("/repo/wt-0001");
        expect(row?.retired_at).toBeNull();
        const created = yield* eventsOf(sql, "WorktreeCreated");
        expect(created).toEqual([
          {
            worktreeId: "wt_0001",
            projectId: PROJECT_A,
            workspaceId: WS_A,
            path: "/repo/wt-0001",
            repositoryRef: "refs/heads/main",
            branch: "feature/x",
          },
        ]);
      }),
    );
  });

  it("duplicate worktreeId: same commandId replays the identical receipt (idempotent); a NEW commandId is a typed conflict", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const gw = yield* CommandGateway;
        const sql = yield* SqlClient;
        const payload = createPayload();
        const first = yield* submitCreate(gw, {
          commandId: cmd("0002"),
          payload,
        });
        const replay = yield* submitCreate(gw, {
          commandId: cmd("0002"),
          payload,
        });
        expect(first.resolution._tag).toBe("Committed");
        expect(replay).toEqual(first);
        const conflict = yield* submitCreate(gw, {
          commandId: cmd("0003"),
          payload,
        });
        expect(conflict.resolution._tag).toBe("TerminalRejected");
        if (conflict.resolution._tag === "TerminalRejected") {
          expect(conflict.resolution.error).toEqual({
            _tag: "WorktreeAlreadyExists",
            worktreeId: "wt_0001",
          });
        }
        const rows = yield* sql.unsafe<{ count: number }>(
          "SELECT COUNT(*) AS count FROM worktrees",
        );
        expect(Number(rows[0]?.count)).toBe(1);
        expect(yield* eventsOf(sql, "WorktreeCreated")).toHaveLength(1);
      }),
    );
  });

  it("CreateWorktree rejections: unknown workspace, foreign-project workspace, retired workspace (typed)", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const gw = yield* CommandGateway;
        const unknown = yield* submitCreate(gw, {
          commandId: cmd("0004"),
          payload: createPayload({
            workspaceId: parse(WorkspaceId)(
              "ws_018f2b3c-4d5e-7abc-8def-0123456789ff",
            ),
          }),
        });
        expect(unknown.resolution._tag).toBe("TerminalRejected");
        if (unknown.resolution._tag === "TerminalRejected") {
          expect(unknown.resolution.error._tag).toBe("WorkspaceNotFound");
        }
        const foreign = yield* submitCreate(gw, {
          commandId: cmd("0005"),
          payload: createPayload({ workspaceId: WS_B, projectId: PROJECT_A }),
        });
        expect(foreign.resolution._tag).toBe("TerminalRejected");
        if (foreign.resolution._tag === "TerminalRejected") {
          expect(foreign.resolution.error._tag).toBe("AuthorityDenied");
        }
        const retired = yield* submitCreate(gw, {
          commandId: cmd("0006"),
          payload: createPayload({
            workspaceId: WS_R,
            projectId: PROJECT_R,
          }),
        });
        expect(retired.resolution._tag).toBe("TerminalRejected");
        if (retired.resolution._tag === "TerminalRejected") {
          expect(retired.resolution.error._tag).toBe("WorkspaceNotActive");
        }
        const sql = yield* SqlClient;
        const rows = yield* sql.unsafe<{ count: number }>(
          "SELECT COUNT(*) AS count FROM worktrees",
        );
        expect(Number(rows[0]?.count)).toBe(0);
      }),
    );
  });

  it("RetireWorktree commits: Active→Retired CAS + WorktreeRetired event", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const gw = yield* CommandGateway;
        const sql = yield* SqlClient;
        yield* submitCreate(gw, {
          commandId: cmd("0010"),
          payload: createPayload(),
        });
        const receipt = yield* submitRetire(gw, {
          commandId: cmd("0011"),
          payload: retirePayload(),
        });
        expect(receipt.resolution._tag).toBe("Committed");
        if (receipt.resolution._tag === "Committed") {
          expect(receipt.resolution.result).toEqual({
            worktreeId: "wt_0001",
            projectId: PROJECT_A,
            fromState: "Active",
            toState: "Retired",
            retiredAt: "t9",
          });
        }
        const row = yield* worktreeRow(sql, "wt_0001");
        expect(row?.state).toBe("Retired");
        expect(row?.retired_at).toBe("t9");
        const retired = yield* eventsOf(sql, "WorktreeRetired");
        expect(retired).toEqual([
          { worktreeId: "wt_0001", projectId: PROJECT_A },
        ]);
      }),
    );
  });

  it("RetireWorktree rejections: unknown worktree typed, second retire typed (terminal state)", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const gw = yield* CommandGateway;
        const unknown = yield* submitRetire(gw, {
          commandId: cmd("0012"),
          payload: retirePayload({ worktreeId: "wt_nope" }),
        });
        expect(unknown.resolution._tag).toBe("TerminalRejected");
        if (unknown.resolution._tag === "TerminalRejected") {
          expect(unknown.resolution.error).toEqual({
            _tag: "WorktreeNotFound",
            worktreeId: "wt_nope",
          });
        }
        yield* submitCreate(gw, {
          commandId: cmd("0013"),
          payload: createPayload(),
        });
        yield* submitRetire(gw, {
          commandId: cmd("0014"),
          payload: retirePayload(),
        });
        const again = yield* submitRetire(gw, {
          commandId: cmd("0015"),
          payload: retirePayload(),
        });
        expect(again.resolution._tag).toBe("TerminalRejected");
        if (again.resolution._tag === "TerminalRejected") {
          expect(again.resolution.error).toEqual({
            _tag: "WorktreeAlreadyRetired",
            worktreeId: "wt_0001",
          });
        }
      }),
    );
  });

  it("RetireWorktree precondition (P11 09 §3 / CI-3, §1.4A release-first): active overlapping claims refuse typed; released or non-overlapping claims do not", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const gw = yield* CommandGateway;
        const sql = yield* SqlClient;
        yield* submitCreate(gw, {
          commandId: cmd("0020"),
          payload: createPayload(),
        });
        // active claim INSIDE the worktree region (subtree prefix overlap)
        yield* seedClaim(sql, {
          claimId: "clm_active",
          workspaceId: WS_A,
          path: "/repo/wt-0001/sub",
          releasedAt: null,
        });
        const blocked = yield* submitRetire(gw, {
          commandId: cmd("0021"),
          payload: retirePayload(),
        });
        expect(blocked.resolution._tag).toBe("TerminalRejected");
        if (blocked.resolution._tag === "TerminalRejected") {
          expect(blocked.resolution.error).toEqual({
            _tag: "ActiveClaimsExist",
            worktreeId: "wt_0001",
            claimIds: ["clm_active"],
          });
        }
        // release-first: the worktree row stays Active — nothing was mutated
        const stillActive = yield* worktreeRow(sql, "wt_0001");
        expect(stillActive?.state).toBe("Active");
        expect(yield* eventsOf(sql, "WorktreeRetired")).toHaveLength(0);

        // release the claim via the `10` release path -> retire now commits
        yield* sql.unsafe(
          "UPDATE resource_ownership SET released_at = 't1' WHERE claim_id = 'clm_active'",
        );
        // plus an unrelated non-overlapping active claim must not block
        yield* seedClaim(sql, {
          claimId: "clm_other",
          workspaceId: WS_B,
          path: "/elsewhere",
          releasedAt: null,
        });
        const clean = yield* submitRetire(gw, {
          commandId: cmd("0022"),
          payload: retirePayload(),
        });
        expect(clean.resolution._tag).toBe("Committed");
        const row = yield* worktreeRow(sql, "wt_0001");
        expect(row?.state).toBe("Retired");
      }),
    );
  });

  // §1.4A assertion note: RetireWorkspace's frozen precondition list
  // ("no active ResourceOwnershipClaim") is ENFORCED, not bypassed
  // (DID §1.4A; P11 09 §3). This task deliberately does NOT implement the
  // RetireWorkspace command: the P1 domain transition `retireWorkspace`
  // already carries `hasActiveResourceOwnershipClaim` as a typed
  // precondition (packages/domain/src/workspace.ts, RetireWorkspaceInput),
  // and the command wiring is P11-009. The ActiveClaimsExist case above is
  // the same release-first vocabulary at worktree granularity: retirement
  // is refused while claims are active, and cleanup after retirement is a
  // governance suggestion (files are never auto-deleted).
});
