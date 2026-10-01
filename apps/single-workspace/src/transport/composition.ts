import type { ViewRequestMap, ViewResponseMap } from "@arbor/api-contracts";
import type {
  AuthorityDecisionInput,
  AuthorityResolverPortService,
  CanonicalAuthorityFacts,
  CommandGatewayService,
  CommandHandlerRegistryService,
  CommandRejection,
  GatewayEnvelope,
  ParentUserGovernanceFacts,
} from "@arbor/application";
import {
  AuthorityResolverPort,
  activateWorkspaceBoundary,
  CommandGateway,
  CommandHandlerRegistry,
  semanticRequestFingerprint,
} from "@arbor/application";
import type {
  CommandReceipt,
  ExecutionId,
  PermissionGrant,
  Principal,
  ProjectPolicy,
  QueryResult,
  ViewId,
  WorkId,
  WorkspaceId,
  WorkspacePolicy,
} from "@arbor/domain";
import { makeProjectPolicy } from "@arbor/domain";
import type {
  ProjectionQueryError,
  ProjectionQueryPortService,
} from "@arbor/ports";
import {
  Clock,
  ExecutionRepository,
  ExecutionScheduler,
  IdGenerator,
  OwnershipWriteService,
  PermissionGrantRepository,
  ProjectEnvironmentPort,
  ProjectRepository,
  ResourceOwnershipRepository,
  TransactionPort,
  WorkRepository,
  WorkspaceRepository,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import type {
  CommandReceiptView,
  ExternalCommandEnvelope,
  ExternalSubmissionPort,
  ViewQueryFace,
} from "./contracts.js";
import {
  authorityDeniedProblem,
  failureResponse,
  invalidCommandProblem,
  makeProblem,
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
}

/** The view face is the frozen `ProjectionQueryPort` binding (P10 `05` §1);
 * the transport renders whatever DTO it returns, unchanged. */
export const viewQueryFaceFromPort = (
  port: ProjectionQueryPortService,
): ViewQueryFace => ({
  query: <V extends ViewId>(
    view: V,
    request: ViewRequestMap[V],
  ): Effect.Effect<QueryResult<ViewResponseMap[V]>, ProjectionQueryError> =>
    port.query<ViewRequestMap[V], ViewResponseMap[V]>(view, request),
});

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
  | PermissionGrantRepository;

/** The production facts loader: repository snapshots + the `PermissionGrant`
 * store's active-only read (`02` §5.1). The resolver receives declared
 * snapshots only; the loader lives at the composition root. */
export const makeRepositoryInputsLoader = (
  governance: ParentUserGovernanceFacts,
): Effect.Effect<
  (envelope: ExternalCommandEnvelope) => Effect.Effect<AuthorityInputs, never>,
  never,
  AuthorityInputsServices
> =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const projects = yield* ProjectRepository;
    const workspaces = yield* WorkspaceRepository;
    const executions = yield* ExecutionRepository;
    const works = yield* WorkRepository;
    const grants = yield* PermissionGrantRepository;

    return (envelope) =>
      Effect.gen(function* () {
        const projectId = envelope.projectId;
        const payload = envelope.payload;
        const workspaceId = (payloadString(payload, "workspaceId") ??
          payloadString(payload, "targetWorkspaceId") ??
          payloadString(payload, "parentWorkspaceId")) as WorkspaceId | null;
        const executionId = payloadString(
          payload,
          "executionId",
        ) as ExecutionId | null;
        const workId = payloadString(payload, "workId") as WorkId | null;

        const workspace =
          workspaceId === null
            ? Option.none()
            : yield* tx.transact(workspaces.findById(workspaceId));
        const execution =
          executionId === null
            ? Option.none()
            : yield* tx.transact(executions.findById(executionId));
        const work =
          workId === null
            ? Option.none()
            : yield* tx.transact(works.findById(workId));
        const project = yield* tx.transact(projects.findById(projectId));
        const activeGrants = yield* tx.transact(grants.activeGrants(projectId));

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
                },
              }
            : {}),
        };
        return {
          canonicalFacts,
          grants: activeGrants,
          governance,
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
    envelope: ExternalCommandEnvelope,
  ) => Effect.Effect<AuthorityInputs, never>;
  readonly afterCommitted?: (
    envelope: ExternalCommandEnvelope,
  ) => Effect.Effect<void, unknown>;
}

