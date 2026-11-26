import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  AcceptanceRepositoryLive,
  ClockLive,
  CommandStoreLive,
  ConversationResponseJobStoreLive,
  DeliverableRepositoryLive,
  DependencyRepositoryLive,
  DomainEventJournalLive,
  EnvironmentRevisionStoreLive,
  EvidenceRepositoryLive,
  ExecutionRepositoryLive,
  FormationProposalStoreLive,
  HumanMessageStoreLive,
  IdGeneratorLive,
  InboxProjectionStoreLive,
  layer,
  MessageStoreLive,
  PermissionGrantRepositoryLive,
  ProjectRepositoryLive,
  ResourceOwnershipRepositoryLive,
  SandboxPolicyDecisionStoreLive,
  SessionRepositoryLive,
  TransactionPortLive,
  VerificationRepositoryLive,
  WorkContractRevisionRepositoryLive,
  WorkRepositoryLive,
  WorkspaceRepositoryLive,
  WorkWaitStoreLive,
} from "../../adapters/persistence-sqlite/src/index.js";
import { SingleWorkspaceCommandHandlerRegistryLive } from "../../apps/single-workspace/src/registry.js";
import type { ViewQueryFace } from "../../apps/single-workspace/src/transport/index.js";
import type {
  TreeViewRes,
  ViewRequestMap,
  ViewResponseMap,
} from "../../packages/api-contracts/src/index.js";
import type {
  CommandGateway,
  CommandHandlerRegistry,
  ConsumerLoopResult,
  CreateProjectPayload,
} from "../../packages/application/src/index.js";
import {
  AuthorityResolverPort,
  AuthorityResolverPortLive,
  CommandGatewayLive,
  FenceStopCheckInertLive,
} from "../../packages/application/src/index.js";
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
  ResponsibilityRevision,
  Revision,
  responsibilityBound,
  SessionId,
  type ViewId,
  WorkspaceId,
} from "../../packages/domain/dist/index.js";
import type { ProjectionStale } from "../../packages/ports/src/errors.js";
import type {
  Clock,
  CommandStore,
  DomainEventJournal,
  ExecutionRepository,
  IdGenerator,
  MessageStore,
  PermissionGrantRepository,
  ProjectRepository,
  ResourceOwnershipRepository,
  SessionRepository,
  TransactionPort,
  VerificationRepository,
  WorkContractRevisionRepository,
  WorkRepository,
  WorkspaceRepository,
  WorkWaitStore,
} from "../../packages/ports/src/index.js";

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

export const repoRoot = join(import.meta.dirname, "..", "..");
export const transportDir = join(
  repoRoot,
  "apps",
  "single-workspace",
  "src",
  "transport",
);
export const readTransport = (file: string): string =>
  readFileSync(join(transportDir, file), "utf8");

