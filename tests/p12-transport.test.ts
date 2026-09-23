import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AcceptanceRepositoryLive,
  ClockLive,
  CommandStoreLive,
  DomainEventJournalLive,
  ExecutionRepositoryLive,
  FormationProposalStoreLive,
  IdGeneratorLive,
  InboxProjectionStoreLive,
  layer,
  P12_MIGRATIONS,
  PermissionGrantRepositoryLive,
  ProjectRepositoryLive,
  runMigrations,
  SessionRepositoryLive,
  TransactionPortLive,
  VerificationRepositoryLive,
  WorkRepositoryLive,
  WorkspaceRepositoryLive,
  WorkWaitStoreLive,
} from "../adapters/persistence-sqlite/src/index.js";
import { SliceCommandHandlerRegistryLive } from "../apps/single-workspace/src/registry.js";
import {
  isViewId,
  makeCliShell,
  makeConsumerLoopDaemon,
  makeDriftWatcherTrigger,
  makeExternalSubmissionFromServices,
  makeHttpShell,
  makeProductionDaemon,
  makeRecoveryDaemon,
  makeStaticAuthenticator,
  makeTransportCore,
  makeWebShell,
  makeWebSocketShell,
  recoveryDaemonFromPrincipal,
  SEARCH_TRANSPORT_BINDING,
  type ViewQueryFace,
} from "../apps/single-workspace/src/transport/index.js";
import type {
  TreeViewRes,
  ViewRequestMap,
  ViewResponseMap,
} from "../packages/api-contracts/src/index.js";
import type {
  CommandGateway,
  CommandHandlerRegistry,
  ConsumerLoopResult,
  CreateProjectPayload,
  DriftReport,
} from "../packages/application/src/index.js";
import {
  AuthorityResolverPort,
  AuthorityResolverPortLive,
  CommandGatewayLive,
  FenceStopCheckInertLive,
} from "../packages/application/src/index.js";
import {
  Actor,
  CommandId,
  ContextEpochNumber,
  makeProjectPolicy,
  makeWorkspacePolicy,
  Principal,
  ProjectId,
  parse,
  type QueryResult,
  ResourceBoundaryRevision,
  ResponsibilityRevision,
  Revision,
  responsibilityBound,
  SessionId,
  VIEW_IDS,
  type ViewId,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import type { ProjectionStale } from "../packages/ports/src/errors.js";
import type {
  Clock,
  CommandStore,
  DomainEventJournal,
  ExecutionRepository,
  IdGenerator,
  PermissionGrantRepository,
  ProjectRepository,
  SessionRepository,
  TransactionPort,
  WorkRepository,
  WorkspaceRepository,
  WorkWaitStore,
} from "../packages/ports/src/index.js";

/**
 * P12-010 (`10` §1–§5; EC-11). Mechanical evidence:
 *  - HTTP / WebSocket / CLI / web shells render the frozen `api-contracts` DTOs
 *    unchanged and present failures as the frozen `Problem` DTO;
 *  - the transport forwards a raw Command to the composition root, which loads
 *    `canonicalFacts` / `grants`, invokes the Authority Resolver and only then
 *    calls the `CommandGateway` (no canonical write in transport; no authority
 *    assertion in transport);
 *  - the recovery / consumer-loop / drift-watcher deployment surfaces are
 *    wired as composition-root daemons;
 *  - Search is recorded as an out-of-v1 deferral (no Search surface, no
 *    invented query/index semantics).
 */

const repoRoot = join(import.meta.dirname, "..");
const transportDir = join(
  repoRoot,
  "apps",
  "single-workspace",
  "src",
  "transport",
);
const readTransport = (file: string): string =>
  readFileSync(join(transportDir, file), "utf8");

const SHELL_FILES = [
  "contracts.ts",
  "core.ts",
  "auth.ts",
  "errors.ts",
  "http.ts",
  "websocket.ts",
  "cli.ts",
  "web-shell.ts",
  "search.ts",
] as const;

const HUMAN = parse(Principal)("user:human");
const AGENT = parse(Principal)("agent:worker");
const PROJECT = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789ab");
const WORKSPACE = parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789ab");
const SESSION = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789ab");
const COMMAND = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789ab");
const STOP_COMMAND = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789ac",
);
const EXECUTION = "exe_018f2b3c-4d5e-7abc-8def-0123456789ab";

