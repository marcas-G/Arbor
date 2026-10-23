import type {
  AttentionRes,
  InboxViewRes,
  ViewRequestMap,
  ViewResponseMap,
  WorkspaceDetailRes,
} from "@arbor/api-contracts";
import type {
  AuthorityDecisionInput,
  AuthorityResolverPortService,
  CanonicalAuthorityFacts,
  CommandGatewayService,
  CommandHandlerError,
  CommandHandlerRegistryService,
  CommandRejection,
  CriticalSteerActiveMain,
  CriticalSteerPreparation,
  DecodedExternalCommandEnvelope,
  GatewayEnvelope,
  ParentUserGovernanceFacts,
  RegisteredCommandType,
  SteerWorkPayload,
} from "@arbor/application";
import {
  AuthorityResolverPort,
  activateWorkspaceBoundary,
  CommandGateway,
  CommandHandlerRegistry,
  CommandInputContractRegistry,
  decodeExternalCommand,
  deliverWakeSignal,
  semanticRequestFingerprint,
} from "@arbor/application";
import type {
  CommandId,
  CommandReceipt,
  ExecutionId,
  PermissionGrant,
  Principal,
  ProjectId,
  ProjectPolicy,
  QueryResult,
  SandboxPolicyAuthoritySnapshotV2,
  SandboxPolicyGrantIssuerProvenanceV1,
  VerificationId,
  ViewId,
  WorkId,
  WorkspaceId,
  WorkspacePolicy,
} from "@arbor/domain";
import {
  decodeCanonicalSandboxPolicyDecisionCommittedInternalV1,
  executionEpisode,
  makeProjectPolicy,
  sandboxPolicyCommittedViewOf,
} from "@arbor/domain";
import type {
  ProjectionQueryError,
  ProjectionQueryPortService,
} from "@arbor/ports";
import {
  AttentionProjectionStore,
  Clock,
  ExecutableApprovalStore,
  ExecutionRepository,
  ExecutionScheduler,
  IdGenerator,
  InboxProjectionStore,
  OwnershipWriteService,
  PermissionGrantRepository,
  ProjectEnvironmentPort,
  ProjectRepository,
  ResourceOwnershipRepository,
  RetryVerificationOriginRepository,
  sha256Hex,
  TransactionPort,
  VerificationRepository,
  WorkBlockerStore,
  WorkRepository,
  WorkspaceRepository,
  WorkspaceResourceActivationStore,
  WorkWaitStore,
} from "@arbor/ports";
import { reconcileProjectActivationAttention } from "@arbor/projection-runtime";
import { Effect, Option } from "effect";
import type {
  CommandReceiptView,
  ExternalSubmissionPort,
  ViewQueryFace,
} from "./contracts.js";
import {
  authorityDeniedProblem,
  failureResponse,
  invalidCommandPayloadProblem,
  problemFromCommandFailure,
  problemFromUnknownFailure,
} from "./errors.js";

/**
 * P12 `10` §3 (composition root). The composition root — NOT the transport —
 * loads `canonicalFacts` / `grants`, invokes the Authority Resolver, and only
 * then submits the exact-bound fact through the `CommandGateway`. The transport
 * hands over the authenticated principal + raw submission context and holds no
 * resolver capability.
 */

export interface AuthorityInputs {
  readonly canonicalFacts: CanonicalAuthorityFacts;
  readonly grants: ReadonlyArray<PermissionGrant>;
  readonly governance: ParentUserGovernanceFacts;
  readonly policy: ProjectPolicy | WorkspacePolicy;
  readonly sandboxPolicyGrantIssuerConfigSnapshot?: SandboxPolicyAuthoritySnapshotV2;
  readonly sandboxPolicyAuthorityNow?: string;
  readonly sandboxPolicyGrantIssuerProvenance?: SandboxPolicyGrantIssuerProvenanceV1;
}

/** The view face is the frozen `ProjectionQueryPort` binding (P10 `05` §1);
 * the transport renders whatever DTO it returns, unchanged. */
export const viewQueryFaceFromPort = (
  port: ProjectionQueryPortService,
): ViewQueryFace => ({
  query: <V extends ViewId>(
    view: V,
    request: ViewRequestMap[V],
    barrier?: import("@arbor/domain").FreshnessRequirement,
    _principal?: Principal,
  ): Effect.Effect<QueryResult<ViewResponseMap[V]>, ProjectionQueryError> =>
    port.query<ViewRequestMap[V], ViewResponseMap[V]>(view, request, barrier),
});

/** Read-only P10 affordance projection. It reuses the exact RetryVerification
 * AuthorityResolver with canonical repository facts, but never invokes the
 * Gateway or persists an authority/approval. */
