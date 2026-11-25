import type {
  AgentActionHandler,
  AgentLoopQualificationProbe,
} from "@arbor/agent-runtime";
import { CommandGateway, CommandHandlerRegistry } from "@arbor/application";
import {
  AcceptanceRepository,
  AgentLoopStepStore,
  AssignWorkTargetBindingRepository,
  BlobStorePort,
  Clock,
  CommandStore,
  ControlApprovalStore,
  DecisionRequestStore,
  DeliverableRepository,
  DependencyRepository,
  DomainEventJournal,
  FormationFulfillmentStore,
  FormationProposalStore,
  IdGenerator,
  InboxProjectionStore,
  LocalPlanStore,
  MessageStore,
  PermissionGrantRepository,
  ProjectRepository,
  ProviderTurnStore,
  RecoveryAttentionFactStore,
  SessionRepository,
  ToolInvocationStore,
  TransactionPort,
  VerificationRepository,
  WorkBlockerStore,
  WorkRepository,
  WorkspacePlacementPort,
  WorkspaceRepository,
  WorkspaceSandboxAuthorizationStore,
  WorkWaitStore,
} from "@arbor/ports";
import { Context, Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  type AnyProducerEvidenceRequest,
  hasAnyProducerEvidence,
} from "./any-producer-evidence.js";
import {
  type ResolveWorkBlockerActionDependencies,
  resolveWorkBlockerHandler,
} from "./resolve-work-blocker-action.js";
import {
  type AssignWorkBindingAttentionQualificationProbe,
  type AssignWorkDependencies,
  assignWorkHandler,
} from "./control-actions/assign-work.js";
import {
  type DeliverActionDependencies,
  type DeliverReplayQualificationProbe,
  deliverMessageGatewayHandler,
} from "./control-actions/delivery.js";
import {
  type DeclareDependencyDependencies,
  type ProduceDeliverableDependencies,
  declareDependencyHandler,
  produceDeliverableHandler,
} from "./control-actions/dependency-deliverable.js";
import {
  type SendMessageDependencies,
  sendMessageHandler,
} from "./control-actions/send-message.js";
import {
  type VerificationWaitEligibilityDependencies,
  type VerificationActionDependencies,
  verificationWaitEligibilityHandler,
  recordVerificationEvidenceHandler,
  concludeVerificationHandler,
} from "./control-actions/verification.js";
import {
  type ClaimCompletionDependencies,
  type AcceptResultDependencies,
  type UpdatePlanDependencies,
  type SelectCurrentWorkDependencies,
  acceptResultHandler,
  updatePlanHandler,
  selectCurrentWorkHandler,
  claimCompletionHandler,
} from "./control-actions/work-lifecycle.js";
import {
  type WorkspacePlacementDependencies,
  type AllocateWorkspaceSandboxDependencies,
  type ProposeChildDependencies,
  allocateWorkspaceSandboxHandler,
  listWorkspacesHandler,
  readWorkspaceHandler,
  proposeChildWorkspaceHandler,
} from "./control-actions/workspace.js";

export {
  type AssignWorkBindingAttentionQualificationEvent,
  type AssignWorkBindingAttentionQualificationProbe,
  type AssignWorkDependencies,
  assignWorkHandler,
} from "./control-actions/assign-work.js";
export {
  type WorkspacePlacementDependencies,
  type AllocateWorkspaceSandboxDependencies,
  type ProposeChildDependencies,
  allocateWorkspaceSandboxHandler,
} from "./control-actions/workspace.js";
export {
  type ClaimCompletionDependencies,
  type AcceptResultDependencies,
  type UpdatePlanDependencies,
  type SelectCurrentWorkDependencies,
  acceptResultHandler,
  updatePlanHandler,
  selectCurrentWorkHandler,
} from "./control-actions/work-lifecycle.js";
export {
  type SendMessageDependencies,
} from "./control-actions/send-message.js";
export {
  type DeclareDependencyDependencies,
  type ProduceDeliverableDependencies,
  produceDeliverableHandler,
} from "./control-actions/dependency-deliverable.js";
export {
  type DeliverActionDependencies,
  type DeliverReplayQualificationEvent,
  type DeliverReplayQualificationProbe,
  deliverMessageGatewayHandler,
  deliverHandler,
} from "./control-actions/delivery.js";
export {
  type VerificationActionDependencies,
} from "./control-actions/verification.js";

export class SingleWorkspaceControlActionHandlers extends Context.Service<
  SingleWorkspaceControlActionHandlers,
  ReadonlyArray<AgentActionHandler>
