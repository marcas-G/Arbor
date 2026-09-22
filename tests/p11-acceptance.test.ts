import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import { ProjectEnvironmentPortLive } from "../adapters/environment-local/src/index.js";
import { EnvironmentResolverLocalLive } from "../adapters/environment-resolver-local/src/index.js";
import {
  ClockLive,
  ClockTest,
  CommandStoreLive,
  DomainEventJournalLive,
  EnvironmentRevisionStoreLive,
  IdGeneratorLive,
  layer,
  P8_MIGRATIONS,
  P11_MIGRATIONS,
  ProviderTurnStoreLive,
  RecordEnvironmentChangeLive,
  ResourceOwnershipRepositoryLive,
  runMigrations,
  SessionRepositoryLive,
  TransactionPortLive,
  WorkspaceRepositoryLive,
  WorkWaitStoreLive,
} from "../adapters/persistence-sqlite/src/index.js";
import { FakeProviderLive } from "../adapters/provider-fake/src/index.js";
import {
  SandboxWorktreeDeps,
  SandboxWorktreeLive,
  type SandboxWorktreeOptions,
  type SandboxWorktreeProvisionRequest,
  type SandboxWorktreeRetirement,
  type SandboxWriteBackChange,
} from "../adapters/sandbox-worktree/src/index.js";
import {
  AgentDriverLive,
  checkFreshness,
} from "../packages/agent-runtime/src/index.js";
import {
  type CreateWorktreePayload,
  makeCreateWorktreeHandler,
  makeRetireWorktreeHandler,
  type RetireWorktreePayload,
} from "../packages/application/src/commands/worktree-lifecycle.js";
import {
  type DriftReport,
  type EnvironmentDriftDeps,
  probeDrift,
} from "../packages/application/src/environment-drift.js";
import {
  type DriftSubmissionFace,
  startupDriftProbe,
} from "../packages/application/src/environment-drift-startup.js";
import * as stalenessModule from "../packages/application/src/environment-staleness.js";
import {
  type EnvironmentChangeFact,
  verificationFreshness,
} from "../packages/application/src/environment-staleness.js";
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
  type AgentExecutionState,
  type CanonicalResourceRegion,
  type CommandSubmissionContext,
  concludeVerification,
  type Execution,
  ExecutionId,
  Principal,
  type ProjectId,
  parse,
  SessionId,
  startVerification,
  type Verification,
  VerificationId,
  type VerificationVerdict,
  WorkId,
  type WorkRevision,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  AGENT_DIRECTIVE_CONTRACT,
  type ControlBasis,
  ModelContext,
  type PrepareTurnInput,
} from "../packages/model-context/src/index.js";
import {
  type EnvironmentObservation,
  EnvironmentReProbePort,
  EnvironmentResolverPort,
  type EnvironmentResolverService,
  EnvironmentRevisionStore,
  type EnvironmentRevisionStoreService,
  ExecutionDriverPort,
  ModelCapabilityPort,
  ProjectEnvironmentPort,
  RecordEnvironmentChange,
  type RecordEnvironmentChangeService,
  ResourceOwnershipRepository,
  type RuntimeSafetyGateService,
  SandboxPort,
  type SandboxPortService,
  TransactionPort,
  type TransactionPortService,
  TransactionScope,
  WorkspaceRepository,
  type WorktreeRecord,
  WorktreeStore,
  type WorktreeStoreService,
} from "../packages/ports/src/index.js";
import { ProviderRuntimeLive } from "../packages/provider-runtime/src/index.js";

// P11-012 acceptance: one story per closure invariant CI-1..CI-5 (P11 `00`
// §Five closure invariants) + the end-to-end environment story + the
// P5–P10 regression guard reference. Mechanical evidence only.

// ---------------------------------------------------------------------------
// shared identities / fixtures
// ---------------------------------------------------------------------------

const PROJECT =
  "prj_018f2b3c-4d5e-7abc-8def-0123456789aa" as never as ProjectId;
const WS = parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789aa");
const OPERATOR = parse(Principal)("user:operator");
const ACTOR = parse(Actor)("user:operator");

const suiteTmp = mkdtempSync(join(tmpdir(), "p11-acceptance-"));
afterAll(() => {
  rmSync(suiteTmp, { recursive: true, force: true });
});

/** Canonical region fixture in the frozen comparator encoding
 * * (04-sqlite-schema.md §3.3 — object normalizedRegion, never a raw path). */
const regionFixture = (path: string): CanonicalResourceRegion =>
  ({
    resourceSpaceId: "filesystem",
    normalizedRegion: { kind: "FileTree", path },
  }) as CanonicalResourceRegion;

const seedProjectRows = (sql: SqlClient) =>
  sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES ('ses_acc','WorkspacePrimary',?,NULL,0,'t')",
        [WS],
      );
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,'p',?,'{}',0,'{}','local','Open',0,'t','t')",
        [PROJECT, WS],
      );
      yield* sql.unsafe(
        "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,'root','{}',1,'{}',1,'{}',?,'{}',0,0,'Active','t','t')",
        [WS, PROJECT, "ses_acc"],
      );
    }),
  );

const seedAnchorAndBasis = (
  sql: SqlClient,
  basis: { readonly digest: string },
) =>
  sql.unsafe(
    "INSERT INTO environment_changes (change_id, project_id, from_revision, to_revision, previous_fingerprint, next_fingerprint, snapshot_blob_ref, changed_regions_json, cause, recorded_at) VALUES ('ch-basis', ?, '0', '1', '', ?, ?, '[]', 'Governance', 't')",
    [PROJECT, basis.digest, `blob:${basis.digest}`],
  );

