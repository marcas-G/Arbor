import {
  type CommandHandler,
  CommandHandlerRegistry,
  makeAcceptWorkOutcomeHandler,
  makeCancelConversationResponseHandler,
  makeCompleteWorkHandler,
  makeConcludeVerificationHandler,
  makeDeclareDependencyHandler,
  makeGrantPermissionHandler,
  makeP1CommandHandlers,
  makeP15CommandHandlers,
  makeProduceDeliverableHandler,
  makeRecordDecisionHandler,
  makeRecordVerificationEvidenceHandler,
  makeResolveControlApprovalHandler,
  makeResumeConversationResponseHandler,
  makeRevokePermissionHandler,
  makeSatisfyDependencyHandler,
  makeSelectCurrentWorkHandler,
  makeSendMessageHandler,
  makeStartVerificationHandler,
  makeSteerWorkHandler,
  makeSubmitHumanMessageHandler,
} from "@arbor/application";
import type { ProjectId } from "@arbor/domain";
import { makeP2CommandHandlers } from "@arbor/execution-runtime";
import { repositoryFailure } from "@arbor/persistence-sqlite";
import {
  AcceptanceRepository,
  type AcceptanceRepositoryService,
  AssignWorkTargetBindingRepository,
  type AssignWorkTargetBindingRepositoryService,
  Clock,
  ControlApprovalStore,
  type ControlApprovalStoreService,
  ConversationResponseJobStore,
  type ConversationResponseJobStoreService,
  DeliverableRepository,
  DependencyRepository,
  type DependencyRepositoryService,
  EnvironmentRevisionStore,
  EvidenceRepository,
  ExecutionRepository,
  FormationFulfillmentStore,
  FormationProposalStore,
  type FormationProposalStoreService,
  HumanMessageStore,
  type HumanMessageStoreService,
  InboxProjectionStore,
  type InboxProjectionStoreService,
  MessageStore,
  type MessageStoreService,
  PermissionGrantRepository,
  type PermissionGrantRepositoryService,
  ProjectRepository,
  ProjectResourceProfilePort,
  SessionRepository,
  VerificationRepository,
  type VerificationRepositoryService,
  WorkRepository,
  WorkspaceRepository,
  WorkspaceResourceActivationStore,
  WorkWaitStore,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

/**
 * The slice's command handler registry: P1 commands (CreateProject /
 * CreateChildWorkspace / AssignWork) + P2 runtime commands (AdmitExecution /
 * StopExecution / SettleExecution) + SelectCurrentWork (P5) + the frozen
 * Human-actionable governance set (P13 `02` §2: RecordDecision / SteerWork /
 * AcceptWorkOutcome / GrantPermission / RevokePermission — handlers are the
 * frozen P6/P8/P12 implementations; only the composition wiring is new).
 * No new command semantics (P5 `01` / P13 `01`).
 */
export const SingleWorkspaceCommandHandlerRegistryLive: Layer.Layer<
  CommandHandlerRegistry,
  never,
  | ProjectRepository
  | WorkspaceRepository
  | SessionRepository
  | WorkRepository
  | DependencyRepository
  | DeliverableRepository
  | EnvironmentRevisionStore
  | EvidenceRepository
  | ExecutionRepository
  | WorkWaitStore
  | FormationProposalStore
  | InboxProjectionStore
  | MessageStore
  | VerificationRepository
  | AcceptanceRepository
  | PermissionGrantRepository
  | HumanMessageStore
  | ConversationResponseJobStore
  | SqlClient
> = Layer.effect(
  CommandHandlerRegistry,
  Effect.gen(function* () {
    const projects = yield* ProjectRepository;
    const workspaces = yield* WorkspaceRepository;
    const sessions = yield* SessionRepository;
    const activations = yield* Effect.serviceOption(
      WorkspaceResourceActivationStore,
    );
    const projectResourceProfiles = yield* Effect.serviceOption(
      ProjectResourceProfilePort,
    );
    const works = yield* WorkRepository;
    const clock = yield* Effect.serviceOption(Clock);
    const executions = yield* ExecutionRepository;
    const workWaits = yield* WorkWaitStore;
    const proposals = yield* FormationProposalStore;
    const fulfillments = yield* Effect.serviceOption(FormationFulfillmentStore);
    const inbox = yield* InboxProjectionStore;
    const messages = yield* MessageStore;
    const verifications = yield* VerificationRepository;
    const acceptances = yield* AcceptanceRepository;
    const grants = yield* PermissionGrantRepository;
    const assignWorkBindings = yield* Effect.serviceOption(
      AssignWorkTargetBindingRepository,
    );
    const humanMessages = yield* HumanMessageStore;
    const responseJobs = yield* ConversationResponseJobStore;
    const controlApprovals = yield* Effect.serviceOption(ControlApprovalStore);
    const dependencyStore = yield* DependencyRepository;
    const deliverables = yield* DeliverableRepository;
    const environmentRevisions = yield* EnvironmentRevisionStore;
    const evidence = yield* EvidenceRepository;
    const sql = yield* SqlClient;
    const handlers: ReadonlyArray<CommandHandler<unknown, unknown>> = [
      ...makeP1CommandHandlers({
        ...(Option.isSome(clock) ? { clock: clock.value } : {}),
        projects,
        workspaces,
        sessions,
        ...(Option.isSome(activations)
          ? { activations: activations.value }
          : {}),
        works,
        ...(Option.isSome(projectResourceProfiles)
          ? { projectResourceProfiles: projectResourceProfiles.value }
          : {}),
        executions,
        ...(Option.isSome(assignWorkBindings)
          ? {
              bindings: assignWorkBindings.value as Pick<
                AssignWorkTargetBindingRepositoryService,
                "insert"
              >,
            }
          : {}),
        grants,
        ...(Option.isSome(controlApprovals)
          ? { approvals: controlApprovals.value }
          : {}),
      }),
      ...makeP15CommandHandlers({
        projects,
        executions,
        responseJobs,
        inbox,
      }),
      makeSelectCurrentWorkHandler({
        workspaces,
        works,
        executions,
      }) as unknown as CommandHandler<unknown, unknown>,
      ...makeP2CommandHandlers({
        projects,
        workspaces,
        sessions,
        executions,
        workWaits,
      }),
      makeSendMessageHandler({
        workspaces,
        messages: messages as Pick<
          MessageStoreService,
          "append" | "closeCorrelation" | "isCorrelationClosed"
        >,
        inbox: inbox as Pick<InboxProjectionStoreService, "admitUpsert">,
      }) as unknown as CommandHandler<unknown, unknown>,
      makeDeclareDependencyHandler({
        works,
        workspaces,
        dependencies: dependencyStore as Pick<
          DependencyRepositoryService,
          "insert"
        >,
      }) as unknown as CommandHandler<unknown, unknown>,
      makeProduceDeliverableHandler({
        works,
        deliverables,
      }) as unknown as CommandHandler<unknown, unknown>,
      makeSatisfyDependencyHandler({
        dependencies: dependencyStore,
        deliverables,
        works,
      }) as unknown as CommandHandler<unknown, unknown>,
      makeRecordDecisionHandler({
        proposals: proposals as Pick<
          FormationProposalStoreService,
          "findById" | "decideIfPendingRevision"
        >,
        inbox: inbox as Pick<
          InboxProjectionStoreService,
          "admitUpsert" | "markConsumed"
        >,
        ...(Option.isSome(fulfillments)
          ? { fulfillments: fulfillments.value }
          : {}),
        originatingWorkspaceOf: (record) => record.parentWorkspaceId,
      }) as unknown as CommandHandler<unknown, unknown>,
      ...(Option.isSome(controlApprovals)
        ? [
            makeResolveControlApprovalHandler({
              approvals: controlApprovals.value as Pick<
                ControlApprovalStoreService,
                "findById" | "decide"
              >,
              inbox: inbox as Pick<InboxProjectionStoreService, "markConsumed">,
            }) as unknown as CommandHandler<unknown, unknown>,
          ]
        : []),
      makeSteerWorkHandler({
        works,
        inbox: inbox as Pick<InboxProjectionStoreService, "admitUpsert">,
      }) as unknown as CommandHandler<unknown, unknown>,
      makeAcceptWorkOutcomeHandler({
        works,
        verifications: verifications as Pick<
          VerificationRepositoryService,
          "findById"
        >,
        acceptances: acceptances as Pick<
          AcceptanceRepositoryService,
          "insert" | "findByWorkRevision"
        >,
      }) as unknown as CommandHandler<unknown, unknown>,
      makeCompleteWorkHandler({
        works,
        workspaces,
        verifications,
        acceptances,
      }) as unknown as CommandHandler<unknown, unknown>,
      makeStartVerificationHandler({
        works,
        verifications,
        environmentRevisions,
        deliverables: {
          ...deliverables,
          listArtifacts: (deliverableId) =>
            sql
              .unsafe<{ readonly role: string; readonly artifact_id: string }>(
                "SELECT role, artifact_id FROM deliverable_artifacts WHERE deliverable_id = ?",
                [deliverableId],
              )
              .pipe(
                Effect.map((rows) =>
                  rows.map((row) => ({
                    role: row.role,
                    artifactId: row.artifact_id as never,
                  })),
                ),
                Effect.mapError(
                  repositoryFailure("DeliverableRepository", "list-artifacts"),
                ),
              ),
        },
      }) as unknown as CommandHandler<unknown, unknown>,
      makeRecordVerificationEvidenceHandler({
        verifications,
        evidence,
      }) as unknown as CommandHandler<unknown, unknown>,
      makeConcludeVerificationHandler({
        verifications,
        evidence,
        works,
      }) as unknown as CommandHandler<unknown, unknown>,
      makeGrantPermissionHandler({
        grants: grants as PermissionGrantRepositoryService,
      }) as unknown as CommandHandler<unknown, unknown>,
      makeRevokePermissionHandler({
        grants: grants as PermissionGrantRepositoryService,
      }) as unknown as CommandHandler<unknown, unknown>,
      makeSubmitHumanMessageHandler({
        messages: humanMessages as Pick<
          HumanMessageStoreService,
          "insertPending" | "findById"
        >,
        responseJobs: responseJobs as Pick<
          ConversationResponseJobStoreService,
          "insert"
        >,
        inbox: inbox as Pick<InboxProjectionStoreService, "admitUpsert">,
        rootWorkspaceOf: (projectId: ProjectId) =>
          projects
            .findById(projectId)
            .pipe(
              Effect.map((found) =>
                Option.isSome(found)
                  ? found.value.rootWorkspaceId
                  : (projectId as unknown as never),
              ),
            ),
      }) as unknown as CommandHandler<unknown, unknown>,
      makeResumeConversationResponseHandler({
        jobs: responseJobs,
      }) as unknown as CommandHandler<unknown, unknown>,
      makeCancelConversationResponseHandler({
        jobs: responseJobs,
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
