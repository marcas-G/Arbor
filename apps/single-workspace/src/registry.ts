import {
  type CommandHandler,
  CommandHandlerRegistry,
  type DecideSandboxPolicyPreparation,
  makeAcceptWorkOutcomeHandler,
  makeCancelConversationResponseHandler,
  makeCompleteWorkHandler,
  makeConcludeVerificationHandler,
  makeDecideSandboxPolicyHandler,
  makeDeclareDependencyHandler,
  makeDeliverMessageHandler,
  makeGrantPermissionHandler,
  makeP1CommandHandlers,
  makeP15CommandHandlers,
  makeProduceDeliverableHandler,
  makeRecordDecisionHandler,
  makeRecordVerificationEvidenceHandler,
  makeResolveControlApprovalHandler,
  makeResolveExecutableApprovalHandler,
  makeResumeConversationResponseHandler,
  makeRetryVerificationHandler,
  makeRevokePermissionHandler,
  makeSatisfyDependencyHandler,
  makeSelectCurrentWorkHandler,
  makeSendMessageHandler,
  makeStartVerificationHandler,
  makeSteerWorkHandler,
  makeSubmitHumanMessageHandler,
  type ParentUserGovernanceFacts,
} from "@arbor/application";
import type {
  ProjectId,
  SandboxPolicyAuthoritySnapshotV2,
} from "@arbor/domain";
import { makeP2CommandHandlers } from "@arbor/execution-runtime";
import { repositoryFailure } from "@arbor/persistence-sqlite";
import {
  AcceptanceRepository,
  type AcceptanceRepositoryService,
  AssignWorkTargetBindingRepository,
  type AssignWorkTargetBindingRepositoryService,
  BlobStorePort,
  Clock,
  ControlApprovalStore,
  type ControlApprovalStoreService,
  ConversationResponseJobStore,
  type ConversationResponseJobStoreService,
  DeliverableRepository,
  DependencyRepository,
  type DependencyRepositoryService,
  DomainEventJournal,
  EnvironmentRevisionStore,
  EvidenceRepository,
  ExecutableApprovalStore,
  type ExecutableApprovalStoreService,
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
  ResourceOwnershipRepository,
  RetryVerificationOriginRepository,
  SandboxPolicyDecisionStore,
  SessionRepository,
  VerificationRepository,
  type VerificationRepositoryService,
  WorkReadmissionGateStore,
  WorkRepository,
  WorkspaceRepository,
  WorkspaceResourceActivationStore,
  WorkWaitStore,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

const executableApprovalStoreUnavailable: ExecutableApprovalStoreService = {
  findByActionKey: () => Effect.succeed(Option.none()),
  findById: () => Effect.succeed(Option.none()),
  findPendingForExecution: () =>
    Effect.die(new Error("ExecutableApprovalStoreUnavailable")),
  putPendingExact: () =>
    Effect.die(new Error("ExecutableApprovalStoreUnavailable")),
  decide: () => Effect.succeed(Option.none()),
  listResolved: () => Effect.succeed([]),
  consumeApproved: () => Effect.succeed(false),
  expireDue: () => Effect.succeed([]),
  cancelForExecution: () => Effect.succeed([]),
};

/**
 * The slice's command handler registry: P1 commands (CreateProject /
 * CreateChildWorkspace / AssignWork) + P2 runtime commands (AdmitExecution /
 * StopExecution / SettleExecution) + SelectCurrentWork (P5) + the frozen
 * Human-actionable governance set (P13 `02` §2: RecordDecision / SteerWork /
 * AcceptWorkOutcome / GrantPermission / RevokePermission — handlers are the
 * frozen P6/P8/P12 implementations; only the composition wiring is new).
 * No new command semantics (P5 `01` / P13 `01`).
 */
export const makeSingleWorkspaceCommandHandlerRegistryLive = (
  governance: ParentUserGovernanceFacts = {
    authenticatedHumans: [],
    directParentOf: [],
  },
  sandboxPolicyGrantIssuerConfigSnapshot?: SandboxPolicyAuthoritySnapshotV2,
  sandboxPolicyDecisionPreparation?: DecideSandboxPolicyPreparation,
): Layer.Layer<
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
  | SandboxPolicyDecisionStore
  | ResourceOwnershipRepository
  | HumanMessageStore
  | ConversationResponseJobStore
  | SqlClient
> =>
  Layer.effect(
    CommandHandlerRegistry,
    Effect.gen(function* () {
      const projects = yield* ProjectRepository;
      const workspaces = yield* WorkspaceRepository;
      const resourceOwnership = yield* ResourceOwnershipRepository;
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
      const executableApprovalsService = yield* Effect.serviceOption(
        ExecutableApprovalStore,
      );
      const executableApprovals = Option.getOrElse(
        executableApprovalsService,
        () => executableApprovalStoreUnavailable,
      );
      const workWaits = yield* WorkWaitStore;
      const readmissionGate = yield* Effect.serviceOption(
        WorkReadmissionGateStore,
      );
      const proposals = yield* FormationProposalStore;
      const fulfillments = yield* Effect.serviceOption(
        FormationFulfillmentStore,
      );
      const inbox = yield* InboxProjectionStore;
      const messages = yield* MessageStore;
      const verifications = yield* VerificationRepository;
      const retryOriginsOption = yield* Effect.serviceOption(
        RetryVerificationOriginRepository,
      );
      const retryOrigins = Option.getOrElse(retryOriginsOption, () => ({
        insertOrigin: () =>
          Effect.die(new Error("RetryVerificationOriginRepositoryUnavailable")),
      }));
      const acceptances = yield* AcceptanceRepository;
      const grants = yield* PermissionGrantRepository;
      const sandboxPolicyDecisions = yield* SandboxPolicyDecisionStore;
      const assignWorkBindings = yield* Effect.serviceOption(
        AssignWorkTargetBindingRepository,
      );
      const humanMessages = yield* HumanMessageStore;
      const responseJobs = yield* ConversationResponseJobStore;
      const controlApprovals =
        yield* Effect.serviceOption(ControlApprovalStore);
      const dependencyStore = yield* DependencyRepository;
      const deliverables = yield* DeliverableRepository;
      const journal = yield* Effect.serviceOption(DomainEventJournal);
      const environmentRevisions = yield* EnvironmentRevisionStore;
      const evidence = yield* EvidenceRepository;
      const sql = yield* SqlClient;
      const blobStoreOption = yield* Effect.serviceOption(BlobStorePort);
      const blobs = Option.getOrElse(blobStoreOption, () => ({
        put: () =>
          Effect.fail({
            _tag: "BlobStoreError" as const,
            cause: "BlobStorePortUnavailable",
          }),
        get: () =>
          Effect.fail({
            _tag: "BlobStoreError" as const,
            cause: "BlobStorePortUnavailable",
          }),
      }));
      const verifierDeliverables = {
        ...deliverables,
        listArtifacts: (deliverableId: import("@arbor/domain").DeliverableId) =>
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
      };
      const verifierStart = {
        works,
        verifications,
        environmentRevisions,
        deliverables: verifierDeliverables,
      };
      const verifierConclude = {
        verifications,
        evidence,
        works,
        ...(Option.isSome(journal) ? { journal: journal.value } : {}),
      };
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
          resourceOwnership,
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
          executableApprovals,
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
          ...(Option.isSome(readmissionGate)
            ? { readmissionGate: readmissionGate.value }
            : {}),
          executableApprovals,
        }),
        makeSendMessageHandler({
          workspaces,
          messages: messages as Pick<
            MessageStoreService,
            "append" | "closeCorrelation" | "isCorrelationClosed"
          >,
          inbox: inbox as Pick<
            InboxProjectionStoreService,
            "admitUpsert" | "admitUpsertSequenced"
          >,
        }) as unknown as CommandHandler<unknown, unknown>,
        makeDeliverMessageHandler({
          deliverables,
          works,
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
                inbox: inbox as Pick<
                  InboxProjectionStoreService,
                  "markConsumed"
                >,
              }) as unknown as CommandHandler<unknown, unknown>,
            ]
          : []),
        makeResolveExecutableApprovalHandler({
          approvals: executableApprovals,
          executions,
          now: Option.isSome(clock)
            ? clock.value.now
            : () => Effect.sync(() => new Date().toISOString()),
        }) as unknown as CommandHandler<unknown, unknown>,
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
        makeStartVerificationHandler(
          verifierStart,
        ) as unknown as CommandHandler<unknown, unknown>,
        makeRecordVerificationEvidenceHandler({
          verifications,
          evidence,
        }) as unknown as CommandHandler<unknown, unknown>,
        makeConcludeVerificationHandler(
          verifierConclude,
        ) as unknown as CommandHandler<unknown, unknown>,
        makeRetryVerificationHandler({
          works,
          verifications,
          executions,
          projects,
          workspaces,
          origins: retryOrigins,
          ...(Option.isSome(journal) ? { journal: journal.value } : {}),
          clock: Option.getOrElse(clock, () => ({
            now: () => Effect.succeed(new Date().toISOString()),
          })),
          blobs,
          governance,
          start: verifierStart,
          conclude: verifierConclude,
        }) as unknown as CommandHandler<unknown, unknown>,
        makeGrantPermissionHandler({
          grants: grants as PermissionGrantRepositoryService,
          executions,
          ...(Option.isSome(clock) ? { clock: clock.value } : {}),
          ...(sandboxPolicyGrantIssuerConfigSnapshot === undefined
            ? {}
            : { sandboxPolicyGrantIssuerConfigSnapshot }),
        }) as unknown as CommandHandler<unknown, unknown>,
        makeDecideSandboxPolicyHandler({
          grants: grants as PermissionGrantRepositoryService,
          executions,
          decisions: sandboxPolicyDecisions,
          preparation: sandboxPolicyDecisionPreparation ?? {
            prepare: () =>
              Effect.fail({
                _tag: "TransactionOperationalFailure",
                cause: "sandbox policy decision preparation is unavailable",
              }),
            currentPreconditions: () =>
              Effect.die(
                new Error("sandbox policy preconditions are unavailable"),
              ),
            preIntentSourceStaleField: () => Effect.succeed(undefined),
          },
          clock: Option.getOrElse(clock, () => ({
            now: () => Effect.succeed(new Date().toISOString()),
          })),
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

/** Default test/composition fixture; production supplies its authenticated
 * Parent User governance snapshot through the parameterized factory. */
export const SingleWorkspaceCommandHandlerRegistryLive =
  makeSingleWorkspaceCommandHandlerRegistryLive();
