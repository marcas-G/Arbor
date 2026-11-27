import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { makeDeliverMessageHandler } from "../../packages/application/src/commands/deliver-message.js";
import { makeRecordDecisionHandler } from "../../packages/application/src/commands/record-decision.js";
import { makeSendMessageHandler } from "../../packages/application/src/commands/send-message.js";
import { makeSteerWorkHandler } from "../../packages/application/src/commands/steer-work.js";
import { CommandHandlerRegistry } from "../../packages/application/src/gateway.js";
import {
  CommandGateway,
  type CommandHandler,
  type CreateProjectPayload,
  makeP1CommandHandlers,
  semanticRequestFingerprint,
  type VerifiedCommandAuthority,
} from "../../packages/application/src/index.js";
import {
  type Actor,
  type CommandId,
  ContextEpochNumber,
  makeProjectPolicy,
  makeWorkspacePolicy,
  type Principal,
  type ProjectId,
  parse,
  ResponsibilityRevision,
  Revision,
  responsibilityBound,
  type SessionId,
  type WorkspaceId,
} from "../../packages/domain/dist/index.js";
import { makeP2CommandHandlers } from "../../packages/execution-runtime/src/index.js";
import {
  DeliverableRepository,
  type DeliverableRepositoryService,
  ExecutionRepository,
  FormationProposalStore,
  type FormationProposalStoreService,
  InboxProjectionStore,
  type InboxProjectionStoreService,
  MessageStore,
  type MessageStoreService,
  ProjectRepository,
  SessionRepository,
  WorkRepository,
  type WorkRepositoryService,
  WorkspaceRepository,
  type WorkspaceRepositoryService,
  WorkWaitStore,
} from "../../packages/ports/src/index.js";
import { NoHoldWorkReadmissionGateStoreService } from "../../packages/testkit/src/index.js";
import { ensureLegacyProjectResourceSourceFixture } from "./legacy-project-resource-source.js";

/** Single shared CreateProject seed behind the P1 (application-harness),
 * P6 (workspace-harness) and P7 (consumer-harness) gateway fixtures; the
 * three former copies were line-identical apart from ids and actor. */
export const seedProjectViaGateway = (args: {
  readonly name: string;
  readonly projectId: ProjectId;
  readonly rootWorkspaceId: WorkspaceId;
  readonly sessionId: SessionId;
  readonly commandId: CommandId;
  readonly actor: Actor;
  readonly principal: Principal;
}) =>
  Effect.gen(function* () {
    yield* ensureLegacyProjectResourceSourceFixture();
    const gateway = yield* CommandGateway;
    const payload: CreateProjectPayload = {
      name: args.name,
      revision: parse(Revision)(0),
      projectPolicy: makeProjectPolicy(),
      projectPolicyRevision: parse(Revision)(0),
      defaultConfiguration: {},
      environmentRef: "local",
      rootWorkspaceId: args.rootWorkspaceId,
      primarySession: {
        sessionId: args.sessionId,
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
        agentBinding: responsibilityBound(args.rootWorkspaceId),
        workspacePolicy: makeWorkspacePolicy(),
        workspacePolicyRevision: parse(Revision)(0),
        revision: parse(Revision)(0),
      },
    };
    const authority: VerifiedCommandAuthority = {
      _tag: "CreateProjectAuthority",
      principal: args.principal,
      commandId: args.commandId,
      semanticRequestFingerprint: semanticRequestFingerprint({
        commandType: "CreateProject",
        projectId: args.projectId,
        actor: args.actor,
        schemaVersion: "2",
        payload,
      }),
      projectId: args.projectId,
    };
    return yield* gateway.execute(
      {
        commandType: "CreateProject",
        commandId: args.commandId,
        projectId: args.projectId,
        actor: args.actor,
        issuedAt: "t",
        payload,
      },
      { _tag: "External", principal: args.principal },
      authority,
    );
  });

/** Ordered domain-event type list (formerly eventTypes/p6EventTypes/
 * p7EventTypes — three identical implementations). */
export const gatewayEventTypes = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{ event_type: string }>(
    "SELECT event_type FROM domain_events ORDER BY sequence",
  );
  return rows.map((row) => row.event_type);
});

/** Governance command set shared by the P6/P7 harnesses: P6 is the
 * record/send/steer triple, P7 adds DeliverMessage when `deliverables` is
 * provided (the P6 subset ignores it). */
export const makeGovernanceCommandHandlers = (dependencies: {
  readonly proposals: FormationProposalStoreService;
  readonly inbox: InboxProjectionStoreService;
  readonly messages: MessageStoreService;
  readonly workspaces: WorkspaceRepositoryService;
  readonly works: WorkRepositoryService;
  readonly deliverables?: DeliverableRepositoryService;
}): ReadonlyArray<CommandHandler<unknown, unknown>> => [
  makeRecordDecisionHandler({
    proposals: dependencies.proposals,
    inbox: dependencies.inbox,
    originatingWorkspaceOf: (record) => record.parentWorkspaceId,
  }) as unknown as CommandHandler<unknown, unknown>,
  makeSendMessageHandler({
    workspaces: dependencies.workspaces,
    messages: dependencies.messages,
    inbox: dependencies.inbox,
  }) as unknown as CommandHandler<unknown, unknown>,
  ...(dependencies.deliverables === undefined
    ? []
    : [
        makeDeliverMessageHandler({
          deliverables: dependencies.deliverables,
          works: dependencies.works,
          workspaces: dependencies.workspaces,
          messages: dependencies.messages,
          inbox: dependencies.inbox,
        }) as unknown as CommandHandler<unknown, unknown>,
      ]),
  makeSteerWorkHandler({
    works: dependencies.works,
    inbox: dependencies.inbox,
  }) as unknown as CommandHandler<unknown, unknown>,
];

/** P1 + P2 + governance handler registry shared by the P6/P7 harnesses;
 * the only per-harness choice is whether DeliverMessage is registered (P7)
 * or not (P6). */
export const makeGovernanceCommandRegistryLive = (options: {
  readonly includeDeliverMessage: boolean;
}): Layer.Layer<
  CommandHandlerRegistry,
  never,
  | ProjectRepository
  | WorkspaceRepository
  | SessionRepository
  | WorkRepository
  | ExecutionRepository
  | WorkWaitStore
  | FormationProposalStore
  | InboxProjectionStore
  | MessageStore
  | DeliverableRepository
> =>
  Layer.effect(
    CommandHandlerRegistry,
    Effect.gen(function* () {
      const projects = yield* ProjectRepository;
      const workspaces = yield* WorkspaceRepository;
      const sessions = yield* SessionRepository;
      const works = yield* WorkRepository;
      const executions = yield* ExecutionRepository;
      const workWaits = yield* WorkWaitStore;
      const proposals = yield* FormationProposalStore;
      const inbox = yield* InboxProjectionStore;
      const messages = yield* MessageStore;
      const deliverables = yield* DeliverableRepository;
      const handlers: ReadonlyArray<CommandHandler<unknown, unknown>> = [
        ...makeP1CommandHandlers({ projects, workspaces, sessions, works }),
        ...makeP2CommandHandlers({
          projects,
          workspaces,
          sessions,
          executions,
          readmissionGate: NoHoldWorkReadmissionGateStoreService,
          workWaits,
        }),
        ...makeGovernanceCommandHandlers({
          proposals,
          inbox,
          messages,
          workspaces,
          works,
          ...(options.includeDeliverMessage ? { deliverables } : {}),
        }),
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