>()("arbor/SingleWorkspaceControlActionHandlers") {}

export const makeSingleWorkspaceControlActionHandlers = (
  dependencies: SendMessageDependencies &
    AssignWorkDependencies &
    ClaimCompletionDependencies &
    ProposeChildDependencies &
    DeclareDependencyDependencies &
    ProduceDeliverableDependencies &
    Partial<Pick<UpdatePlanDependencies, "plans">> &
    Partial<Pick<SelectCurrentWorkDependencies, "decisions">> &
    Partial<WorkspacePlacementDependencies> &
    Partial<Pick<AllocateWorkspaceSandboxDependencies, "authorizations">> &
    Partial<Pick<AcceptResultDependencies, "acceptances">> &
    Partial<
      Pick<
        DeliverActionDependencies,
        | "deliverables"
        | "journal"
        | "ids"
        | "replayAttention"
        | "deliverReplayQualificationProbe"
      >
    > &
    Partial<
      Pick<
        VerificationActionDependencies,
        "verifications" | "sessions" | "toolInvocations"
      >
    > &
    Partial<{
      waitVerifications: VerificationWaitEligibilityDependencies["verifications"];
    }> &
    Partial<
      Pick<
        ResolveWorkBlockerActionDependencies,
        "blockers" | "loopSteps" | "providerTurns" | "ids" | "sessionWrites"
      >
    >,
): ReadonlyArray<AgentActionHandler> => {
  const handlers: AgentActionHandler[] = [
    sendMessageHandler(dependencies),
    assignWorkHandler(dependencies),
    claimCompletionHandler(dependencies),
    proposeChildWorkspaceHandler(dependencies),
    declareDependencyHandler(dependencies),
    produceDeliverableHandler(dependencies),
  ];
  if (
    dependencies.blockers !== undefined &&
    dependencies.loopSteps !== undefined &&
    dependencies.providerTurns !== undefined &&
    dependencies.sessions !== undefined &&
    dependencies.journal !== undefined &&
    dependencies.ids !== undefined &&
    dependencies.sessionWrites !== undefined
  ) {
    handlers.push(
      resolveWorkBlockerHandler({
        tx: dependencies.tx,
        blockers: dependencies.blockers,
        works: dependencies.works,
        loopSteps: dependencies.loopSteps,
        providerTurns: dependencies.providerTurns,
        sessionWrites: dependencies.sessionWrites,
        journal: dependencies.journal,
        clock: dependencies.clock,
        ids: dependencies.ids,
      }),
    );
  }
  if (dependencies.waitVerifications !== undefined) {
    handlers.push(
      verificationWaitEligibilityHandler({
        works: dependencies.works,
        workspaces: dependencies.workspaces,
        verifications: dependencies.waitVerifications,
        tx: dependencies.tx,
        blockedWaitEnabled: handlers.some(
          (handler) => handler.action === "ResolveWorkBlocker",
        ),
      }),
    );
  }
  const {
    plans,
    decisions,
    placement,
    deliverables,
    journal,
    ids,
    verifications,
    sessions,
    toolInvocations,
    loopSteps,
  } = dependencies;
  if (placement !== undefined) {
    handlers.push(
      listWorkspacesHandler({ placement }),
      readWorkspaceHandler({ placement }),
      acceptResultHandler({
        placement,
        gateway: dependencies.gateway,
        ...(dependencies.commandHandlerRegistry === undefined
          ? {}
          : { commandHandlerRegistry: dependencies.commandHandlerRegistry }),
        ...(dependencies.commandReceipts === undefined
          ? {}
          : { commandReceipts: dependencies.commandReceipts }),
        ...(dependencies.acceptances === undefined
          ? {}
          : { acceptances: dependencies.acceptances }),
        works: dependencies.works,
        tx: dependencies.tx,
        clock: dependencies.clock,
      }),
    );
    if (
      dependencies.authorizations !== undefined &&
      dependencies.commandHandlerRegistry !== undefined &&
      dependencies.commandReceipts !== undefined
    )
      handlers.push(
        allocateWorkspaceSandboxHandler({
          gateway: dependencies.gateway,
          commandHandlerRegistry: dependencies.commandHandlerRegistry,
          commandReceipts: dependencies.commandReceipts,
          workspaces: dependencies.workspaces,
          authorizations: dependencies.authorizations,
          placement,
          clock: dependencies.clock,
          tx: dependencies.tx,
        }),
      );
  }
  if (
    deliverables !== undefined &&
    journal !== undefined &&
    ids !== undefined
  ) {
    handlers.push(
      deliverMessageGatewayHandler({
        gateway: dependencies.gateway,
        ...(dependencies.commandHandlerRegistry === undefined
          ? {}
          : { commandHandlerRegistry: dependencies.commandHandlerRegistry }),
        ...(dependencies.commandReceipts === undefined
          ? {}
          : { commandReceipts: dependencies.commandReceipts }),
        deliverables,
        journal,
        ids,
        works: dependencies.works,
        workspaces: dependencies.workspaces,
        messages: dependencies.messages,
        inbox: dependencies.inbox,
        ...(dependencies.replayAttention === undefined
          ? {}
          : { replayAttention: dependencies.replayAttention }),
        ...(dependencies.deliverReplayQualificationProbe === undefined
          ? {}
          : {
              deliverReplayQualificationProbe:
                dependencies.deliverReplayQualificationProbe,
            }),
        clock: dependencies.clock,
        tx: dependencies.tx,
      }),
    );
  }
  if (plans !== undefined) {
    handlers.push(updatePlanHandler({ ...dependencies, plans }));
  }
  if (decisions !== undefined) {
    handlers.push(selectCurrentWorkHandler({ ...dependencies, decisions }));
  }
  if (
    verifications !== undefined &&
    sessions !== undefined &&
    toolInvocations !== undefined
  ) {
    const verificationDependencies: VerificationActionDependencies = {
      ...dependencies,
      verifications,
      sessions,
      toolInvocations,
      ...(loopSteps === undefined ? {} : { loopSteps }),
    };
    if (loopSteps !== undefined)
      handlers.push(
        recordVerificationEvidenceHandler(
          verificationDependencies as VerificationActionDependencies & {
            readonly loopSteps: NonNullable<
              VerificationActionDependencies["loopSteps"]
            >;
          },
        ),
      );
    handlers.push(concludeVerificationHandler(verificationDependencies));
  }
  return handlers;
};

