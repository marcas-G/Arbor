import { Effect, Layer } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  AcceptanceRepositoryLive,
  ClockLive,
  CommandStoreLive,
  DeliverableRepositoryLive,
  DependencyRepositoryLive,
  DomainEventJournalLive,
  EvidenceRepositoryLive,
  ExecutionRepositoryLive,
  FormationProposalStoreLive,
  IdGeneratorLive,
  InboxProjectionStoreLive,
  LeaseServiceLive,
  layer,
  MessageStoreLive,
  ProjectRepositoryLive,
  SchedulerTimerStoreLive,
  SessionRepositoryLive,
  ToolInvocationStoreLive,
  TransactionPortLive,
  VerificationRepositoryLive,
  WorkRepositoryLive,
  WorkspaceRepositoryLive,
  WorkWaitStoreLive,
} from "../../adapters/persistence-sqlite/src/index.js";
import {
  CommandGateway,
  CommandGatewayLive,
  type CommandHandler,
  type FenceStopCheck,
  FenceStopCheckInertLive,
  semanticRequestFingerprint,
} from "../../packages/application/src/index.js";
import {
  Actor,
  CommandId,
  Principal,
  ProjectId,
  parse,
  Revision,
  SessionId,
  WorkspaceId,
} from "../../packages/domain/dist/index.js";
import { runRecovery } from "../../packages/execution-runtime/src/index.js";
import {
  type AcceptanceRepository,
  type DeliverableRepository,
  type DeliverableRepositoryService,
  type DependencyRepository,
  type EvidenceRepository,
  type ExecutionRepository,
  type FormationProposalStore,
  type FormationProposalStoreService,
  type InboxProjectionStore,
  type InboxProjectionStoreService,
  MessageStore,
  type MessageStoreService,
  type SchedulerTimerStore,
  type TransactionPort,
  type VerificationRepository,
  type WorkRepository,
  type WorkRepositoryService,
  type WorkspaceRepository,
  type WorkspaceRepositoryService,
} from "../../packages/ports/src/index.js";
import { ReconciliationSourceLive } from "../../packages/tool-runtime/src/index.js";
import {
  gatewayEventTypes,
  makeGovernanceCommandHandlers,
  makeGovernanceCommandRegistryLive,
  seedProjectViaGateway,
} from "./gateway-fixtures.js";

export const p7TestActor = parse(Actor)("user:gov");
export const p7TestPrincipal = parse(Principal)("user:gov");

export const p7Project = parse(ProjectId)(
  "prj_018f2b3c-4d5e-7abc-8def-0123456789c1",
);
export const p7RootWorkspace = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789c1",
);
export const p7RootSession = parse(SessionId)(
  "ses_018f2b3c-4d5e-7abc-8def-0123456789c1",
);
export const p7SeedCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789c1",
);

/** P7 governance command set: the shared P6 triple plus DeliverMessage
 * (registered through the same shared factory). */
export const makeP7CommandHandlers = (dependencies: {
  readonly proposals: FormationProposalStoreService;
  readonly inbox: InboxProjectionStoreService;
  readonly messages: MessageStoreService;
  readonly workspaces: WorkspaceRepositoryService;
  readonly works: WorkRepositoryService;
  readonly deliverables: DeliverableRepositoryService;
}): ReadonlyArray<CommandHandler<unknown, unknown>> =>
  makeGovernanceCommandHandlers(dependencies);

const consumerCommandHandlerRegistry = makeGovernanceCommandRegistryLive({
  includeDeliverMessage: true,
});

/** sqlite infra; tests run `runMigrations(P8_MIGRATIONS)` first (P1 pattern).
 * Exposes the P6 stores + TransactionPort + the P9 recovery-drive stores
 * (scheduler timers) so test bodies can seed directly. */
export const makeP7App = (
  filename = ":memory:",
  fenceStopCheck: Layer.Layer<FenceStopCheck> = FenceStopCheckInertLive,
): Layer.Layer<
  | CommandGateway
  | SqlClient
  | TransactionPort
  | FormationProposalStore
  | MessageStore
  | InboxProjectionStore
  | WorkspaceRepository
  | WorkRepository
  | DependencyRepository
  | DeliverableRepository
  | ExecutionRepository
  | VerificationRepository
  | EvidenceRepository
  | AcceptanceRepository
  | SchedulerTimerStore