const treeDto: TreeViewRes = {
  nodes: [
    {
      workspaceId: WORKSPACE,
      name: "root",
      status: "executing",
      subtreeAttention: { attention: 1, actionRequired: 0 },
    },
  ],
};

const treeResult: QueryResult<TreeViewRes> = {
  value: treeDto,
  watermark: 7,
  lag: 2,
};

const staleError: ProjectionStale = {
  _tag: "ProjectionStale",
  code: "projection/stale",
  category: "stale",
  correlationId: "corr-1",
  retryDisposition: "retryable",
  safeDetails: { watermark: 1, lag: 5 },
};

const stubViews = (): ViewQueryFace => ({
  query: (<V extends ViewId>(view: V, _request: ViewRequestMap[V]) =>
    view === "responsibility-tree"
      ? Effect.succeed(treeResult as unknown as QueryResult<ViewResponseMap[V]>)
      : Effect.fail(staleError)) as ViewQueryFace["query"],
});

const createProjectPayload = (): CreateProjectPayload => ({
  name: "Arbor",
  revision: parse(Revision)(0),
  projectPolicy: makeProjectPolicy(),
  projectPolicyRevision: parse(Revision)(0),
  defaultConfiguration: {},
  environmentRef: "local",
  rootWorkspaceId: WORKSPACE,
  primarySession: {
    sessionId: SESSION,
    contextEpoch: parse(ContextEpochNumber)(0),
  },
  rootWorkspace: {
    name: "root",
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
      addresses: [],
    },
    resourceBoundaryRevision: parse(ResourceBoundaryRevision)(0),
    agentBinding: responsibilityBound(WORKSPACE),
    workspacePolicy: makeWorkspacePolicy(),
    workspacePolicyRevision: parse(Revision)(0),
    revision: parse(Revision)(0),
  },
});

const createProjectEnvelope = () => ({
  commandType: "CreateProject",
  commandId: COMMAND,
  projectId: PROJECT,
  actor: parse(Actor)("user:human"),
  issuedAt: "2026-09-22T00:00:00.000Z",
  payload: createProjectPayload() as unknown,
});

const stopEnvelope = () => ({
  commandType: "StopExecution",
  commandId: STOP_COMMAND,
  projectId: PROJECT,
  actor: parse(Actor)("user:human"),
  issuedAt: "2026-09-22T00:00:00.000Z",
  payload: { executionId: EXECUTION } as unknown,
});

// --- the composition root invokes the resolver; we count the invocations ---

let resolverCalls = 0;

const innerResolver = Effect.runSync(
  Effect.provide(
    Effect.gen(function* () {
      return yield* AuthorityResolverPort;
    }),
    AuthorityResolverPortLive,
  ),
);

const CountingResolverLive: Layer.Layer<AuthorityResolverPort> = Layer.succeed(
  AuthorityResolverPort,
  {
    ...innerResolver,
    resolve: (input) =>
      Effect.flatMap(
        Effect.sync(() => {
          resolverCalls += 1;
        }),
        () => innerResolver.resolve(input),
      ),
  },
);

type DbServices =
  | SqlClient
  | AuthorityResolverPort
  | CommandGateway
  | CommandHandlerRegistry
  | TransactionPort
  | ProjectRepository
  | WorkspaceRepository
  | ExecutionRepository
  | WorkRepository
  | PermissionGrantRepository
  | CommandStore
  | DomainEventJournal
  | SessionRepository
  | WorkWaitStore
  | Clock
  | IdGenerator;

