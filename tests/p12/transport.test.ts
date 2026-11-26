import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect } from "vitest";
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
} from "../../apps/single-workspace/src/transport/index.js";
import type {
  TreeViewRes,
  ViewRequestMap,
  ViewResponseMap,
} from "../../packages/api-contracts/src/index.js";
import {
  type CommandGateway,
  CommandGatewayLive,
  type CommandHandlerRegistry,
  type ConsumerLoopResult,
  type CreateProjectPayload,
  type DriftReport,
  FenceStopCheckInertLive,
} from "../../packages/application/dist/index.js";
import {
  type AuthorityResolverPort,
  AuthorityResolverPortLive,
} from "../../packages/application/src/authority-resolver.js";
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
  VIEW_IDS,
  type ViewId,
  WorkspaceId,
} from "../../packages/domain/dist/index.js";
import type { ProjectionStale } from "../../packages/ports/src/errors.js";
import type {
  Clock,
  CommandStore,
  ConversationResponseJobStore,
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
import {
  createSchema44CaseDatabase,
  HUMAN,
  ISSUED_AT,
  itWithCurrentAppTimeout,
} from "./support.js";

// ---------------------------------------------------------------------------
// story 11 (`10`): transport renders DTOs, forwards Commands, no canonical write
// ---------------------------------------------------------------------------

const transportProject = parse(ProjectId)(
  "prj_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
const transportWorkspace = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
const transportSession = parse(SessionId)(
  "ses_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
const transportCommand = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789ab",
);

const transportTreeDto: TreeViewRes = {
  nodes: [
    {
      workspaceId: transportWorkspace,
      parentWorkspaceId: null,
      name: "root",
      status: "executing",
      subtreeAttention: { attention: 1, actionRequired: 0 },
    },
  ],
};
const transportTreeResult: QueryResult<TreeViewRes> = {
  value: transportTreeDto,
  watermark: 7,
  lag: 2,
};
const transportStaleError: ProjectionStale = {
  _tag: "ProjectionStale",
  code: "projection/stale",
  category: "stale",
  correlationId: "corr-1",
  retryDisposition: "retryable",
  safeDetails: { watermark: 1, lag: 5 },
};
const transportViews = (): ViewQueryFace => ({
  query: (<V extends ViewId>(view: V, _request: ViewRequestMap[V]) =>
    view === "responsibility-tree"
      ? Effect.succeed(
          transportTreeResult as unknown as QueryResult<ViewResponseMap[V]>,
        )
      : Effect.fail(transportStaleError)) as ViewQueryFace["query"],
});

const transportCreateProjectPayload = (): CreateProjectPayload => ({
  name: "Arbor",
  revision: parse(Revision)(0),
  projectPolicy: makeProjectPolicy(),
  projectPolicyRevision: parse(Revision)(0),
  defaultConfiguration: {},
  environmentRef: "local",
  rootWorkspaceId: transportWorkspace,
  primarySession: {
    sessionId: transportSession,
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
    agentBinding: responsibilityBound(transportWorkspace),
    workspacePolicy: makeWorkspacePolicy(),
    workspacePolicyRevision: parse(Revision)(0),
    revision: parse(Revision)(0),
  },
});

const transportCreateEnvelope = () => ({
  commandType: "CreateProject",
  commandId: transportCommand,
  projectId: transportProject,
  actor: parse(Actor)(String(HUMAN)),
  issuedAt: ISSUED_AT,
  payload: transportCreateProjectPayload() as unknown,
});

type TransportDbServices =
  | SqlClient
  | AuthorityResolverPort
  | CommandGateway
  | CommandHandlerRegistry
  | TransactionPort
  | ProjectRepository
  | ResourceOwnershipRepository
  | WorkspaceRepository
  | ExecutionRepository
  | WorkRepository
  | WorkContractRevisionRepository
  | MessageStore
  | PermissionGrantRepository
  | CommandStore
  | DomainEventJournal
  | SessionRepository
  | WorkWaitStore
  | VerificationRepository
  | Clock
  | ConversationResponseJobStore
  | IdGenerator;

const transportApp = (
  databaseFile = ":memory:",
): Layer.Layer<TransportDbServices> => {
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
    Layer.provide(WorkRepositoryLive, infra),
    Layer.provide(WorkContractRevisionRepositoryLive, infra),
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
    AuthorityResolverPortLive,
  );
  return Layer.mergeAll(
    all,
    Layer.provide(CommandGatewayLive, all),
  ) as Layer.Layer<TransportDbServices>;
};

const transportRun = <A>(
  program: Effect.Effect<A, unknown, TransportDbServices>,
  databaseFile?: string,
): Promise<A> =>
  Effect.runPromise(Effect.provide(program, transportApp(databaseFile)));

describe("p12-acceptance story 11 — transport shells + daemons", () => {
  itWithCurrentAppTimeout(
    "story 11: shells render the frozen DTOs, forward Commands, hold no canonical write, and Search stays deferred",
    async () => {
      const core = makeTransportCore({
        views: transportViews(),
        authenticator: makeStaticAuthenticator({
          "human-token": HUMAN,
          "local-read-token": parse(Principal)("user:local"),
        }),
        submission: {
          submit: () =>
            Effect.succeed({
              ok: true as const,
              status: 200,
              body: {
                commandId: transportCommand,
                resolution: "Committed" as const,
              },
            }),
        },
      });
      const http = makeHttpShell(core);
      const ws = makeWebSocketShell(core);
      const cli = makeCliShell(core);
      const web = makeWebShell(core);

      const viaHttp = await Effect.runPromise(
        http.handle({
          method: "POST",
          path: "/views/responsibility-tree",
          authorization: "Bearer local-read-token",
          body: { projectId: transportProject },
        }),
      );
      const viaWs = await Effect.runPromise(
        ws.handleFrame({
          kind: "view",
          token: "local-read-token",
          view: "responsibility-tree",
          request: { projectId: transportProject },
        }),
      );
      const viaCli = await Effect.runPromise(
        cli.run([
          "view",
          "responsibility-tree",
          JSON.stringify({ projectId: transportProject }),
        ]),
      );
      for (const response of [viaHttp, viaWs, viaCli]) {
        expect(response.ok).toBe(true);
        if (response.ok) {
          expect(response.body).toEqual(transportTreeResult);
        }
      }
      const rendered = await Effect.runPromise(
        web.renderView("responsibility-tree", { projectId: transportProject }),
      );
      expect(rendered.html).toContain(JSON.stringify(transportTreeResult));

      const failure = await Effect.runPromise(
        http.handle({
          method: "POST",
          path: "/views/attention",
          authorization: "Bearer local-read-token",
          body: { projectId: transportProject },
        }),
      );
      expect(failure.ok).toBe(false);
      if (!failure.ok) {
        expect(Object.keys(failure.problem).sort()).toEqual([
          "category",
          "code",
          "correlationId",
          "message",
          "retryDisposition",
          "safeDetails",
        ]);
      }

      const database = createSchema44CaseDatabase();
      const outcome = await (async () => {
        try {
          return await transportRun(
            Effect.gen(function* () {
              const submission = yield* makeExternalSubmissionFromServices({
                authenticatedHumans: [],
                directParentOf: [],
              });
              const dbCore = makeTransportCore({
                views: transportViews(),
                authenticator: makeStaticAuthenticator({
                  "human-token": HUMAN,
                }),
                submission,
              });
              const response = yield* dbCore.submitCommand(
                { token: "human-token" },
                transportCreateEnvelope(),
              );
              const sql = yield* SqlClient;
              const rows = yield* sql.unsafe<{ count: number }>(
                "SELECT COUNT(*) AS count FROM projects",
              );
              return { response, projects: Number(rows[0]?.count ?? 0) };
            }),
            database.databaseFilename,
          );
        } finally {
          database.cleanup();
        }
      })();
      expect(outcome.response.ok).toBe(true);
      expect(outcome.projects).toBe(1);

      expect(SEARCH_TRANSPORT_BINDING.implemented).toBe(false);
      expect(SEARCH_TRANSPORT_BINDING.owner).toBe("P10");
      expect(isViewId("search")).toBe(false);
      expect((VIEW_IDS as ReadonlyArray<string>).includes("search")).toBe(
        false,
      );

      const order: string[] = [];
      const emptyConsumer: ConsumerLoopResult = {
        fromSequence: 0,
        lastSequence: 0,
        applied: 0,
        quarantined: 0,
        records: [],
      };
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
          projectId: transportProject,
          batchSize: 10,
          poll: Effect.sync(() => {
            order.push("poll");
            return emptyConsumer;
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
      const watcher = makeDriftWatcherTrigger({
        probe: () =>
          Effect.succeed({ _tag: "NoDrift", atRevision: "3" } as DriftReport),
      });
      expect(
        (await Effect.runPromise(watcher.trigger(transportProject, [])))._tag,
      ).toBe("NoDrift");
      expect(recoveryDaemonFromPrincipal(HUMAN).startup).toBeDefined();
    },
  );
});