const seedAnchorRow = (sql: SqlClient) =>
  sql.unsafe(
    "INSERT INTO environment_revisions (project_id, revision, updated_at) VALUES (?, '1', 't')",
    [PROJECT],
  );

const anchorOf = (sql: SqlClient) =>
  Effect.gen(function* () {
    const rows = yield* sql.unsafe<{ revision: string | null }>(
      "SELECT revision FROM environment_revisions WHERE project_id = ?",
      [PROJECT],
    );
    return rows[0]?.revision ?? null;
  });

const eventCountOf = (sql: SqlClient) =>
  Effect.gen(function* () {
    const rows = yield* sql.unsafe<{ count: number }>(
      "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'EnvironmentChanged'",
    );
    return Number(rows[0]?.count ?? 0);
  });

const observationFromReport = (
  report: DriftReport & { _tag: "Drift" },
): EnvironmentObservation => ({
  projectId: PROJECT,
  observedRevision: report.candidateRevision,
  fingerprint: report.candidateFingerprint,
  snapshotBlobRef: report.candidateSnapshotBlobRef,
  changedRegions: report.changedRegions,
});

/** Recording double for the governed submission face (startup seam). */
const makeRecFace = () => {
  const calls: Array<{
    observation: EnvironmentObservation;
    cause: string;
  }> = [];
  const face: DriftSubmissionFace = {
    record: (observation, cause) =>
      Effect.suspend(() => {
        calls.push({ observation, cause });
        return Effect.succeed({
          _tag: "Advanced" as const,
          fromRevision: "1",
          toRevision: "2",
        });
      }),
  };
  return { face, calls };
};

/** The full drift→REC stack against one :memory: database: the REAL
 * resolver adapter, the REAL RecordEnvironmentChange adapter, and the
 * transaction-wrapped read faces the drift probe consumes. */
type DriftAppEnv =
  | SqlClient
  | TransactionPort
  | RecordEnvironmentChange
  | EnvironmentResolverPort
  | EnvironmentRevisionStore;

const driftAppLayer = (
  reprobe?: Layer.Layer<EnvironmentReProbePort>,
): Layer.Layer<DriftAppEnv> => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const tx = Layer.provide(TransactionPortLive, base);
  const journal = Layer.provide(DomainEventJournalLive, infra);
  const waits = Layer.provide(WorkWaitStoreLive, infra);
  const recDeps = Layer.mergeAll(
    journal,
    waits,
    base,
    IdGeneratorLive,
    ...(reprobe === undefined ? ([] as const) : [reprobe]),
  );
  const rec = Layer.provide(RecordEnvironmentChangeLive, recDeps);
  const revisions = Layer.provide(EnvironmentRevisionStoreLive, infra);
  const resolver = Layer.provide(EnvironmentResolverLocalLive, base);
  return Layer.mergeAll(
    base,
    tx,
    rec,
    revisions,
    resolver,
  ) as Layer.Layer<DriftAppEnv>;
};

const runDriftApp = <A, E>(
  program: Effect.Effect<A, E, DriftAppEnv>,
  reprobe?: Layer.Layer<EnvironmentReProbePort>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(Effect.provide(program, driftAppLayer(reprobe))),
  );

const makeDriftDeps = (
  resolver: EnvironmentResolverService,
  rec: RecordEnvironmentChangeService,
  revisions: EnvironmentRevisionStoreService,
  tx: TransactionPortService,
): EnvironmentDriftDeps => ({
  resolver,
  changes: {
    latestChange: (projectId) =>
      Effect.mapError(
        tx.transact(rec.latestChange(projectId)),
        (
          cause,
        ): { readonly _tag: "ChangeReadFailure"; readonly cause: unknown } => ({
          _tag: "ChangeReadFailure",
          cause,
        }),
      ),
  },
  revisions: {
    current: (projectId) =>
      Effect.mapError(
        tx.transact(revisions.current(projectId)),
        (
          cause,
        ): {
          readonly _tag: "RevisionReadFailure";
          readonly cause: unknown;
        } => ({
          _tag: "RevisionReadFailure",
          cause,
        }),
      ),
  },
});

const concludedVerification = (
  verdict: VerificationVerdict,
  targetEnvironmentRevision: string | null,
): Verification => {
  const started = startVerification({
    verificationId: parse(VerificationId)(
      "ver_018f2b3c-4d5e-7abc-8def-0123456789e1",
    ),
    workId: parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789e1"),
    targetWorkRevision: 1 as WorkRevision,
    missionSnapshot: {
      goal: "verify the outcome",
      criteria: [
        { criterionId: "c1", requirement: "must hold", required: true },
      ],
      riskRequirements: [],
    },
    targetEnvironmentRevision,
  });
  const result = concludeVerification(started, verdict);
  if (!result.ok) {
    throw new Error(`concludeVerification failed: ${result.error._tag}`);
  }
  return result.value;
};

// ---------------------------------------------------------------------------
// CI-2 fixture (driver + recording ModelContext — p11-controlbasis pattern)
// ---------------------------------------------------------------------------

const cbProjectId = PROJECT;
const cbWorkspaceIds = [
  parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789b1"),
  parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789b2"),
] as const;
const cbSessionIds = [
  parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789b1"),
  parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789b2"),
] as const;
const cbExecutionIds = [
  parse(ExecutionId)("exe_018f2b3c-4d5e-7abc-8def-0123456789b1"),
  parse(ExecutionId)("exe_018f2b3c-4d5e-7abc-8def-0123456789b2"),
] as const;