const makeApp = (): Layer.Layer<DbServices> => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const deps = Layer.mergeAll(
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(CommandStoreLive, infra),
    Layer.provide(DomainEventJournalLive, infra),
    Layer.provide(ProjectRepositoryLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(SessionRepositoryLive, infra),
    Layer.provide(WorkRepositoryLive, infra),
    Layer.provide(ExecutionRepositoryLive, infra),
    Layer.provide(WorkWaitStoreLive, infra),
    Layer.provide(PermissionGrantRepositoryLive, infra),
    // P13: the external registry also wires the Human-actionable governance
    // handlers (RecordDecision/SteerWork/AcceptWorkOutcome/Grant/Revoke).
    Layer.provide(FormationProposalStoreLive, infra),
    Layer.provide(InboxProjectionStoreLive, infra),
    Layer.provide(VerificationRepositoryLive, infra),
    Layer.provide(AcceptanceRepositoryLive, infra),
  );
  const all = Layer.mergeAll(
    infra,
    deps,
    FenceStopCheckInertLive,
    Layer.provide(SliceCommandHandlerRegistryLive, deps),
    CountingResolverLive,
  );
  return Layer.mergeAll(
    all,
    Layer.provide(CommandGatewayLive, all),
  ) as Layer.Layer<DbServices>;
};

const run = <A>(program: Effect.Effect<A, unknown, DbServices>): Promise<A> =>
  Effect.runPromise(Effect.provide(program, makeApp()));