export interface SingleWorkspaceControlActionQualificationProbes {
  readonly bindingAttention?: AssignWorkBindingAttentionQualificationProbe;
  readonly assignWorkAuthorizedBeforeCommand?: AgentLoopQualificationProbe;
  readonly deliverReplay?: DeliverReplayQualificationProbe;
}

const makeSingleWorkspaceControlActionHandlersLayer = (
  qualificationProbes: SingleWorkspaceControlActionQualificationProbes = {},
): Layer.Layer<
  SingleWorkspaceControlActionHandlers,
  never,
  | CommandGateway
  | CommandHandlerRegistry
  | CommandStore
  | DependencyRepository
  | AcceptanceRepository
  | BlobStorePort
  | Clock
  | FormationProposalStore
  | InboxProjectionStore
  | MessageStore
  | AgentLoopStepStore
  | TransactionPort
  | WorkRepository
  | LocalPlanStore
  | DecisionRequestStore
  | DeliverableRepository
  | DomainEventJournal
  | IdGenerator
  | WorkWaitStore
  | WorkspaceRepository
  | SessionRepository
  | ToolInvocationStore
  | VerificationRepository
> =>
  Layer.effect(
    SingleWorkspaceControlActionHandlers,
    Effect.gen(function* () {
      const gateway = yield* CommandGateway;
      const commandHandlerRegistry = yield* CommandHandlerRegistry;
      const commandReceipts = yield* CommandStore;
      const dependencyRecords = yield* DependencyRepository;
      const acceptances = yield* AcceptanceRepository;
      const blobs = yield* BlobStorePort;
      const clock = yield* Clock;
      const messages = yield* MessageStore;
      const tx = yield* TransactionPort;
      const works = yield* WorkRepository;
      const plans = yield* LocalPlanStore;
      const decisions = yield* DecisionRequestStore;
      const deliverables = yield* DeliverableRepository;
      const journal = yield* DomainEventJournal;
      const ids = yield* IdGenerator;
      const waits = yield* WorkWaitStore;
      const workspaces = yield* WorkspaceRepository;
      const proposals = yield* FormationProposalStore;
      const projects = yield* Effect.serviceOption(ProjectRepository);
      const sql = yield* Effect.serviceOption(SqlClient);
      const fulfillments = yield* Effect.serviceOption(
        FormationFulfillmentStore,
      );
      const placement = yield* Effect.serviceOption(WorkspacePlacementPort);
      const workspaceAuthorizations = yield* Effect.serviceOption(
        WorkspaceSandboxAuthorizationStore,
      );
      const inbox = yield* InboxProjectionStore;
      const verifications = yield* VerificationRepository;
      const toolInvocations = yield* ToolInvocationStore;
      const loopSteps = yield* AgentLoopStepStore;
      const blockers = yield* Effect.serviceOption(WorkBlockerStore);
      const sessions = yield* SessionRepository;
      const providerTurns = yield* Effect.serviceOption(ProviderTurnStore);
      const assignWorkBindings = yield* Effect.serviceOption(
        AssignWorkTargetBindingRepository,
      );
      const bindingAttention = yield* Effect.serviceOption(
        RecoveryAttentionFactStore,
      );
      const permissionGrants = yield* Effect.serviceOption(
        PermissionGrantRepository,
      );
      const controlApprovals =
        yield* Effect.serviceOption(ControlApprovalStore);
      return SingleWorkspaceControlActionHandlers.of(
        makeSingleWorkspaceControlActionHandlers({
          gateway,
          commandHandlerRegistry,
          commandReceipts,
          dependencyRecords,
          acceptances,
          blobs,
          clock,
          messages,
          tx,
          works,
          plans,
          decisions,
          deliverables,
          journal,
          ids,
          waits,
          workspaces,
          proposals,
          ...(Option.isSome(fulfillments)
            ? { fulfillments: fulfillments.value }
            : {}),
          ...(Option.isSome(projects) &&
          Option.isSome(fulfillments) &&
          Option.isSome(sql)
            ? {
                anyProducerEvidence: (request: AnyProducerEvidenceRequest) =>
                  hasAnyProducerEvidence(
                    {
                      projects: projects.value,
                      workspaces,
                      listWorkspaceIdsByProject: (projectId) =>
                        Effect.map(
                          sql.value.unsafe<{ workspace_id: string }>(
                            "SELECT workspace_id FROM workspaces WHERE project_id = ? ORDER BY workspace_id",
                            [projectId],
                          ),
                          (rows) =>
                            rows.map((row) => row.workspace_id as never),
                        ),
                      works,
                      proposals,
                      fulfillments: fulfillments.value,
                      deliverables,
                      tx,
                    },
                    request,
                  ),
              }
            : {}),
          ...(Option.isSome(placement) ? { placement: placement.value } : {}),
          ...(Option.isSome(workspaceAuthorizations)
            ? { authorizations: workspaceAuthorizations.value }
            : {}),
          inbox,
          verifications,
          waitVerifications: verifications,
          sessions,
          sessionWrites: sessions,
          ...(Option.isSome(blockers) ? { blockers: blockers.value } : {}),
          toolInvocations,
          loopSteps,
          ...(Option.isSome(providerTurns)
            ? { providerTurns: providerTurns.value }
            : {}),
          ...(Option.isSome(assignWorkBindings)
            ? { bindings: assignWorkBindings.value }
            : {}),
          ...(Option.isSome(bindingAttention)
            ? { bindingAttention: bindingAttention.value }
            : {}),
          ...(Option.isSome(bindingAttention)
            ? { replayAttention: bindingAttention.value }
            : {}),
          ...(Option.isSome(permissionGrants)
            ? { grants: permissionGrants.value }
            : {}),
          ...(Option.isSome(controlApprovals)
            ? { approvals: controlApprovals.value }
            : {}),
          ...(qualificationProbes.bindingAttention === undefined
            ? {}
            : {
                bindingAttentionQualificationProbe:
                  qualificationProbes.bindingAttention,
              }),
          ...(qualificationProbes.assignWorkAuthorizedBeforeCommand ===
          undefined
            ? {}
            : {
                assignWorkAuthorizedBeforeCommandProbe:
                  qualificationProbes.assignWorkAuthorizedBeforeCommand,
              }),
          ...(qualificationProbes.deliverReplay === undefined
            ? {}
            : {
                deliverReplayQualificationProbe:
                  qualificationProbes.deliverReplay,
              }),
        }),
      );
    }),
  );

export const SingleWorkspaceControlActionHandlersLive =
  makeSingleWorkspaceControlActionHandlersLayer();

export const SingleWorkspaceControlActionHandlersWithBindingAttentionProbe = (
  probe: AssignWorkBindingAttentionQualificationProbe,
) =>
  makeSingleWorkspaceControlActionHandlersLayer({
    bindingAttention: probe,
  });

export const SingleWorkspaceControlActionHandlersWithQualificationProbes = (
  probes: SingleWorkspaceControlActionQualificationProbes,
) => makeSingleWorkspaceControlActionHandlersLayer(probes);