export const viewQueryFaceWithRetryAvailability = (
  port: ProjectionQueryPortService,
  resolver: AuthorityResolverPortService,
  loadInputs: (
    envelope: DecodedExternalCommandEnvelope,
  ) => Effect.Effect<AuthorityInputs, never>,
  listUnboundLegacyInbox: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<
    ReadonlyArray<
      import("@arbor/ports").RetryVerificationUnboundLegacyInboxProjection
    >,
    never
  > = () => Effect.succeed([]),
): ViewQueryFace => {
  const base = viewQueryFaceFromPort(port);
  const canReadUnboundLegacy = (
    principal: Principal,
    projection: import("@arbor/ports").RetryVerificationUnboundLegacyInboxProjection,
  ): Effect.Effect<boolean, never> => {
    const envelope = {
      commandType: "RetryVerification",
      commandId: projection.commandId,
      projectId: projection.projectId,
      actor: principal as unknown as import("@arbor/domain").Actor,
      issuedAt: "1970-01-01T00:00:00.000Z",
      payload: {
        workId: projection.sourceWorkId,
        verificationId: projection.sourceVerificationId,
        expectedWorkRevision: 0,
        summaryContent: "read-only Inbox route check",
        successorVerificationId: projection.sourceVerificationId,
        verifierExecutionId: "exe_unbound-inbox-read" as never,
        workspaceId: projection.ownerWorkspaceId,
      },
    } as unknown as DecodedExternalCommandEnvelope;
    return Effect.map(loadInputs(envelope), (inputs) => {
      const facts = inputs.canonicalFacts;
      const work = facts.work;
      const workspace = facts.workspace;
      const human =
        principal.startsWith("user:") ||
        inputs.governance.authenticatedHumans.includes(principal);
      if (
        !human ||
        facts.projectId !== projection.projectId ||
        facts.project?.rootWorkspaceId !== projection.rootWorkspaceId ||
        work === undefined ||
        work.workId !== projection.sourceWorkId ||
        work.projectId !== projection.projectId ||
        work.workspaceId !== projection.ownerWorkspaceId ||
        workspace === undefined ||
        workspace.workspaceId !== projection.ownerWorkspaceId ||
        workspace.projectId !== projection.projectId
      ) {
        return false;
      }
      if (work.workspaceId === facts.project.rootWorkspaceId) {
        return (
          projection.recipientWorkspaceId === facts.project.rootWorkspaceId
        );
      }
      return (
        workspace.parentWorkspaceId === projection.recipientWorkspaceId &&
        inputs.governance.directParentOf.some(
          (edge) =>
            edge.workspaceId === projection.ownerWorkspaceId &&
            edge.parentPrincipal === principal,
        )
      );
    });
  };
  const filterUnboundLegacy = <
    R extends {
      readonly entryKey: string;
      readonly target?: { readonly kind: string } | undefined;
    },
  >(
    rows: ReadonlyArray<R>,
    principal: Principal | undefined,
    projections: ReadonlyArray<
      import("@arbor/ports").RetryVerificationUnboundLegacyInboxProjection
    >,
  ): Effect.Effect<ReadonlyArray<R>, never> =>
    Effect.map(
      Effect.forEach(rows, (entry) => {
        if (entry.target?.kind !== "RetryVerificationUnboundLegacy") {
          return Effect.succeed(entry);
        }
        if (principal === undefined) return Effect.succeed(undefined);
        const target = entry.target as unknown as {
          readonly commandId: string;
          readonly projectId: string;
          readonly sourceWorkId: string;
          readonly sourceVerificationId: string;
          readonly disposition: string;
          readonly reasonCode: string;
          readonly createdAt: string;
          readonly revision: number;
          readonly updatedAt: string;
        };
        const projection = projections.find(
          (candidate) => candidate.commandId === target.commandId,
        );
        if (
          projection === undefined ||
          target.projectId !== projection.projectId ||
          target.sourceWorkId !== projection.sourceWorkId ||
          target.sourceVerificationId !== projection.sourceVerificationId ||
          target.disposition !== projection.disposition ||
          target.reasonCode !== projection.reasonCode ||
          target.createdAt !== projection.createdAt ||
          target.revision !== projection.revision ||
          target.updatedAt !== projection.updatedAt
        ) {
          return Effect.succeed(undefined);
        }
        return Effect.map(
          canReadUnboundLegacy(principal, projection),
          (allowed) => (allowed ? entry : undefined),
        );
      }),
      (filtered) => filtered.filter((entry): entry is R => entry !== undefined),
    );
  const canRetry = (
    projectId: ProjectId,
    principal: Principal,
    row: AttentionRes["rows"][number],
  ): Effect.Effect<boolean, never> => {
    if (
      row.source !== "VerifierOrphan" ||
      row.workId === undefined ||
      row.verificationId === undefined ||
      row.targetWorkRevision === undefined
    ) {
      return Effect.succeed(false);
    }
    const payload = {
      workId: row.workId,
      verificationId: row.verificationId,
      expectedWorkRevision: row.targetWorkRevision,
    };
    const envelope = {
      commandType: "RetryVerification",
      commandId: "cmd_retry_preview" as CommandId,
      projectId,
      actor: principal as unknown as import("@arbor/domain").Actor,
      issuedAt: "1970-01-01T00:00:00.000Z",
      payload,
    } as DecodedExternalCommandEnvelope;
    const fingerprint = semanticRequestFingerprint({
      commandType: "RetryVerification",
      projectId,
      actor: String(principal),
      schemaVersion: "RetryVerification/availability-v1",
      payload,
    });
    const gatewayEnvelope: GatewayEnvelope<unknown> = envelope;
    return Effect.flatMap(loadInputs(envelope), (inputs) =>
      Effect.match(
        resolver.resolve({
          principal,
          submissionContext: { _tag: "External", principal },
          envelope: gatewayEnvelope,
          semanticRequestFingerprint: fingerprint,
          canonicalFacts: inputs.canonicalFacts,
          grants: inputs.grants,
          governance: inputs.governance,
          policy: inputs.policy,
        }),
        {
          onFailure: () => false,
          onSuccess: (fact) => fact._tag === "RetryVerificationAuthority",
        },
      ),
    );
  };

  return {
    query: <V extends ViewId>(
      view: V,
      request: ViewRequestMap[V],
      barrier?: import("@arbor/domain").FreshnessRequirement,
      principal?: Principal,
    ): Effect.Effect<QueryResult<ViewResponseMap[V]>, ProjectionQueryError> => {
      const rawResult = base.query(view, request, barrier);
      const result =
        view === "workspace-detail"
          ? Effect.flatMap(rawResult, (queryResult) =>
              Effect.flatMap(
                listUnboundLegacyInbox(
                  (request as ViewRequestMap["workspace-detail"]).workspaceId,
                ),
                (projections) =>
                  Effect.map(
                    filterUnboundLegacy(
                      (queryResult.value as WorkspaceDetailRes).inboxUnconsumed,
                      principal,
                      projections,
                    ),
                    (entries) =>
                      ({
                        ...queryResult,
                        value: {
                          ...(queryResult.value as WorkspaceDetailRes),
                          inboxUnconsumed: entries,
                        },
                      }) as unknown as QueryResult<ViewResponseMap[V]>,
                  ),
              ),
            )
          : view === "inbox-view"
            ? Effect.flatMap(rawResult, (queryResult) =>
                Effect.flatMap(
                  listUnboundLegacyInbox(
                    (request as ViewRequestMap["inbox-view"]).workspaceId,
                  ),
                  (projections) =>
                    Effect.map(
                      filterUnboundLegacy(
                        (queryResult.value as InboxViewRes).unconsumed,
                        principal,
                        projections,
                      ),
                      (entries) =>
                        ({
                          ...queryResult,
                          value: { unconsumed: entries },
                        }) as unknown as QueryResult<ViewResponseMap[V]>,
                    ),
                ),
              )
            : rawResult;
      if (view !== "attention" || principal === undefined) return result;
      const projectId = (request as ViewRequestMap["attention"]).projectId;
      return Effect.flatMap(result, (queryResult) => {
        const attention = queryResult.value as AttentionRes;
        return Effect.map(
          Effect.forEach(attention.rows, (row) =>
            Effect.map(canRetry(projectId, principal, row), (allowed) =>
              allowed
                ? { ...row, availableActions: ["RetryVerification"] as const }
                : row,
            ),
          ),
          (rows) =>
            ({
              ...queryResult,
              value: { ...attention, rows },
            }) as unknown as QueryResult<ViewResponseMap[V]>,
        );
      });
    },
  };
};