export const SHELL_FILES = [
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

export const HUMAN = parse(Principal)("user:human");
export const AGENT = parse(Principal)("agent:worker");
export const PROJECT = parse(ProjectId)(
  "prj_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
export const WORKSPACE = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
export const SESSION = parse(SessionId)(
  "ses_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
export const COMMAND = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
export const STOP_COMMAND = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789ac",
);
export const EXECUTION = "exe_018f2b3c-4d5e-7abc-8def-0123456789ab";

export const treeDto: TreeViewRes = {
  nodes: [
    {
      workspaceId: WORKSPACE,
      parentWorkspaceId: null,
      name: "root",
      status: "executing",
      subtreeAttention: { attention: 1, actionRequired: 0 },
    },
  ],
};

export const treeResult: QueryResult<TreeViewRes> = {
  value: treeDto,
  watermark: 7,
  lag: 2,
};

export const staleError: ProjectionStale = {
  _tag: "ProjectionStale",
  code: "projection/stale",
  category: "stale",
  correlationId: "corr-1",
  retryDisposition: "retryable",
  safeDetails: { watermark: 1, lag: 5 },
};

export const stubViews = (): ViewQueryFace => ({
  query: (<V extends ViewId>(view: V, _request: ViewRequestMap[V]) =>
    view === "responsibility-tree"
      ? Effect.succeed(treeResult as unknown as QueryResult<ViewResponseMap[V]>)
      : Effect.fail(staleError)) as ViewQueryFace["query"],
});

export const createProjectPayload = (): CreateProjectPayload => ({
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
    resourceSelection: { _tag: "ConversationOnly" },
    agentBinding: responsibilityBound(WORKSPACE),
    workspacePolicy: makeWorkspacePolicy(),
    workspacePolicyRevision: parse(Revision)(0),
    revision: parse(Revision)(0),
  },
});

export const createProjectEnvelope = () => ({
  commandType: "CreateProject",
  commandId: COMMAND,
  projectId: PROJECT,
  actor: parse(Actor)("user:human"),
  issuedAt: "2026-09-22T00:00:00.000Z",
  payload: createProjectPayload() as unknown,
});

export const stopEnvelope = (actor: string) => ({
  commandType: "StopExecution",
  commandId: STOP_COMMAND,
  projectId: PROJECT,
  actor: parse(Actor)(actor),
  issuedAt: "2026-09-22T00:00:00.000Z",
  payload: { executionId: EXECUTION } as unknown,
});

export const projectGovernanceEnvelope = (
  commandType: "RenameProject" | "CloseProject",
  commandId: string,
  actor: string,
  expectedRevision: number,
  targetProjectId: ProjectId = PROJECT,
) => ({
  commandType,
  commandId: parse(CommandId)(commandId),
  projectId: targetProjectId,
  actor: parse(Actor)(actor),
  issuedAt: "2026-09-22T00:00:00.000Z",
  payload:
    commandType === "RenameProject"
      ? { name: "Arbor Next", expectedRevision }
      : { expectedRevision, confirmed: true },
});

// --- the composition root invokes the resolver; we count the invocations ---

export let resolverCalls = 0;

export const resetResolverCalls = (): void => {
  resolverCalls = 0;
};

export const innerResolver = Effect.runSync(
  Effect.provide(
    Effect.gen(function* () {
      return yield* AuthorityResolverPort;
    }),
    AuthorityResolverPortLive,
  ),
);

export const CountingResolverLive: Layer.Layer<AuthorityResolverPort> =
  Layer.succeed(AuthorityResolverPort, {
    ...innerResolver,
    resolve: (input) =>
      Effect.flatMap(
        Effect.sync(() => {
          resolverCalls += 1;
        }),
        () => innerResolver.resolve(input),
      ),
  });

type DbServices =
  | SqlClient
  | AuthorityResolverPort
  | CommandGateway
  | CommandHandlerRegistry
  | TransactionPort
  | ProjectRepository
  | ResourceOwnershipRepository
  | WorkspaceRepository
  | ExecutionRepository
  | WorkContractRevisionRepository
  | WorkRepository
  | MessageStore
  | PermissionGrantRepository
  | CommandStore
  | DomainEventJournal
  | SessionRepository
  | WorkWaitStore
  | VerificationRepository
  | Clock
  | IdGenerator;

export const makeApp = (databaseFile = ":memory:"): Layer.Layer<DbServices> => {
  const base = layer({ filename: databaseFile });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const deps = Layer.mergeAll(
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(CommandStoreLive, infra),
    Layer.provide(DomainEventJournalLive, infra),
    Layer.provide(ProjectRepositoryLive, infra),
    Layer.provide(ResourceOwnershipRepositoryLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(SessionRepositoryLive, infra),
    Layer.provide(WorkContractRevisionRepositoryLive, infra),
    Layer.provide(WorkRepositoryLive, infra),
    Layer.provide(ExecutionRepositoryLive, infra),
    Layer.provide(WorkWaitStoreLive, infra),
    Layer.provide(MessageStoreLive, infra),
    Layer.provide(PermissionGrantRepositoryLive, infra),
    Layer.provide(SandboxPolicyDecisionStoreLive, infra),
    // P14: the registry also wires SubmitHumanMessage (human chat-turn).
    Layer.provide(HumanMessageStoreLive, infra),
    Layer.provide(ConversationResponseJobStoreLive, infra),
    // P13: the external registry also wires the Human-actionable governance
    // handlers (RecordDecision/SteerWork/AcceptWorkOutcome/Grant/Revoke).
    Layer.provide(FormationProposalStoreLive, infra),
    Layer.provide(InboxProjectionStoreLive, infra),
    Layer.provide(VerificationRepositoryLive, infra),
    Layer.provide(AcceptanceRepositoryLive, infra),
    Layer.provide(DependencyRepositoryLive, infra),
    Layer.provide(DeliverableRepositoryLive, infra),
    Layer.provide(EnvironmentRevisionStoreLive, infra),
    Layer.provide(EvidenceRepositoryLive, infra),
  );
  const all = Layer.mergeAll(
    infra,
    deps,
    FenceStopCheckInertLive,
    Layer.provide(
      SingleWorkspaceCommandHandlerRegistryLive,
      Layer.mergeAll(deps, infra),
    ),
    CountingResolverLive,
  );
  return Layer.mergeAll(
    all,
    Layer.provide(CommandGatewayLive, all),
  ) as Layer.Layer<DbServices>;
};

export const run = <A>(
  program: Effect.Effect<A, unknown, DbServices>,
  databaseFile?: string,
): Promise<A> =>
  Effect.runPromise(Effect.provide(program, makeApp(databaseFile)));

export const countRows = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${table}`,
    );
    return Number(rows[0]?.count ?? 0);
  });

export const emptyConsumerResult: ConsumerLoopResult = {
  fromSequence: 0,
  lastSequence: 0,
  applied: 0,
  quarantined: 0,
  records: [],
};