const cbExecutionOf = (index: 0 | 1): Execution => ({
  executionId: cbExecutionIds[index],
  projectId: cbProjectId,
  workspaceId: cbWorkspaceIds[index],
  binding: {
    _tag: "WorkspaceExecution",
    workspaceId: cbWorkspaceIds[index],
    focus: { _tag: "Coordination" },
  },
  sessionId: cbSessionIds[index],
  admittedAt: "t",
  stopRequestedAt: null,
  state: { status: "Active", settlement: null },
});

const cbStateOf = (index: 0 | 1): AgentExecutionState => ({
  executionId: cbExecutionIds[index],
  focus: { _tag: "Coordination" },
  wakeReason: { _tag: "WorkSelected" },
  currentMode: "execute",
  activeSkillRefs: [],
  turnNo: 0,
  recentDirectiveRefs: [],
  recentActionFingerprints: [],
  updatedAt: "t",
});

const cbContextOf = (index: 0 | 1): CommandSubmissionContext => ({
  _tag: "ExecutionOrigin",
  principal: OPERATOR,
  executionId: cbExecutionIds[index],
  fencingGeneration: 0 as never,
});

const allowGate: RuntimeSafetyGateService = {
  admitActivity: () => Effect.succeed("Continue" as const),
};

const cbCapability = Layer.succeed(ModelCapabilityPort, {
  resolve: () =>
    Effect.succeed({
      modelRef: "model-a",
      family: "f",
      contextWindow: 8000,
      outputCeiling: 512,
      toolProtocol: "json",
    }),
});

const cbClaimTurn = (claimRef: string) => [
  {
    _tag: "ToolCallProposed" as const,
    callRef: "c1",
    toolName: "arbor_directive",
    argumentsJson: JSON.stringify({
      _tag: "CompletionClaim",
      claim: { claimRef, workRevision: 0 },
    }),
  },
  { _tag: "TurnCompleted" as const, finishReason: "ToolCall" as const },
];

const cbRecordingModelContext = (recorded: Array<ControlBasis>) =>
  Layer.succeed(ModelContext, {
    prepareTurn: (input: PrepareTurnInput) =>
      Effect.sync(() => {
        recorded.push(input.controlBasis);
        return {
          _tag: "Ready" as const,
          turn: {
            request: {
              modelRef: "model-a",
              instructions: [],
              messages: [],
              toolDefinitions: [],
              outputContractRef: AGENT_DIRECTIVE_CONTRACT,
              budget: { maxOutputTokens: input.maxOutputTokens },
              cacheHints: [],
            },
            manifest: {
              providerTurnId: input.providerTurnId,
              executionId: input.executionId,
              sessionId: input.sessionId,
              contextEpoch: input.contextEpoch,
              modelRef: "model-a",
              instructionFragments: [],
              contextRefs: [],
              skillRefs: [],
              toolRefs: [],
              outputContractRef: AGENT_DIRECTIVE_CONTRACT,
              budgetDecision: { maxOutputTokens: input.maxOutputTokens },
              compiledRequestHash: "hash-p11-acceptance",
              controlBasis: input.controlBasis,
            },
          },
        };
      }),
  });

const cbMakeApp = () => {
  const recorded: Array<ControlBasis> = [];
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const provider = FakeProviderLive({
    turns: [cbClaimTurn("claim-1"), cbClaimTurn("claim-2")],
  });
  const providerRuntime = Layer.provide(
    ProviderRuntimeLive(3),
    Layer.mergeAll(
      provider,
      Layer.provide(ProviderTurnStoreLive, infra),
      Layer.provide(TransactionPortLive, infra),
      infra,
    ),
  );
  const revisions = Layer.provide(EnvironmentRevisionStoreLive, infra);
  const tx = Layer.provide(TransactionPortLive, infra);
  const driver = Layer.provide(
    AgentDriverLive(),
    Layer.mergeAll(
      cbRecordingModelContext(recorded),
      providerRuntime,
      cbCapability,
      Layer.provide(SessionRepositoryLive, infra),
      tx,
      revisions,
    ),
  );
  return {
    app: Layer.mergeAll(
      infra,
      driver,
      providerRuntime,
      cbCapability,
      revisions,
      tx,
    ),
    recorded,
  };
};

const cbSeed = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (const [index, sessionId] of cbSessionIds.entries()) {
        yield* sql.unsafe(
          "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,?,?,?,?)",
          [sessionId, "WorkspacePrimary", cbWorkspaceIds[index], null, 0, "t"],
        );
      }
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
          cbProjectId,
          "p",
          cbWorkspaceIds[0],
          "{}",
          0,
          "{}",
          "local",
          "Open",
          0,
          "t",
          "t",
        ],
      );
      for (const [index, workspaceId] of cbWorkspaceIds.entries()) {
        yield* sql.unsafe(
          "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?)",
          [
            workspaceId,
            cbProjectId,
            "w",
            "{}",
            0,
            "{}",
            0,
            "{}",
            cbSessionIds[index],
            "{}",
            0,
            0,
            "Active",
            "t",
            "t",
          ],
        );
      }
      for (const [index, executionId] of cbExecutionIds.entries()) {
        yield* sql.unsafe(
          "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, focus_kind, focus_work_id, parent_execution_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?,?,?,?,NULL,NULL,NULL,?,?,NULL,NULL,NULL,NULL)",
          [
            executionId,
            cbProjectId,
            "workspace",
            cbWorkspaceIds[index],
            "coordination",
            cbSessionIds[index],
            "t",
          ],
        );
        yield* sql.unsafe(
          "INSERT INTO execution_leases (execution_id, worker_id, generation, expires_at, updated_at) VALUES (?,?,?,?,?)",
          [executionId, "worker", 0, "9999-12-31T00:00:00.000Z", "t"],
        );
      }
    }),
  );
});