const payloadRecord = (payload: unknown): Record<string, unknown> =>
  typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)
    : {};

const payloadString = (payload: unknown, key: string): string | null => {
  const value = payloadRecord(payload)[key];
  return typeof value === "string" ? value : null;
};

export type AuthorityInputsServices =
  | TransactionPort
  | ProjectRepository
  | WorkspaceRepository
  | ExecutionRepository
  | WorkRepository
  | VerificationRepository
  | PermissionGrantRepository
  | Clock;

/** The production facts loader: repository snapshots + the `PermissionGrant`
 * store's active-only read (`02` §5.1). The resolver receives declared
 * snapshots only; the loader lives at the composition root. */
export const makeRepositoryInputsLoader = (
  governance: ParentUserGovernanceFacts,
  sandboxPolicyGrantIssuerConfigSnapshot?: SandboxPolicyAuthoritySnapshotV2,
): Effect.Effect<
  (
    envelope: DecodedExternalCommandEnvelope,
  ) => Effect.Effect<AuthorityInputs, never>,
  never,
  AuthorityInputsServices
> =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const projects = yield* ProjectRepository;
    const workspaces = yield* WorkspaceRepository;
    const executions = yield* ExecutionRepository;
    const works = yield* WorkRepository;
    const verifications = yield* VerificationRepository;
    const retryOrigins = yield* Effect.serviceOption(
      RetryVerificationOriginRepository,
    );
    const grants = yield* PermissionGrantRepository;
    const clock = yield* Clock;
    const executableApprovals = yield* Effect.serviceOption(
      ExecutableApprovalStore,
    );

    return (envelope: DecodedExternalCommandEnvelope) =>
      Effect.gen(function* () {
        const projectId = envelope.projectId;
        const payload = envelope.payload;
        const approvalId = payloadString(payload, "approvalId");
        const executableApproval =
          approvalId === null || Option.isNone(executableApprovals)
            ? Option.none()
            : yield* tx.transact(
                executableApprovals.value.findById(approvalId),
              );
        const workspaceId = (payloadString(payload, "workspaceId") ??
          payloadString(payload, "targetWorkspaceId") ??
          payloadString(payload, "parentWorkspaceId") ??
          (Option.isSome(executableApproval)
            ? executableApproval.value.workspaceId
            : null)) as WorkspaceId | null;
        const grantTargetsSandboxPolicy =
          envelope.commandType === "GrantPermission" &&
          payloadString(payload, "capability") === "DecideSandboxPolicy";
        const executionId = (payloadString(payload, "executionId") ??
          (grantTargetsSandboxPolicy
            ? payloadString(payload, "target")
            : null) ??
          (Option.isSome(executableApproval)
            ? executableApproval.value.executionId
            : null)) as ExecutionId | null;
        const workId = payloadString(payload, "workId") as WorkId | null;

        const workspace =
          workspaceId === null
            ? Option.none()
            : yield* tx.transact(workspaces.findById(workspaceId));
        const execution =
          executionId === null
            ? Option.none()
            : yield* tx.transact(executions.findById(executionId));
        const episodeRevision =
          executionId === null
            ? Option.none()
            : yield* tx.transact(executions.findEpisodeRevision(executionId));
        const work =
          workId === null
            ? Option.none()
            : yield* tx.transact(works.findById(workId));
        const verificationId = payloadString(
          payload,
          "verificationId",
        ) as VerificationId | null;
        const verification =
          verificationId === null ||
          envelope.commandType !== "RetryVerification"
            ? Option.none()
            : yield* tx.transact(verifications.findById(verificationId));
        const retryOrigin =
          envelope.commandType === "RetryVerification" &&
          Option.isSome(retryOrigins)
            ? yield* tx.transact(
                retryOrigins.value.findOrigin(envelope.commandId),
              )
            : Option.none();
        const verifierExecutions =
          Option.isSome(verification) &&
          envelope.commandType === "RetryVerification"
            ? yield* Effect.forEach(
                verification.value.verificationExecutionIds,
                (id) =>
                  Effect.gen(function* () {
                    const execution = yield* tx.transact(
                      executions.findById(id),
                    );
                    const bound = yield* tx.transact(
                      verifications.findByExecutionId(id),
                    );
                    return {
                      executionId: id,
                      projectId: Option.isSome(execution)
                        ? execution.value.projectId
                        : projectId,
                      workspaceId: Option.isSome(execution)
                        ? execution.value.workspaceId
                        : (verification.value.ownerWorkspaceId ??
                          ("" as WorkspaceId)),
                      status: Option.isSome(execution)
                        ? execution.value.state.status
                        : ("Missing" as const),
                      executionBound:
                        Option.isSome(execution) &&
                        execution.value.binding._tag ===
                          "ExecutionBoundAgentBinding",
                      boundToVerification:
                        Option.isSome(bound) &&
                        bound.value.verificationId ===
                          verification.value.verificationId,
                    };
                  }),
              )
            : [];
        const project = yield* tx.transact(projects.findById(projectId));
        const activeGrants = yield* tx.transact(grants.activeGrants(projectId));
        const sandboxPolicyAuthorityNow =
          sandboxPolicyGrantIssuerConfigSnapshot !== undefined &&
          (grantTargetsSandboxPolicy ||
            String(envelope.commandType) === "DecideSandboxPolicy")
            ? yield* clock.now()
            : undefined;
        const requestedSandboxExecutionId =
          envelope.commandType === "DecideSandboxPolicy"
            ? (payloadString(payload, "executionId") as ExecutionId | null)
            : null;
        const resolverGrantCandidates =
          requestedSandboxExecutionId === null
            ? []
            : activeGrants.filter(
                (grant) =>
                  grant.state === "Active" &&
                  grant.subject?._tag === "HumanPrincipal" &&
                  String(grant.subject.principal) === String(envelope.actor) &&
                  grant.capability === "DecideSandboxPolicy" &&
                  grant.target === requestedSandboxExecutionId,
              );
        const selectedResolverGrant =
          resolverGrantCandidates.length === 1
            ? resolverGrantCandidates[0]
            : undefined;
        const sandboxPolicyGrantIssuerProvenance =
          selectedResolverGrant !== undefined
            ? (Option.getOrUndefined(
                yield* tx.transact(
                  grants.findSandboxPolicyGrantIssuerProvenanceByGrantId(
                    selectedResolverGrant.permissionGrantId,
                  ),
                ),
              ) ?? undefined)
            : undefined;
        const exactEpisodeBinding = Option.isSome(execution)
          ? executionEpisode(execution.value)
          : undefined;

        const canonicalFacts: CanonicalAuthorityFacts = {
          projectId,
          ...(Option.isSome(project)
            ? { project: { rootWorkspaceId: project.value.rootWorkspaceId } }
            : {}),
          ...(Option.isSome(workspace)
            ? {
                workspace: {
                  workspaceId: workspace.value.workspaceId,
                  projectId: workspace.value.projectId,
                  parentWorkspaceId: workspace.value.parentWorkspaceId,
                },
              }
            : {}),
          ...(Option.isSome(execution)
            ? {
                execution: {
                  executionId: execution.value.executionId,
                  projectId: execution.value.projectId,
                  workspaceId: execution.value.workspaceId,
                  status: execution.value.state.status,
                  ...(exactEpisodeBinding === undefined
                    ? {}
                    : { episodeBinding: exactEpisodeBinding }),
                  ...(Option.isSome(episodeRevision)
                    ? { episodeRevision: episodeRevision.value }
                    : {}),
                },
              }
            : {}),
          ...(Option.isSome(work)
            ? {
                work: {
                  workId: work.value.workId,
                  projectId: work.value.projectId,
                  workspaceId: work.value.workspaceId,
                  lifecycle: work.value.lifecycle,
                  revision: work.value.revision,
                },
              }
            : {}),
          ...(Option.isSome(verification)
            ? {
                retryVerification: {
                  verificationId: verification.value.verificationId,
                  workId: verification.value.workId,
                  targetWorkRevision: verification.value.targetWorkRevision,
                  state: verification.value.state.status,
                  ownerWorkspaceId:
                    verification.value.ownerWorkspaceId ?? ("" as WorkspaceId),
                  verifierExecutions,
                },
              }
            : {}),
          ...(Option.isSome(retryOrigin)
            ? { retryVerificationOrigin: retryOrigin.value }
            : {}),
          ...(Option.isSome(executableApproval)
            ? {
                executableApproval: {
                  approvalId: executableApproval.value.approvalId,
                  projectId: executableApproval.value.projectId,
                  workspaceId: executableApproval.value.workspaceId,
                  executionId: executableApproval.value.executionId,
                  state: executableApproval.value.state,
                  revision: executableApproval.value.revision,
                },
              }
            : {}),
        };
        return {
          canonicalFacts,
          grants: activeGrants,
          governance,
          ...(sandboxPolicyGrantIssuerConfigSnapshot === undefined
            ? {}
            : { sandboxPolicyGrantIssuerConfigSnapshot }),
          ...(sandboxPolicyAuthorityNow === undefined
            ? {}
            : { sandboxPolicyAuthorityNow }),
          ...(sandboxPolicyGrantIssuerProvenance === undefined
            ? {}
            : { sandboxPolicyGrantIssuerProvenance }),
          policy: Option.isSome(project)
            ? project.value.projectPolicy
            : makeProjectPolicy({}),
        };
      }).pipe(Effect.orDie);
  });