const countRows = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${table}`,
    );
    return Number(rows[0]?.count ?? 0);
  });

const emptyConsumerResult: ConsumerLoopResult = {
  fromSequence: 0,
  lastSequence: 0,
  applied: 0,
  quarantined: 0,
  records: [],
};

describe("P12-010 transport shells render api-contracts DTOs (EC-11)", () => {
  const core = makeTransportCore({
    views: stubViews(),
    authenticator: makeStaticAuthenticator({ "human-token": HUMAN }),
    submission: {
      submit: () =>
        Effect.succeed({
          ok: true as const,
          status: 200,
          body: { commandId: COMMAND, resolution: "Committed" as const },
        }),
    },
  });
  const http = makeHttpShell(core);
  const ws = makeWebSocketShell(core);
  const cli = makeCliShell(core);
  const web = makeWebShell(core);

  it("HTTP / WS / CLI render the same frozen DTO unchanged", async () => {
    const viaHttp = await Effect.runPromise(
      http.handle({
        method: "POST",
        path: "/views/responsibility-tree",
        body: { projectId: PROJECT },
      }),
    );
    const viaWs = await Effect.runPromise(
      ws.handleFrame({
        kind: "view",
        view: "responsibility-tree",
        request: { projectId: PROJECT },
      }),
    );
    const viaCli = await Effect.runPromise(
      cli.run([
        "view",
        "responsibility-tree",
        JSON.stringify({ projectId: PROJECT }),
      ]),
    );
    for (const response of [viaHttp, viaWs, viaCli]) {
      expect(response.ok).toBe(true);
      if (response.ok) {
        expect(response.status).toBe(200);
        expect(response.body).toEqual(treeResult);
        const body = response.body as QueryResult<TreeViewRes>;
        expect(body.value).toEqual(treeDto);
        expect(Object.keys(body.value.nodes[0] ?? {})).toEqual([
          "workspaceId",
          "name",
          "status",
          "subtreeAttention",
        ]);
      }
    }
  });

  it("web shell renders the DTO as an embedded JSON island (no reinterpretation)", async () => {
    const rendered = await Effect.runPromise(
      web.renderView("responsibility-tree", { projectId: PROJECT }),
    );
    expect(rendered.contentType).toBe("text/html; charset=utf-8");
    expect(rendered.html).toContain(JSON.stringify(treeResult));
  });

  it("failures are presented as the frozen six-field Problem DTO", async () => {
    const response = await Effect.runPromise(
      http.handle({
        method: "POST",
        path: "/views/attention",
        body: { projectId: PROJECT },
      }),
    );
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(Object.keys(response.problem).sort()).toEqual([
        "category",
        "code",
        "correlationId",
        "message",
        "retryDisposition",
        "safeDetails",
      ]);
      expect(response.problem.code).toBe("projection/stale");
      expect(response.problem.category).toBe("stale");
      expect(response.status).toBe(409);
    }
    const unknown = await Effect.runPromise(
      http.handle({ method: "POST", path: "/views/does-not-exist", body: {} }),
    );
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.problem.code).toBe("transport/unknown-view");
    }
  });

  it("Search is an out-of-v1 deferral: no Search surface or view id", () => {
    expect(SEARCH_TRANSPORT_BINDING.implemented).toBe(false);
    expect(SEARCH_TRANSPORT_BINDING.owner).toBe("P10");
    expect(SEARCH_TRANSPORT_BINDING.viewSemantics).toBe("unfrozen");
    expect(isViewId("search")).toBe(false);
    expect((VIEW_IDS as ReadonlyArray<string>).includes("search")).toBe(false);
  });
});

describe("P12-010 transport forwards Commands through the composition root (EC-11)", () => {
  beforeEach(() => {
    resolverCalls = 0;
  });

  it("forwards a Command; resolver runs at the composition root; no transport write", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        yield* runMigrations(P12_MIGRATIONS);
        const submission = yield* makeExternalSubmissionFromServices({
          authenticatedHumans: [],
          directParentOf: [],
        });
        const core = makeTransportCore({
          views: stubViews(),
          authenticator: makeStaticAuthenticator({ "human-token": HUMAN }),
          submission,
        });
        const response = yield* core.submitCommand(
          { token: "human-token" },
          createProjectEnvelope(),
        );
        return { response, projects: yield* countRows("projects") };
      }),
    );
    expect(outcome.response.ok).toBe(true);
    if (outcome.response.ok) {
      expect(outcome.response.body.resolution).toBe("Committed");
    }
    expect(outcome.projects).toBe(1);
    expect(resolverCalls).toBe(1);

    // CI-1: transport shells carry no mutation/resolver capability.
    for (const file of SHELL_FILES) {
      const source = readTransport(file);
      for (const forbidden of [
        "@arbor/application",
        "AuthorityResolverPort",
        "CommandGateway",
        "gateway.execute",
        "TransactionPort",
        "SqlClient",
        "persistence-sqlite",
        // RG-16: the human/parent shell plane carries no worker identity.
        "workerId",
        "WorkerIncarnationId",
        "RemoteWorker",
        "WorkerTransport",
      ]) {
        expect(source.includes(forbidden), `${file}: ${forbidden}`).toBe(false);
      }
    }
    // The composition root owns the resolver + gateway, never a direct write.
    const composition = readTransport("composition.ts");
    expect(composition.includes("AuthorityResolverPort")).toBe(true);
    expect(composition.includes("gateway.execute")).toBe(true);
    expect(composition.includes("activeGrants")).toBe(true);
    for (const write of [
      ".create(",
      ".put(",
      ".revoke(",
      "journal.append",
      "insertCommitted",
    ]) {
      expect(composition.includes(write), `composition: ${write}`).toBe(false);
    }
  });

  it("transport never asserts authority: external Stop without a grant is denied", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        yield* runMigrations(P12_MIGRATIONS);
        const submission = yield* makeExternalSubmissionFromServices({
          authenticatedHumans: [],
          directParentOf: [],
        });
        const core = makeTransportCore({
          views: stubViews(),
          authenticator: makeStaticAuthenticator({ "agent-token": AGENT }),
          submission,
        });
        const response = yield* core.submitCommand(
          { token: "agent-token" },
          stopEnvelope(),
        );
        return { response, executions: yield* countRows("executions") };
      }),
    );
    expect(outcome.response.ok).toBe(false);
    if (!outcome.response.ok) {
      expect(outcome.response.problem.code).toBe("authority/denied");
      expect(outcome.response.problem.category).toBe("forbidden");
    }
    expect(outcome.executions).toBe(0);
    expect(resolverCalls).toBe(1);
  });

  it("external Stop from an authenticated human follows the resolver path", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        yield* runMigrations(P12_MIGRATIONS);
        const submission = yield* makeExternalSubmissionFromServices({
          authenticatedHumans: [HUMAN],
          directParentOf: [],
        });
        const core = makeTransportCore({
          views: stubViews(),
          authenticator: makeStaticAuthenticator({ "human-token": HUMAN }),
          submission,
        });
        return yield* core.submitCommand(
          { token: "human-token" },
          stopEnvelope(),
        );
      }),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      // The resolver produced the trusted fact; the gateway then rejected the
      // missing execution — never an AuthorityDenied.
      expect(outcome.body.resolution).toBe("TerminalRejected");
      expect(outcome.body.rejection).not.toBe("AuthorityDenied");
    }
  });
});

describe("P12-010 deployment daemons are wired (EC-11)", () => {
  it("production daemon sequences migrate -> startup recovery -> sweeps -> offset polls", async () => {
    const order: string[] = [];
    const recovery = makeRecoveryDaemon({
      startupRecovery: Effect.sync(() => {
        order.push("startup");
      }),
      sweepRecovery: Effect.sync(() => {
        order.push("sweep");
      }),
    });
    const consumers = [
      makeConsumerLoopDaemon({
        consumerId: "verification",
        projectId: PROJECT,
        batchSize: 10,
        poll: Effect.sync(() => {
          order.push("poll:verification");
          return emptyConsumerResult;
        }),
      }),
      makeConsumerLoopDaemon({
        consumerId: "completion",
        projectId: PROJECT,
        batchSize: 10,
        poll: Effect.sync(() => {
          order.push("poll:completion");
          return emptyConsumerResult;
        }),
      }),
    ];
    const daemon = makeProductionDaemon({
      migrate: Effect.sync(() => {
        order.push("migrate");
      }),
      recovery,
      consumers,
    });

    await Effect.runPromise(daemon.start);
    expect(order).toEqual(["migrate", "startup"]);

    order.length = 0;
    await Effect.runPromise(daemon.recoveryTick);
    expect(order).toEqual(["sweep"]);

    order.length = 0;
    const results = await Effect.runPromise(daemon.pollConsumers);
    expect(order).toEqual(["poll:verification", "poll:completion"]);
    expect(results).toHaveLength(2);
  });

  it("drift watcher triggers a probe and is never a truth source", async () => {
    const seen: Array<string> = [];
    const watcher = makeDriftWatcherTrigger({
      probe: (projectId) =>
        Effect.sync(() => {
          seen.push(projectId);
          return { _tag: "NoDrift", atRevision: "3" } as DriftReport;
        }),
    });
    const report = await Effect.runPromise(watcher.trigger(PROJECT, []));
    expect(report._tag).toBe("NoDrift");
    expect(seen).toEqual([PROJECT]);
  });

  it("daemons bind the real recovery / consumer / drift functions", () => {
    const source = readTransport("daemons.ts");
    for (const wired of [
      "startupRecovery",
      "sweepRecovery",
      "pollOnce",
      "verificationConsumerLoop",
      "completionConsumerLoop",
      "probeDrift",
    ]) {
      expect(source.includes(wired), `daemons.ts: ${wired}`).toBe(true);
    }
    for (const forbidden of [
      "RecordEnvironmentChange",
      ".record(",
      "advanceAnchor",
    ]) {
      expect(source.includes(forbidden), `daemons.ts: ${forbidden}`).toBe(
        false,
      );
    }
    const recovery = recoveryDaemonFromPrincipal(HUMAN);
    expect(recovery.startup).toBeDefined();
    expect(recovery.sweep).toBeDefined();
  });
});