> => {
  const base = layer({ filename });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const registry = Layer.provide(
    consumerCommandHandlerRegistry,
    Layer.mergeAll(
      Layer.provide(TransactionPortLive, infra),
      Layer.provide(ProjectRepositoryLive, infra),
      Layer.provide(WorkspaceRepositoryLive, infra),
      Layer.provide(WorkRepositoryLive, infra),
      Layer.provide(SessionRepositoryLive, infra),
      Layer.provide(ExecutionRepositoryLive, infra),
      Layer.provide(WorkWaitStoreLive, infra),
      Layer.provide(FormationProposalStoreLive, infra),
      Layer.provide(MessageStoreLive, infra),
      Layer.provide(InboxProjectionStoreLive, infra),
      Layer.provide(DeliverableRepositoryLive, infra),
    ),
  );
  const gatewayDeps = Layer.mergeAll(
    infra,
    registry,
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(CommandStoreLive, infra),
    Layer.provide(DomainEventJournalLive, infra),
    Layer.provide(FormationProposalStoreLive, infra),
    Layer.provide(MessageStoreLive, infra),
    Layer.provide(InboxProjectionStoreLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(WorkRepositoryLive, infra),
    Layer.provide(DependencyRepositoryLive, infra),
    Layer.provide(DeliverableRepositoryLive, infra),
    Layer.provide(VerificationRepositoryLive, infra),
    Layer.provide(EvidenceRepositoryLive, infra),
    Layer.provide(AcceptanceRepositoryLive, infra),
    Layer.provide(ExecutionRepositoryLive, infra),
    Layer.provide(SchedulerTimerStoreLive, infra),
    Layer.provide(
      LeaseServiceLive,
      Layer.merge(infra, Layer.provide(ExecutionRepositoryLive, infra)),
    ),
    Layer.provide(ToolInvocationStoreLive, infra),
    Layer.provide(
      ReconciliationSourceLive,
      Layer.mergeAll(
        Layer.provide(ToolInvocationStoreLive, infra),
        Layer.provide(TransactionPortLive, infra),
      ),
    ),
    fenceStopCheck,
  );
  return Layer.mergeAll(
    gatewayDeps,
    Layer.provide(CommandGatewayLive, gatewayDeps),
  ) as Layer.Layer<
    | CommandGateway
    | SqlClient
    | TransactionPort
    | FormationProposalStore
    | MessageStore
    | InboxProjectionStore
    | WorkspaceRepository
    | WorkRepository
    | DependencyRepository
    | DeliverableRepository
    | ExecutionRepository
    | VerificationRepository
    | EvidenceRepository
    | AcceptanceRepository
    | SchedulerTimerStore
  >;
};

export const runP7 = <A, R>(
  program: Effect.Effect<A, unknown, CommandGateway | SqlClient | R>,
  app: Layer.Layer<CommandGateway | SqlClient>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        program as Effect.Effect<A, unknown, CommandGateway | SqlClient>,
        app,
      ),
    ),
  );

export const p7SeedProject = Effect.gen(function* () {
  yield* seedProjectViaGateway({
    name: "p6",
    projectId: p7Project,
    rootWorkspaceId: p7RootWorkspace,
    sessionId: p7RootSession,
    commandId: p7SeedCommandId,
    actor: p7TestActor,
    principal: p7TestPrincipal,
  });
});

export const p7EventTypes = gatewayEventTypes;

void MessageStore;

export { runRecovery };

/** Seeds one Open Work on the root workspace via the real AssignWork command. */
export const p7SeedWork = (
  workId: import("../../packages/domain/dist/index.js").WorkId,
  commandId: import("../../packages/domain/dist/index.js").CommandId,
  verificationMission?: import("../../packages/domain/dist/index.js").VerificationMission,
) =>
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    const { parse, WorkRevision } = yield* Effect.promise(
      () => import("../../packages/domain/dist/index.js"),
    );
    const payload = {
      workId,
      workspaceId: p7RootWorkspace,
      expectedWorkspaceRevision: parse(Revision)(0),
      objective: "p7",
      why: "seed",
      constraints: [],
      completionExpectation: "green",
      verificationMission: verificationMission ?? {
        goal: "g",
        criteria: [],
        riskRequirements: [],
      },
      provenance: { predecessorWorkId: null, reason: "seed" },
      revision: parse(WorkRevision)(0),
    };
    return yield* gateway.execute(
      {
        commandType: "AssignWork",
        commandId,
        projectId: p7Project,
        actor: p7TestActor,
        issuedAt: "t",
        payload,
      },
      { _tag: "External", principal: p7TestPrincipal },
      {
        _tag: "AssignWorkAuthority",
        principal: p7TestPrincipal,
        commandId,
        semanticRequestFingerprint: semanticRequestFingerprint({
          commandType: "AssignWork",
          projectId: p7Project,
          actor: p7TestActor,
          schemaVersion: "1",
          payload,
        }),
        projectId: p7Project,
        targetWorkspaceId: p7RootWorkspace,
      },
    );
  });