export interface ExternalSubmissionDeps {
  readonly resolver: AuthorityResolverPortService;
  readonly gateway: CommandGatewayService;
  readonly registry: CommandHandlerRegistryService;
  readonly loadInputs: (
    envelope: DecodedExternalCommandEnvelope,
  ) => Effect.Effect<AuthorityInputs, never>;
  /** Read-only active-main selector used only after the Gateway's advisory
   * receipt miss for Critical Steer preparation. */
  readonly findActiveMainByWorkspace?: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<CriticalSteerActiveMain | null, never>;
  readonly afterCommitted?: (
    envelope: DecodedExternalCommandEnvelope,
  ) => Effect.Effect<void, unknown>;
  readonly afterGatewayCommitBeforeCreateProjectActivation?: (
    envelope: DecodedExternalCommandEnvelope,
  ) => Effect.Effect<void, unknown>;
}

export interface CreateProjectPostCommitBeforeActivationQualificationEvent {
  readonly commandId: string;
  readonly projectId: DecodedExternalCommandEnvelope["projectId"];
  readonly workspaceId: WorkspaceId;
}

/** Test-only process-local boundary after Gateway commit and before P11 entry. */
export type CreateProjectPostCommitBeforeActivationQualificationProbe = (
  event: CreateProjectPostCommitBeforeActivationQualificationEvent,
) => Promise<void>;