const receiptToView = (
  receipt: CommandReceipt<unknown, CommandRejection>,
): CommandReceiptView =>
  receipt.resolution._tag === "Committed"
    ? {
        commandId: receipt.commandId,
        resolution: "Committed",
        result: receipt.resolution.result,
      }
    : {
        commandId: receipt.commandId,
        resolution: "TerminalRejected",
        rejection: receipt.resolution.error._tag,
      };

export const makeExternalSubmission = (
  deps: ExternalSubmissionDeps,
): ExternalSubmissionPort => ({
  submit: (principal: Principal, submissionContext, envelope) =>
    Effect.gen(function* () {
      const handler = deps.registry.lookup(envelope.commandType);
      if (Option.isNone(handler)) {
        return failureResponse(
          invalidCommandProblem(`unsupported command ${envelope.commandType}`),
        );
      }
      const gatewayEnvelope: GatewayEnvelope<unknown> = {
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
      const inputs = yield* deps.loadInputs(envelope);
      const decision: AuthorityDecisionInput = {
        principal,
        submissionContext,
        envelope: gatewayEnvelope,
        semanticRequestFingerprint: fingerprint,
        canonicalFacts: inputs.canonicalFacts,
        grants: inputs.grants,
        governance: inputs.governance,
        policy: inputs.policy,
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
      const executed = yield* Effect.match(
        deps.gateway.execute(gatewayEnvelope, submissionContext, resolved.fact),
        {
          onFailure: (error) => ({ _tag: "failure" as const, error }),
          onSuccess: (receipt) => ({ _tag: "receipt" as const, receipt }),
        },
      );
      if (executed._tag === "failure") {
        return failureResponse(
          makeProblem("command/gateway-failure", "unavailable", "retryable", {
            cause: executed.error._tag,
          }),
        );
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
          return failureResponse(
            makeProblem(
              "command/post-commit-convergence-failure",
              "unavailable",
              "retryable",
              { cause: String(converged.error) },
            ),
          );
        }
      }
      return {
        ok: true as const,
        status: 200,
        body: receiptToView(executed.receipt),
      };
    }),
});

/** Convenience composition-root constructor: pulls the resolver, gateway,
 * registry and repository snapshots from the running layer and returns the
 * submission port the transport shells bind to. */
export const makeExternalSubmissionFromServices = (
  governance: ParentUserGovernanceFacts,
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
    const loadInputs = yield* makeRepositoryInputsLoader(governance);
    const tx = yield* TransactionPort;
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
      });
    }
    const ownership = ownershipOption.value;
    const environment = environmentOption.value;
    const ownershipWrite = ownershipWriteOption.value;
    const clock = clockOption.value;
    const ids = idsOption.value;
    const scheduler = schedulerOption.value;
    const activateIfMissing = (input: {
      readonly projectId: ExternalCommandEnvelope["projectId"];
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
    const afterCommitted = (envelope: ExternalCommandEnvelope) => {
      const payload = payloadRecord(envelope.payload);
      if (envelope.commandType === "CreateProject") {
        const root = payloadRecord(payload.rootWorkspace);
        return activateIfMissing({
          projectId: envelope.projectId,
          workspaceId: String(payload.rootWorkspaceId) as WorkspaceId,
          resourceBoundaryRevision: Number(root.resourceBoundaryRevision),
          resourceBoundary: payloadRecord(root.resourceBoundary),
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
        return workId === null
          ? Effect.void
          : tx.transact(scheduler.clearWorkWait(workId));
      }
      return Effect.void;
    };
    return makeExternalSubmission({
      resolver,
      gateway,
      registry,
      loadInputs,
      afterCommitted,
    });
  });
