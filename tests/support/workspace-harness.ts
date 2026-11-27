import { Effect, Layer } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  ClockLive,
  CommandStoreLive,
  DeliverableRepositoryLive,
  DomainEventJournalLive,
  ExecutionRepositoryLive,
  FormationProposalStoreLive,
  IdGeneratorLive,
  InboxProjectionStoreLive,
  layer,
  MessageStoreLive,
  ProjectRepositoryLive,
  SessionRepositoryLive,
  TransactionPortLive,
  WorkRepositoryLive,
  WorkspaceRepositoryLive,
  WorkWaitStoreLive,
} from "../../adapters/persistence-sqlite/src/index.js";
import {
  type CommandGateway,
  CommandGatewayLive,
  type CommandHandler,
  FenceStopCheckInertLive,
} from "../../packages/application/src/index.js";
import {
  Actor,
  CommandId,
  Principal,
  ProjectId,
  parse,
  SessionId,
  WorkspaceId,
} from "../../packages/domain/dist/index.js";
import {
  type FormationProposalStore,
  type FormationProposalStoreService,
  type InboxProjectionStore,
  type InboxProjectionStoreService,
  MessageStore,
  type MessageStoreService,
  type TransactionPort,
  type WorkRepository,
  type WorkRepositoryService,
  type WorkspaceRepository,
  type WorkspaceRepositoryService,
} from "../../packages/ports/src/index.js";
import {
  gatewayEventTypes,
  makeGovernanceCommandHandlers,
  makeGovernanceCommandRegistryLive,
  seedProjectViaGateway,
} from "./gateway-fixtures.js";
import { makeP41OptionalTestServices } from "./optional-test-services.js";

export const p6TestActor = parse(Actor)("user:gov");
export const p6TestPrincipal = parse(Principal)("user:gov");

export const p6Project = parse(ProjectId)(
  "prj_018f2b3c-4d5e-7abc-8def-0123456789c1",
);
export const p6RootWorkspace = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789c1",
);
export const p6RootSession = parse(SessionId)(
  "ses_018f2b3c-4d5e-7abc-8def-0123456789c1",
);
export const p6SeedCommandId = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789c1",
);

/** P6 governance command set (the shared record/send/steer triple; the P7
 * harness adds DeliverMessage on top through the same shared factory). */
export const makeP6CommandHandlers = (dependencies: {
  readonly proposals: FormationProposalStoreService;
  readonly inbox: InboxProjectionStoreService;
  readonly messages: MessageStoreService;
  readonly workspaces: WorkspaceRepositoryService;
  readonly works: WorkRepositoryService;
}): ReadonlyArray<CommandHandler<unknown, unknown>> =>
  makeGovernanceCommandHandlers(dependencies);

const workspaceCommandHandlerRegistry = makeGovernanceCommandRegistryLive({
  includeDeliverMessage: false,
});

/** sqlite infra; tests run `runMigrations(P6_MIGRATIONS)` first (P1 pattern).
 * Exposes the P6 stores + TransactionPort so test bodies can seed directly. */
export const makeP6App = (
  filename = ":memory:",
): Layer.Layer<
  | CommandGateway
  | SqlClient
  | TransactionPort
  | FormationProposalStore
  | MessageStore
  | InboxProjectionStore
  | WorkspaceRepository
  | WorkRepository
> => {
  const base = layer({ filename });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const journal = Layer.provide(DomainEventJournalLive, infra);
  const registry = Layer.provide(
    workspaceCommandHandlerRegistry,
    Layer.mergeAll(
      Layer.provide(TransactionPortLive, infra),
      Layer.provide(ProjectRepositoryLive, infra),
      Layer.provide(WorkspaceRepositoryLive, infra),
      Layer.provide(WorkRepositoryLive, infra),
      Layer.provide(SessionRepositoryLive, infra),
      Layer.provide(ExecutionRepositoryLive, infra),
      Layer.provide(WorkWaitStoreLive, infra),
      Layer.provide(DeliverableRepositoryLive, infra),
      Layer.provide(FormationProposalStoreLive, infra),
      Layer.provide(MessageStoreLive, infra),
      Layer.provide(InboxProjectionStoreLive, infra),
    ),
  );
  const gatewayDeps = Layer.mergeAll(
    infra,
    registry,
    journal,
    makeP41OptionalTestServices(Layer.merge(infra, journal)),
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(CommandStoreLive, infra),
    Layer.provide(FormationProposalStoreLive, infra),
    Layer.provide(MessageStoreLive, infra),
    Layer.provide(InboxProjectionStoreLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(WorkRepositoryLive, infra),
    FenceStopCheckInertLive,
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
  >;
};

export const runP6 = <A, R>(
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

export const p6SeedProject = Effect.gen(function* () {
  yield* seedProjectViaGateway({
    name: "p6",
    projectId: p6Project,
    rootWorkspaceId: p6RootWorkspace,
    sessionId: p6RootSession,
    commandId: p6SeedCommandId,
    actor: p6TestActor,
    principal: p6TestPrincipal,
  });
});

export const p6EventTypes = gatewayEventTypes;

void MessageStore;