const receiptToView = (
  receipt: CommandReceipt<unknown, CommandRejection>,
  commandType?: string,
): CommandReceiptView =>
  receipt.resolution._tag === "Committed"
    ? {
        commandId: receipt.commandId,
        resolution: "Committed",
        result:
          commandType === "DecideSandboxPolicy"
            ? (() => {
                const decoded =
                  decodeCanonicalSandboxPolicyDecisionCommittedInternalV1(
                    JSON.stringify(receipt.resolution.result),
                    sha256Hex,
                  );
                if (decoded === undefined) {
                  throw new Error(
                    "committed sandbox policy receipt failed strict view projection",
                  );
                }
                return sandboxPolicyCommittedViewOf(decoded);
              })()
            : receipt.resolution.result,
      }
    : {
        commandId: receipt.commandId,
        resolution: "TerminalRejected",
        rejection: receipt.resolution.error._tag,
      };

const isActiveResourceOverlapFailure = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const record = error as Record<string, unknown>;
  return (
    record._tag === "PersistenceConstraintViolation" &&
    record.repository === "ResourceOwnershipRepository" &&
    record.operation === "insert-active-claim" &&
    record.constraint === "active-resource-overlap"
  );
};

export const makeExternalSubmission = (
  deps: ExternalSubmissionDeps,
): ExternalSubmissionPort => ({
  submit: (principal: Principal, submissionContext, rawEnvelope) =>
    Effect.gen(function* () {
      const decoded = decodeExternalCommand(rawEnvelope);
      if (!decoded.ok) {
        const rawCommandType = payloadString(rawEnvelope, "commandType");
        const safeCommandType =
          rawCommandType !== null &&
          CommandInputContractRegistry.lookup(rawCommandType) !== undefined
            ? (rawCommandType as RegisteredCommandType)
            : undefined;
        return failureResponse(
          invalidCommandPayloadProblem({
            ...(safeCommandType !== undefined
              ? { commandType: safeCommandType }
              : {}),
            issues: decoded.issues,
          }),
        );
      }
      const envelope = decoded.value;
      const handler = deps.registry.lookup(envelope.commandType);
      if (Option.isNone(handler)) {
        return failureResponse(
          invalidCommandPayloadProblem({
            commandType: envelope.commandType,
            issues: [{ path: ["commandType"], rule: "unsupported-command" }],
          }),
        );
      }
      const gatewayEnvelopeBase: GatewayEnvelope<unknown> = {
        commandType: envelope.commandType,
        commandId: envelope.commandId,
        projectId: envelope.projectId,
        actor: envelope.actor,
        issuedAt: envelope.issuedAt,
        payload: envelope.payload,
      };
      const fingerprint = semanticRequestFingerprint({
        commandType: envelope.commandType,
        projectId: envelope.projectId,
        actor: envelope.actor,
        schemaVersion: handler.value.schemaVersion,
        payload: envelope.payload,
      });
      if (String(envelope.actor) !== String(principal)) {
        return failureResponse(
          authorityDeniedProblem("principal/actor-mismatch"),
        );
      }
      const inputContract = CommandInputContractRegistry.lookup(
        envelope.commandType,
      );
      if (inputContract === undefined || !inputContract.externalOriginAllowed) {
        return failureResponse(
          authorityDeniedProblem(`UnsupportedOrigin:${envelope.commandType}`),
        );
      }
      const inputs = yield* deps.loadInputs(envelope);
      const prepareCriticalSteerStop =
        envelope.commandType === "SteerWork" &&
        envelope.payload.steer.severity === "Critical"
          ? (
              payload: SteerWorkPayload,
              context: typeof submissionContext,
              selectedMain?: CriticalSteerActiveMain,
            ): Effect.Effect<CriticalSteerPreparation, CommandHandlerError> =>
              Effect.gen(function* () {
                let activeMain: CriticalSteerActiveMain | null | undefined =
                  selectedMain;
                if (activeMain === undefined) {
                  const findActiveMain = deps.findActiveMainByWorkspace;
                  if (findActiveMain === undefined) {
                    return {
                      _tag: "Unavailable",
                    } satisfies CriticalSteerPreparation;
                  }
                  activeMain = yield* findActiveMain(payload.workspaceId);
                }
                if (activeMain === null || activeMain === undefined) {
                  return {
                    _tag: "NoActiveMain",
                  } satisfies CriticalSteerPreparation;
                }
                if (
                  activeMain.projectId !== envelope.projectId ||
                  activeMain.workspaceId !== payload.workspaceId
                ) {
                  return {
                    _tag: "AuthorityDenied",
                    reason:
                      "StopExecution target is not the current Workspace active main",
                  } satisfies CriticalSteerPreparation;
                }
                const stopPayload = { executionId: activeMain.executionId };
                const stopEnvelope: GatewayEnvelope<typeof stopPayload> = {
                  commandType: "StopExecution",
                  commandId: envelope.commandId,
                  projectId: envelope.projectId,
                  actor: envelope.actor,
                  issuedAt: envelope.issuedAt,
                  payload: stopPayload,
                };
                const stopHandler = deps.registry.lookup("StopExecution");
                if (Option.isNone(stopHandler)) {
                  return {
                    _tag: "Unavailable",
                  } satisfies CriticalSteerPreparation;
                }
                const stopFingerprint = semanticRequestFingerprint({
                  commandType: "StopExecution",
                  projectId: envelope.projectId,
                  actor: envelope.actor,
                  schemaVersion: stopHandler.value.schemaVersion,
                  payload: stopPayload,
                });
                const stopDecision: AuthorityDecisionInput = {
                  principal,
                  submissionContext: context,
                  envelope: stopEnvelope,
                  semanticRequestFingerprint: stopFingerprint,
                  canonicalFacts: {
                    ...inputs.canonicalFacts,
                    execution: {
                      executionId: activeMain.executionId,
                      projectId: activeMain.projectId,
                      workspaceId: activeMain.workspaceId,
                      status: "Active",
                    },
                  },
                  grants: inputs.grants,
                  governance: inputs.governance,
                  policy: inputs.policy,
                  ...(inputs.sandboxPolicyGrantIssuerConfigSnapshot ===
                  undefined
                    ? {}
                    : {
                        sandboxPolicyGrantIssuerConfigSnapshot:
                          inputs.sandboxPolicyGrantIssuerConfigSnapshot,
                      }),
                  ...(inputs.sandboxPolicyAuthorityNow === undefined
                    ? {}
                    : {
                        sandboxPolicyAuthorityNow:
                          inputs.sandboxPolicyAuthorityNow,
                      }),
                  ...(inputs.sandboxPolicyGrantIssuerProvenance === undefined
                    ? {}
                    : {
                        sandboxPolicyGrantIssuerProvenance:
                          inputs.sandboxPolicyGrantIssuerProvenance,
                      }),
                };
                const stopResolved = yield* Effect.match(
                  deps.resolver.resolve(stopDecision),
                  {
                    onFailure: (error) => ({ _tag: "denied" as const, error }),
                    onSuccess: (fact) => ({ _tag: "fact" as const, fact }),
                  },
                );
                if (stopResolved._tag === "denied") {
                  return {
                    _tag: "AuthorityDenied",
                    reason: `${stopResolved.error._tag}:StopExecution`,
                  } satisfies CriticalSteerPreparation;
                }
                const authority = stopResolved.fact;
                if (
                  authority._tag !== "StopExecutionAuthority" ||
                  authority.submissionOrigin !== "External" ||
                  authority.principal !== principal ||
                  authority.commandId !== envelope.commandId ||
                  authority.semanticRequestFingerprint !== stopFingerprint ||
                  authority.projectId !== envelope.projectId ||
                  authority.executionId !== activeMain.executionId
                ) {
                  return {
                    _tag: "AuthorityDenied",
                    reason:
                      "StopExecution authority did not bind the selected active main",
                  } satisfies CriticalSteerPreparation;
                }
                return {
                  _tag: "Ready",
                  executionId: activeMain.executionId,
                  authority,
                } satisfies CriticalSteerPreparation;
              })
          : undefined;
      const gatewayEnvelope: GatewayEnvelope<unknown> = {
        ...gatewayEnvelopeBase,
        ...(prepareCriticalSteerStop === undefined
          ? {}
          : { prepareCriticalSteerStop }),
      };
      const decision: AuthorityDecisionInput = {
        principal,
        submissionContext,
        envelope: gatewayEnvelopeBase,
        semanticRequestFingerprint: fingerprint,
        canonicalFacts: inputs.canonicalFacts,
        grants: inputs.grants,
        governance: inputs.governance,
        policy: inputs.policy,
        ...(inputs.sandboxPolicyGrantIssuerConfigSnapshot === undefined
          ? {}
          : {
              sandboxPolicyGrantIssuerConfigSnapshot:
                inputs.sandboxPolicyGrantIssuerConfigSnapshot,
            }),
        ...(inputs.sandboxPolicyAuthorityNow === undefined
          ? {}
          : { sandboxPolicyAuthorityNow: inputs.sandboxPolicyAuthorityNow }),
        ...(inputs.sandboxPolicyGrantIssuerProvenance === undefined
          ? {}
          : {
              sandboxPolicyGrantIssuerProvenance:
                inputs.sandboxPolicyGrantIssuerProvenance,
            }),
      };
      const resolved = yield* Effect.match(deps.resolver.resolve(decision), {
        onFailure: (error) => ({ _tag: "denied" as const, error }),
        onSuccess: (fact) => ({ _tag: "fact" as const, fact }),
      });
      if (resolved._tag === "denied") {
        return failureResponse(
          authorityDeniedProblem(
            `${resolved.error._tag}:${envelope.commandType}`,
          ),
        );
      }
      const authority = resolved.fact;
      const executed = yield* Effect.match(
        deps.gateway.execute(gatewayEnvelope, submissionContext, authority),
        {
          onFailure: (error) => ({ _tag: "failure" as const, error }),
          onSuccess: (receipt) => ({ _tag: "receipt" as const, receipt }),
        },
      );
      if (executed._tag === "failure") {
        return failureResponse(problemFromCommandFailure(executed.error));
      }
      if (
        executed.receipt.resolution._tag === "Committed" &&
        envelope.commandType === "CreateProject" &&
        deps.afterGatewayCommitBeforeCreateProjectActivation !== undefined
      ) {
        const held = yield* Effect.match(
          deps.afterGatewayCommitBeforeCreateProjectActivation(envelope),
          {
            onFailure: (error) => ({ _tag: "failure" as const, error }),
            onSuccess: () => ({ _tag: "success" as const }),
          },
        );
        if (held._tag === "failure") {
          return failureResponse(
            problemFromUnknownFailure(
              "command/post-commit-convergence-failure",
              held.error,
            ),
          );
        }
      }
      if (
        executed.receipt.resolution._tag === "Committed" &&
        deps.afterCommitted !== undefined
      ) {
        const converged = yield* Effect.match(deps.afterCommitted(envelope), {
          onFailure: (error) => ({ _tag: "failure" as const, error }),
          onSuccess: () => ({ _tag: "success" as const }),
        });
        if (converged._tag === "failure") {
          if (
            envelope.commandType === "CreateProject" &&
            executed.receipt.resolution._tag === "Committed" &&
            isActiveResourceOverlapFailure(converged.error)
          ) {
            return {
              ok: true as const,
              status: 200,
              body: receiptToView(executed.receipt, envelope.commandType),
            };
          }
          return failureResponse(
            problemFromUnknownFailure(
              "command/post-commit-convergence-failure",
              converged.error,
            ),
          );
        }
      }
      return {
        ok: true as const,
        status: 200,
        body: receiptToView(executed.receipt, envelope.commandType),
      };
    }),
});