const cbDrive = (index: 0 | 1) =>
  Effect.gen(function* () {
    const driver = yield* ExecutionDriverPort;
    return yield* driver.drive({
      execution: cbExecutionOf(index),
      agentExecutionState: cbStateOf(index),
      wakeReason: { _tag: "WorkSelected" },
      context: cbContextOf(index),
      safetyGate: allowGate,
    });
  });

// ---------------------------------------------------------------------------
// CI-3 fixture (gateway + worktree store — p11-worktree pattern)
// ---------------------------------------------------------------------------

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

const toWorktreeRecord = (row: WorktreeRow): WorktreeRecord => ({
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
              : Option.some(toWorktreeRecord(rows[0] as WorktreeRow));
          }),
        findByWorkspace: (workspaceId: WorkspaceId) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const rows = yield* sql.unsafe<WorktreeRow>(
              "SELECT * FROM worktrees WHERE workspace_id = ? ORDER BY worktree_id",
              [workspaceId],
            );
            return rows.map(toWorktreeRecord);
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
              ? Option.some(toWorktreeRecord(row))
              : Option.none();
          }),
      };
      return WorktreeStore.of(service as unknown as WorktreeStoreService);
    }),
  );

type WtAppEnv =
  | CommandGateway
  | SqlClient
  | TransactionPort
  | WorktreeStore
  | WorkspaceRepository
  | ProjectEnvironmentPort
  | ResourceOwnershipRepository;

const wtMakeApp = (): Layer.Layer<WtAppEnv> => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockTest("t"), IdGeneratorLive);
  const registry = Layer.provide(
    Layer.effect(
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
    ),
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
  ) as Layer.Layer<WtAppEnv>;
};

const wtRun = <A, E>(program: Effect.Effect<A, E, WtAppEnv>): Promise<A> =>
  Effect.runPromise(Effect.scoped(Effect.provide(program, wtMakeApp())));

const wtCreatePayload = (
  overrides: Partial<CreateWorktreePayload> = {},
): CreateWorktreePayload => ({
  worktreeId: "wt_acc1",
  projectId: PROJECT,
  workspaceId: WS,
  address: { _tag: "GitWorktree", path: "/repo/wt-acc1" },
  ...overrides,
});

const wtRetirePayload = (
  overrides: Partial<RetireWorktreePayload> = {},
): RetireWorktreePayload => ({
  worktreeId: "wt_acc1",
  expectedState: "Active",
  ...overrides,
});

type GatewayAuthority = Parameters<CommandGatewayService["execute"]>[2];

const wtSubmit = <P>(
  gw: CommandGatewayService,
  args: {
    readonly commandType: "CreateWorktree" | "RetireWorktree";
    readonly commandId: string;
    readonly payload: P;
  },
) => {
  const envelope: GatewayEnvelope<P> = {
    commandType: args.commandType,
    commandId: args.commandId as never,
    projectId: PROJECT,
    actor: ACTOR,
    issuedAt: "t9",
    payload: args.payload,
  };
  return gw.execute(envelope, { _tag: "External", principal: OPERATOR }, {
    _tag:
      args.commandType === "CreateWorktree"
        ? "CreateWorktreeAuthority"
        : "RetireWorktreeAuthority",
    principal: OPERATOR,
    commandId: args.commandId as never,
    semanticRequestFingerprint: semanticRequestFingerprint({
      commandType: args.commandType,
      projectId: PROJECT,
      actor: ACTOR,
      schemaVersion: "1",
      payload: args.payload,
    }),
    projectId: PROJECT,
    ...(args.commandType === "CreateWorktree"
      ? {
          targetWorkspaceId: (args.payload as CreateWorktreePayload)
            .workspaceId,
          worktreeId: (args.payload as CreateWorktreePayload).worktreeId,
        }
      : { worktreeId: (args.payload as RetireWorktreePayload).worktreeId }),
  } as GatewayAuthority);
};

// --- CI-3 sandbox half (fake wiring log — p11-sandbox-handoff pattern) ---

interface SandboxLog {
  readonly createWorktree: Array<SandboxWorktreeProvisionRequest>;
  readonly recordEnvironmentChange: Array<SandboxWriteBackChange>;
  readonly retireWorktree: Array<SandboxWorktreeRetirement>;
}

const emptySandboxLog = (): SandboxLog => ({
  createWorktree: [],
  recordEnvironmentChange: [],
  retireWorktree: [],
});

const sandboxWorktreeRun = async <A, E>(
  program: (sbx: SandboxPortService) => Effect.Effect<A, E>,
  options: SandboxWorktreeOptions = {},
): Promise<{ result: A; log: SandboxLog }> => {
  const log = emptySandboxLog();
  const worktreeStoreFake = Layer.succeed(
    WorktreeStore,
    WorktreeStore.of({
      insert: () => Effect.void,
      findById: () => Effect.succeed(Option.none()),
      findByWorkspace: () => Effect.succeed([]),
      retireIfActive: () => Effect.succeed(Option.none()),
    } as unknown as WorktreeStoreService),
  );
  const txFake = Layer.succeed(
    TransactionPort,
    TransactionPort.of({
      transact: (body) =>
        Effect.provideService(body, TransactionScope, {
          session: { id: "p11-acceptance-sbx" },
        }),
    }),
  );
  const depsFake = Layer.succeed(
    SandboxWorktreeDeps,
    SandboxWorktreeDeps.of({
      createWorktree: (request) =>
        Effect.sync(() => {
          log.createWorktree.push(request);
          return { worktreeId: "wt_sbx_1", path: request.path };
        }),
      recordEnvironmentChange: (change) =>
        Effect.sync(() => {
          log.recordEnvironmentChange.push(change);
        }),
      retireWorktree: (retirement) =>
        Effect.sync(() => {
          log.retireWorktree.push(retirement);
        }),
    }),
  );
  const effect = Effect.gen(function* () {
    const sandbox = yield* SandboxPort;
    return yield* program(sandbox);
  });
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        effect,
        Layer.provide(
          SandboxWorktreeLive({ baseDir: suiteTmp, ...options }),
          Layer.mergeAll(worktreeStoreFake, txFake, depsFake),
        ),
      ),
    ),
  );
  return { result, log };
};

// ---------------------------------------------------------------------------
// the suite
// ---------------------------------------------------------------------------

describe("p11-acceptance (P11 00 CI-1..CI-5 + end-to-end story)", () => {
  it("CI-1 single advancement path — observation-only sources (mechanical) + observe 100x moves nothing; only governed REC advances 1 -> 2", async () => {
    // Mechanical half: the four observation-only sources carry no
    // advancement capability (extends the tests/p11-resolver.test.ts
    // architecture assertion to drift/startup/sandbox).
    for (const relative of [
      "adapters/environment-resolver-local/src/index.ts",
      "packages/application/src/environment-drift.ts",
      "packages/application/src/environment-drift-startup.ts",
      "adapters/sandbox-worktree/src/index.ts",
    ]) {
      const source = readFileSync(
        join(import.meta.dirname, "..", relative),
        "utf8",
      );
      for (const token of [
        "advanceAnchor",
        "lazyInitAnchor",
        "EnvironmentRevisionStoreLive",
        "EnvironmentRevisionStore.",
        "store.record(",
      ]) {
        expect(source.includes(token), `${relative}: ${token}`).toBe(false);
      }
    }

    // End-to-end half: real fs + real sqlite.
    const dir = join(suiteTmp, "ci1-tree");
    await mkdir(dir, { recursive: true });
    const addresses = [{ _tag: "FileTree" as const, path: dir }];

    await runDriftApp(
      Effect.gen(function* () {
        yield* runMigrations(P11_MIGRATIONS);
        const sql = yield* SqlClient;
        const resolver = yield* EnvironmentResolverPort;
        const rec = yield* RecordEnvironmentChange;
        const revisions = yield* EnvironmentRevisionStore;
        const tx = yield* TransactionPort;

        // basis = the pristine observation (for a clean Drift later)
        const pristine = yield* resolver.observe(PROJECT, addresses);
        yield* seedProjectRows(sql);
        yield* seedAnchorRow(sql);
        yield* seedAnchorAndBasis(sql, pristine.fingerprint);

        // THE uniqueness assertion: 100 observations never move the counter.
        for (let i = 0; i < 100; i += 1) {
          const observed = yield* resolver.observe(PROJECT, addresses);
          expect(observed.observedRevision).toBe("1");
        }
        expect(yield* anchorOf(sql)).toBe("1");

        // external mutation -> drift REPORT (still no advancement)
        const moved = new Date(1_700_000_000_000);
        yield* Effect.promise(() => utimes(dir, moved, moved));
        const deps = makeDriftDeps(resolver, rec, revisions, tx);
        const report = yield* probeDrift(PROJECT, addresses, deps);
        expect(report._tag).toBe("Drift");
        expect(yield* anchorOf(sql)).toBe("1"); // a report advances nothing

        // governance confirmation -> the ONE legal path moves 1 -> 2
        if (report._tag !== "Drift") {
          throw new Error("expected Drift");
        }
        const outcome = yield* tx.transact(
          rec.record(observationFromReport(report), "Governance"),
        );
        expect(outcome._tag).toBe("Advanced");
        expect(yield* anchorOf(sql)).toBe("2");
      }),
    );
  });

  it("CI-2 real ControlBasis — driver has no hardcoded env revision (grep) and an anchor move trips DecisionStale (p11-controlbasis pattern)", async () => {
    const source = readFileSync(
      join(import.meta.dirname, "..", "packages/agent-runtime/src/driver.ts"),
      "utf8",
    );
    expect(source.includes('"env"')).toBe(false);

    const { app, recorded } = cbMakeApp();
    const settlements = await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            yield* runMigrations(P8_MIGRATIONS);
            yield* cbSeed;
            const store = yield* EnvironmentRevisionStore;
            const tx = yield* TransactionPort;
            yield* tx.transact(store.record(cbProjectId, "7"));
            const first = yield* cbDrive(0);
            const advanced = yield* tx.transact(
              store.advanceAnchor(cbProjectId, "7"),
            );
            expect(advanced).toEqual({ _tag: "Advanced", to: "8" });
            const second = yield* cbDrive(1);
            return [first, second];
          }),
          app,
        ),
      ),
    );
    expect(
      (settlements as ReadonlyArray<{ readonly _tag: string }>).map(
        (settlement) => settlement._tag,
      ),
    ).toEqual(["Completed", "Completed"]);
    expect(recorded[0]?.environmentRevision).toBe("7");
    expect(recorded[1]?.environmentRevision).toBe("8");
    const stale = checkFreshness(
      recorded[0] as ControlBasis,
      recorded[1] as ControlBasis,
      "Weak",
    );
    expect(stale?._tag).toBe("DecisionStale");
    expect(stale?.changed).toContain("environmentRevision");
  });

  it("CI-3 worktree terminal closure — retire refused while claims are active, release unblocks, commit closes; sandbox ephemeral close rides the retire callback chain", async () => {
    // -- gateway half (release-first, then terminal closure) --
    await wtRun(
      Effect.gen(function* () {
        yield* runMigrations(P11_MIGRATIONS);
        const sql = yield* SqlClient;
        const gw = yield* CommandGateway;
        yield* sql.unsafe(WORKTREES_TEST_DDL, []);
        yield* seedProjectRows(sql);

        const created = yield* wtSubmit(gw, {
          commandType: "CreateWorktree",
          commandId: "cmd_wt_acc_0001",
          payload: wtCreatePayload(),
        });
        expect(created.resolution._tag).toBe("Committed");

        // active claim inside the worktree region -> typed refusal, no
        // terminal transition, no event
        yield* sql.unsafe(
          "INSERT INTO resource_ownership (claim_id, workspace_id, resource_space_id, canonical_region, source_address_snapshot, resource_boundary_revision, resolved_at_environment_revision, created_at, released_at) VALUES ('clm_acc',?, 'filesystem', ?, '{\"_tag\":\"GitWorktree\",\"path\":\"/repo/wt-acc1\"}', 1, '1', 't', NULL)",
          [
            WS,
            JSON.stringify({
              resourceSpaceId: "filesystem",
              normalizedRegion: {
                kind: "GitWorktree",
                path: "/repo/wt-acc1/sub",
              },
            }),
          ],
        );
        const blocked = yield* wtSubmit(gw, {
          commandType: "RetireWorktree",
          commandId: "cmd_wt_acc_0002",
          payload: wtRetirePayload(),
        });
        expect(blocked.resolution._tag).toBe("TerminalRejected");
        if (blocked.resolution._tag === "TerminalRejected") {
          expect(
            (blocked.resolution.error as { readonly _tag: string })._tag,
          ).toBe("ActiveClaimsExist");
        }
        const stillActive = yield* sql.unsafe<{ state: string }>(
          "SELECT state FROM worktrees WHERE worktree_id = 'wt_acc1'",
        );
        expect(stillActive[0]?.state).toBe("Active");
        const noEvent = yield* sql.unsafe<{ count: number }>(
          "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'WorktreeRetired'",
        );
        expect(Number(noEvent[0]?.count)).toBe(0);

        // release-first: after the release path frees the claim, the
        // terminal transition commits and closes the lifecycle
        yield* sql.unsafe(
          "UPDATE resource_ownership SET released_at = 't1' WHERE claim_id = 'clm_acc'",
        );
        const retired = yield* wtSubmit(gw, {
          commandType: "RetireWorktree",
          commandId: "cmd_wt_acc_0003",
          payload: wtRetirePayload(),
        });
        expect(retired.resolution._tag).toBe("Committed");
        const closed = yield* sql.unsafe<{
          state: string;
          retired_at: string;
        }>(
          "SELECT state, retired_at FROM worktrees WHERE worktree_id = 'wt_acc1'",
        );
        expect(closed[0]?.state).toBe("Retired");
        expect(closed[0]?.retired_at).toBe("t9");
        const event = yield* sql.unsafe<{ count: number }>(
          "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'WorktreeRetired'",
        );
        expect(Number(event[0]?.count)).toBe(1);
      }),
    );

    // -- sandbox half: ephemeral close -> write-back REC + retire chain --
    const fresh = join(suiteTmp, "ci3-ephemeral-wt");
    const { log } = await sandboxWorktreeRun(
      (sbx) =>
        Effect.gen(function* () {
          const handle = yield* sbx.open({
            executionId: parse(ExecutionId)(
              "exe_018f2b3c-4d5e-7abc-8def-0123456789aa",
            ),
            workspaceId: WS,
            regions: [
              {
                resourceSpaceId: "filesystem",
                normalizedRegion: { kind: "GitWorktree", path: fresh },
              },
            ],
          });
          yield* sbx.close(handle);
        }),
      { provisionOnOpen: true },
    );
    expect(log.recordEnvironmentChange).toHaveLength(1);
    expect(log.recordEnvironmentChange[0]?.cause).toBe("Governance");
    expect(log.retireWorktree).toEqual([{ worktreeId: "wt_sbx_1" }]);
  });

  it("CI-4 drift convergence — probe -> Drift -> governed REC -> NoDrift; NoDrift never submits; a second conflict stops at Attention", async () => {
    const dir = join(suiteTmp, "ci4-tree");
    await mkdir(dir, { recursive: true });
    const addresses = [{ _tag: "FileTree" as const, path: dir }];

    // controllable re-probe seam (B4): a fresh observation that still
    // misses the anchor drives the second-conflict stop
    let reprobeObservation: EnvironmentObservation | undefined;
    const reprobeLayer = Layer.succeed(EnvironmentReProbePort, {
      reprobe: (_projectId: ProjectId) =>
        reprobeObservation === undefined
          ? Effect.fail({
              _tag: "ReProbeFailed" as const,
              cause: "not configured",
            })
          : Effect.succeed(reprobeObservation),
    });

    await runDriftApp(
      Effect.gen(function* () {
        yield* runMigrations(P11_MIGRATIONS);
        const sql = yield* SqlClient;
        const resolver = yield* EnvironmentResolverPort;
        const rec = yield* RecordEnvironmentChange;
        const revisions = yield* EnvironmentRevisionStore;
        const tx = yield* TransactionPort;

        const pristine = yield* resolver.observe(PROJECT, addresses);
        yield* seedProjectRows(sql);
        yield* seedAnchorRow(sql);
        yield* seedAnchorAndBasis(sql, pristine.fingerprint);
        const deps = makeDriftDeps(resolver, rec, revisions, tx);

        // NoDrift -> never submitted (startup seam, autoSubmit default off)
        const recFace = makeRecFace();
        const quiet = yield* startupDriftProbe(PROJECT, addresses, {
          ...deps,
          rec: recFace.face,
        });
        expect(quiet.report._tag).toBe("NoDrift");
        expect(quiet.submission).toEqual({ _tag: "NotRequired" });
        expect(recFace.calls).toHaveLength(0);

        // external mutation -> Drift REPORT; default startup keeps it a
        // proposal (governance confirmation is the convergence path)
        const moved = new Date(1_700_000_000_000);
        yield* Effect.promise(() => utimes(dir, moved, moved));
        const proposal = yield* startupDriftProbe(PROJECT, addresses, {
          ...deps,
          rec: recFace.face,
        });
        expect(proposal.report._tag).toBe("Drift");
        expect(proposal.submission).toEqual({ _tag: "NotRequired" });
        expect(recFace.calls).toHaveLength(0);
        if (proposal.report._tag !== "Drift") {
          throw new Error("expected Drift");
        }

        // governance confirmation -> convergence
        const outcome = yield* tx.transact(
          rec.record(observationFromReport(proposal.report), "Governance"),
        );
        expect(outcome._tag).toBe("Advanced");
        expect(yield* anchorOf(sql)).toBe("2");

        const reconverged = yield* probeDrift(PROJECT, addresses, deps);
        expect(reconverged).toEqual({ _tag: "NoDrift", atRevision: "2" });

        // second conflict -> Attention, no third retry (B4 bounded loop)
        reprobeObservation = {
          projectId: PROJECT,
          observedRevision: "99",
          fingerprint: pristine.fingerprint,
          snapshotBlobRef: pristine.snapshotBlobRef,
          changedRegions: pristine.changedRegions,
        };
        const conflicted = yield* tx.transact(
          rec.record(
            {
              projectId: PROJECT,
              observedRevision: "0",
              fingerprint: pristine.fingerprint,
              snapshotBlobRef: pristine.snapshotBlobRef,
              changedRegions: pristine.changedRegions,
            },
            "ExternalDrift",
          ),
        );
        expect(conflicted._tag).toBe("SecondConflictEscalatedToAttention");
        expect(yield* anchorOf(sql)).toBe("2"); // nothing advanced
      }),
      reprobeLayer,
    );
  });

  it("CI-5 verdict immutability — four-state overlay keeps the stored verdict byte-identical; the staleness module carries no write path (p11-staleness prohibitions)", () => {
    const modulePath = join(
      import.meta.dirname,
      "..",
      "packages",
      "application",
      "src",
      "environment-staleness.ts",
    );
    const source = readFileSync(modulePath, "utf8");

    const alreadySeen: ReadonlyArray<EnvironmentChangeFact> = [
      { toRevision: "1", changedRegions: [regionFixture("/pkg-a")] },
    ];
    const advanced: ReadonlyArray<EnvironmentChangeFact> = [
      { toRevision: "2", changedRegions: [regionFixture("/pkg-a")] },
    ];

    // PASS+CURRENT: equality is already-seen
    const passCurrent = concludedVerification("Pass", "1");
    expect(
      verificationFreshness(
        {
          targetEnvironmentRevision: passCurrent.targetEnvironmentRevision,
          boundRegions: [regionFixture("/pkg-a/module-1")],
        },
        alreadySeen,
      ),
    ).toBe("CURRENT");
    expect(passCurrent.state).toEqual({ status: "Concluded", verdict: "Pass" });

    // PASS/FAIL/UNKNOWN + STALE: the four states, one stored verdict each
    for (const verdict of ["Pass", "Fail", "Unknown"] as const) {
      const verification = concludedVerification(verdict, "1");
      const before = structuredClone(verification);
      expect(
        verificationFreshness(
          {
            targetEnvironmentRevision: verification.targetEnvironmentRevision,
            boundRegions: [regionFixture("/pkg-a/module-1")],
          },
          advanced,
        ),
      ).toBe("STALE");
      expect(verification.state).toEqual({ status: "Concluded", verdict });
      expect(verification).toEqual(before); // overlay never mutated the row
    }

    // prohibitions (07 §2, mirrored from tests/p11-staleness.test.ts)
    for (const literal of ['"Pass"', '"Fail"', '"Unknown"']) {
      expect(source.includes(literal), literal).toBe(false);
    }
    for (const forbidden of [
      "Effect",
      "Gateway",
      "Repository",
      "Store",
      "Journal",
      "PendingDomainEvent",
      ".transact",
      ".insert",
      ".update",
    ]) {
      expect(source.includes(forbidden), forbidden).toBe(false);
    }
    expect(Object.keys(stalenessModule).sort()).toEqual([
      "ownershipClaimFreshness",
      "staleAttentionRow",
      "verificationFreshness",
    ]);
  });

  it("Story A — real fs tmp tree: observe -> external mtime change -> Drift -> governed REC -> EnvironmentChanged event + wake target + STALE overlay; zero verdict mutation throughout", async () => {
    const dir = join(suiteTmp, "story-a-tree");
    await mkdir(dir, { recursive: true });
    const addresses = [{ _tag: "FileTree" as const, path: dir }];

    await runDriftApp(
      Effect.gen(function* () {
        yield* runMigrations(P11_MIGRATIONS);
        const sql = yield* SqlClient;
        const resolver = yield* EnvironmentResolverPort;
        const rec = yield* RecordEnvironmentChange;
        const revisions = yield* EnvironmentRevisionStore;
        const tx = yield* TransactionPort;

        // observe the pristine tree and anchor the basis on it
        const pristine = yield* resolver.observe(PROJECT, addresses);
        yield* seedProjectRows(sql);
        yield* seedAnchorRow(sql);
        yield* seedAnchorAndBasis(sql, pristine.fingerprint);
        // a work waiting on EnvironmentChanged(observed 0) — the wake target
        yield* sql.unsafe(
          "INSERT INTO works (work_id, project_id, workspace_id, objective, why, constraints, completion_expectation, verification_mission, provenance, revision, lifecycle, created_at, updated_at) VALUES ('wrk_acc_w',?, ?,'o','w','[]','c','{}','{}',0,'Open','t','t')",
          [PROJECT, WS],
        );
        yield* sql.unsafe(
          "INSERT INTO work_waits (work_id, wait_mode, conditions_json, registered_at, updated_at) VALUES ('wrk_acc_w','Any',?, 't','t')",
          [
            JSON.stringify([
              {
                _tag: "EnvironmentChanged",
                environmentRef: "local",
                observedRevision: "0",
              },
            ]),
          ],
        );
        expect(yield* eventCountOf(sql)).toBe(0);

        // external mutation (outside Arbor) -> drift detection
        const moved = new Date(1_700_000_000_000);
        yield* Effect.promise(() => utimes(dir, moved, moved));
        const deps = makeDriftDeps(resolver, rec, revisions, tx);
        const report = yield* probeDrift(PROJECT, addresses, deps);
        expect(report._tag).toBe("Drift");
        if (report._tag !== "Drift") {
          throw new Error("expected Drift");
        }
        // zero verdict mutation baseline: a concluded PASS at revision 1
        const verification = concludedVerification("Pass", "1");
        const verificationBefore = structuredClone(verification);

        // governance-confirmed REC: event + wake target + advancement
        const outcome = yield* tx.transact(
          rec.record(observationFromReport(report), "Governance"),
        );
        expect(outcome._tag).toBe("Advanced");
        expect(yield* anchorOf(sql)).toBe("2");
        expect(yield* eventCountOf(sql)).toBe(1);
        const eventRows = yield* sql.unsafe<{ payload_json: string }>(
          "SELECT payload_json FROM domain_events WHERE event_type = 'EnvironmentChanged'",
        );
        const payload = JSON.parse(eventRows[0]?.payload_json ?? "{}");
        expect(payload.fromRevision).toBe("1");
        expect(payload.toRevision).toBe("2");
        expect(payload.cause).toBe("Governance");
        if (outcome._tag === "Advanced" && "facts" in outcome) {
          const facts = (
            outcome as unknown as {
              facts: {
                wakeTargets: ReadonlyArray<{
                  workId: string;
                  workspaceId: string;
                  fromRevision: string;
                  toRevision: string;
                }>;
              };
            }
          ).facts;
          expect(facts.wakeTargets).toEqual([
            {
              workId: "wrk_acc_w",
              workspaceId: "wrk_acc_w",
              fromRevision: "1",
              toRevision: "2",
            },
          ]);
        }

        // freshness: the SAME stored verdict renders STALE over the change.
        // The fact carries the real observed region (the resolver's fs
        // path), encoded per the frozen comparator contract; the mission
        // bound a subpath inside it (narrow overlap).
        const changedPath = String(report.changedRegions[0]?.normalizedRegion);
        const freshness = verificationFreshness(
          {
            targetEnvironmentRevision: verification.targetEnvironmentRevision,
            boundRegions: [regionFixture(join(changedPath, "module-1"))],
          },
          [{ toRevision: "2", changedRegions: [regionFixture(changedPath)] }],
        );
        expect(freshness).toBe("STALE");
        expect(verification).toEqual(verificationBefore); // zero mutation
      }),
    );
  });

  it("P5–P10 regression guard reference — the guard suites are on the vitest include path and present per phase", () => {
    const config = readFileSync(
      join(import.meta.dirname, "..", "vitest.config.ts"),
      "utf8",
    );
    expect(config.includes('"tests/**/*.test.ts"')).toBe(true);
    expect(config.includes('"apps/*/test/**/*.test.ts"')).toBe(true);

    // per-phase representative suites exist (P5..P10 stay wired in)
    const representatives: ReadonlyArray<[string, string]> = [
      ["P5", "apps/single-workspace/test/p5-slice-acceptance.test.ts"],
      ["P6", "tests/p6-acceptance.test.ts"],
      ["P7", "tests/p7-acceptance.test.ts"],
      ["P8", "tests/p8-acceptance.test.ts"],
      ["P9", "tests/p9-acceptance.test.ts"],
      ["P10", "tests/p10-acceptance.test.ts"],
    ];
    for (const [phase, relative] of representatives) {
      expect(existsSync(join(import.meta.dirname, "..", relative)), phase).toBe(
        true,
      );
    }
    // per-phase architecture guards exist
    for (const phase of ["p5", "p6", "p7", "p8", "p9", "p10"]) {
      expect(
        existsSync(
          join(
            import.meta.dirname,
            "architecture",
            `${phase}-architecture.test.ts`,
          ),
        ),
        phase,
      ).toBe(true);
    }
    // the DAG edge table (with the declared P11 whitelist edges) is present
    const dag = readFileSync(
      join(import.meta.dirname, "architecture", "package-dag.ts"),
      "utf8",
    );
    expect(dag.includes('"sandbox-worktree"')).toBe(true);
    expect(dag.includes('"environment-resolver-local"')).toBe(true);
  });
});