/** Convenience composition-root constructor: pulls the resolver, gateway,
 * registry and repository snapshots from the running layer and returns the
 * submission port the transport shells bind to. */
export const makeExternalSubmissionFromServices = (
  governance: ParentUserGovernanceFacts,
  postCommitBeforeActivationProbe?: CreateProjectPostCommitBeforeActivationQualificationProbe,
  sandboxPolicyGrantIssuerConfigSnapshot?: SandboxPolicyAuthoritySnapshotV2,
): Effect.Effect<
  ExternalSubmissionPort,
  never,
  | AuthorityInputsServices
  | AuthorityResolverPort
  | CommandGateway
  | CommandHandlerRegistry
> =>
  Effect.gen(function* () {
    const resolver = yield* AuthorityResolverPort;
    const gateway = yield* CommandGateway;
    const registry = yield* CommandHandlerRegistry;
    const loadInputs = yield* makeRepositoryInputsLoader(
      governance,
      sandboxPolicyGrantIssuerConfigSnapshot,
    );
    const tx = yield* TransactionPort;
    const executions = yield* ExecutionRepository;
    const findActiveMainByWorkspace = (workspaceId: WorkspaceId) =>
      tx.transact(executions.findActiveMainByWorkspace(workspaceId)).pipe(
        Effect.map((execution) =>
          Option.isSome(execution)
            ? {
                executionId: execution.value.executionId,
                projectId: execution.value.projectId,
                workspaceId: execution.value.workspaceId,
              }
            : null,
        ),
        Effect.orDie,
      );
    const afterGatewayCommitBeforeCreateProjectActivation =
      postCommitBeforeActivationProbe === undefined
        ? undefined
        : (envelope: DecodedExternalCommandEnvelope) => {
            const payload = payloadRecord(envelope.payload);
            return envelope.commandType !== "CreateProject"
              ? Effect.void
              : Effect.promise(() =>
                  postCommitBeforeActivationProbe({
                    commandId: String(envelope.commandId),
                    projectId: envelope.projectId,
                    workspaceId: String(payload.rootWorkspaceId) as WorkspaceId,
                  }),
                );
          };
    const workspaces = yield* WorkspaceRepository;
    const works = yield* WorkRepository;
    const activationIntentsOption = yield* Effect.serviceOption(
      WorkspaceResourceActivationStore,
    );
    const attentionProjectionOption = yield* Effect.serviceOption(
      AttentionProjectionStore,
    );
    const ownershipOption = yield* Effect.serviceOption(
      ResourceOwnershipRepository,
    );
    const environmentOption = yield* Effect.serviceOption(
      ProjectEnvironmentPort,
    );
    const ownershipWriteOption = yield* Effect.serviceOption(
      OwnershipWriteService,
    );
    const clockOption = yield* Effect.serviceOption(Clock);
    const idsOption = yield* Effect.serviceOption(IdGenerator);
    const schedulerOption = yield* Effect.serviceOption(ExecutionScheduler);
    const blockerStoreOption = yield* Effect.serviceOption(WorkBlockerStore);
    const inboxProjectionOption =
      yield* Effect.serviceOption(InboxProjectionStore);
    const workWaitStoreOption = yield* Effect.serviceOption(WorkWaitStore);
    if (
      Option.isNone(ownershipOption) ||
      Option.isNone(environmentOption) ||
      Option.isNone(ownershipWriteOption) ||
      Option.isNone(clockOption) ||
      Option.isNone(idsOption) ||
      Option.isNone(schedulerOption)
    ) {
      return makeExternalSubmission({
        resolver,
        gateway,
        registry,
        loadInputs,
        findActiveMainByWorkspace,
        ...(afterGatewayCommitBeforeCreateProjectActivation !== undefined
          ? { afterGatewayCommitBeforeCreateProjectActivation }
          : {}),
      });
    }
    const ownership = ownershipOption.value;
    const environment = environmentOption.value;
    const ownershipWrite = ownershipWriteOption.value;
    const clock = clockOption.value;
    const ids = idsOption.value;
    const scheduler = schedulerOption.value;
    const reconcileActivationAttention = (
      projectId: DecodedExternalCommandEnvelope["projectId"],
    ) => {
      if (
        Option.isNone(activationIntentsOption) ||
        Option.isNone(attentionProjectionOption)
      ) {
        return Effect.fail(
          new Error("F21 Activation Attention services are unavailable"),
        );
      }
      return reconcileProjectActivationAttention(
        {
          transactions: tx,
          activationIntents: activationIntentsOption.value,
          attentionProjection: attentionProjectionOption.value,
        },
        projectId,
      );
    };
    const activateIfMissing = (input: {
      readonly projectId: DecodedExternalCommandEnvelope["projectId"];
      readonly workspaceId: WorkspaceId;
      readonly resourceBoundaryRevision: number;
      readonly resourceBoundary: {
        readonly addresses?: unknown;
      };
    }) =>
      Effect.gen(function* () {
        const active = yield* tx.transact(
          ownership.listActiveByWorkspace(input.workspaceId),
        );
        if (active.length > 0) return;
        const addresses = Array.isArray(input.resourceBoundary.addresses)
          ? input.resourceBoundary.addresses
          : [];
        yield* activateWorkspaceBoundary(
          {
            projectId: input.projectId,
            workspaceId: input.workspaceId,
            resourceBoundaryRevision: input.resourceBoundaryRevision as never,
            addresses: addresses as never,
          },
          { environment, ownershipWrite, clock, ids },
        );
      });
    const activateCommittedProjectResource = (input: {
      readonly projectId: DecodedExternalCommandEnvelope["projectId"];
      readonly workspaceId: WorkspaceId;
    }) =>
      Effect.gen(function* () {
        const workspace = yield* tx.transact(
          workspaces.findById(input.workspaceId),
        );
        if (Option.isNone(workspace)) {
          return yield* Effect.fail(
            new Error("committed workspace boundary is unavailable"),
          );
        }
        const resourceBoundaryRevision =
          workspace.value.resourceBoundaryRevision;
        const addresses = workspace.value.resourceBoundary.addresses;
        if (Option.isNone(activationIntentsOption)) {
          return yield* Effect.fail(
            new Error("F21 activation intent store is unavailable"),
          );
        }
        const intent = yield* tx.transact(
          activationIntentsOption.value.find(
            input.projectId,
            input.workspaceId,
            resourceBoundaryRevision,
          ),
        );
        if (Option.isSome(intent)) {
          const activation = yield* Effect.match(
            ownershipWrite.activatePendingWorkspaceResource(
              input.projectId,
              input.workspaceId,
              resourceBoundaryRevision,
              addresses,
            ),
            {
              onFailure: (error) => ({ _tag: "Failed" as const, error }),
              onSuccess: () => ({ _tag: "Activated" as const }),
            },
          );
          yield* reconcileActivationAttention(input.projectId);
          if (activation._tag === "Failed") {
            return yield* Effect.fail(activation.error);
          }
          return;
        }

        // Existing pre-intent v2 receipts remain preserve-only for migration.
        // An exact Gateway replay may retain its older post-commit retry path,
        // but it never synthesizes an ActivationIntent or Attention source.
        yield* reconcileActivationAttention(input.projectId);
        if (addresses.length === 0) return;
        yield* activateIfMissing({
          projectId: input.projectId,
          workspaceId: input.workspaceId,
          resourceBoundaryRevision,
          resourceBoundary: workspace.value.resourceBoundary,
        });
      });
    const afterCommitted = (envelope: DecodedExternalCommandEnvelope) => {
      const payload = payloadRecord(envelope.payload);
      if (envelope.commandType === "CreateProject") {
        return activateCommittedProjectResource({
          projectId: envelope.projectId,
          workspaceId: String(payload.rootWorkspaceId) as WorkspaceId,
        });
      }
      if (envelope.commandType === "CreateChildWorkspace") {
        return activateIfMissing({
          projectId: envelope.projectId,
          workspaceId: String(payload.workspaceId) as WorkspaceId,
          resourceBoundaryRevision: Number(payload.resourceBoundaryRevision),
          resourceBoundary: payloadRecord(payload.resourceBoundary),
        });
      }
      if (envelope.commandType === "SteerWork") {
        const workId = payloadString(payload, "workId") as WorkId | null;
        if (workId === null) return Effect.void;
        if (
          Option.isSome(blockerStoreOption) &&
          Option.isSome(inboxProjectionOption) &&
          Option.isSome(workWaitStoreOption)
        ) {
          return Effect.gen(function* () {
            const work = yield* tx.transact(works.findById(workId));
            if (Option.isNone(work)) return;
            const sequence = yield* tx.transact(
              inboxProjectionOption.value.currentSequence(
                work.value.workspaceId,
              ),
            );
            yield* deliverWakeSignal(
              {
                workspaceId: work.value.workspaceId,
                reason: "InputArrived",
                detail: { inboxSequence: sequence },
              },
              {
                tx,
                waits: workWaitStoreOption.value,
                works,
                scheduler,
              },
            );
          });
        }
        // Legacy schema before P43 has no durable Inbox high-water mark; keep
        // its preserve-only behavior until the accepted migration is active.
        return tx.transact(scheduler.clearWorkWait(workId));
      }
      return Effect.void;
    };
    return makeExternalSubmission({
      resolver,
      gateway,
      registry,
      loadInputs,
      findActiveMainByWorkspace,
      ...(afterGatewayCommitBeforeCreateProjectActivation !== undefined
        ? { afterGatewayCommitBeforeCreateProjectActivation }
        : {}),
      afterCommitted,
    });
  });
