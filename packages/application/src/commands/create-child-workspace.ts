import {
  type ContextEpochNumber,
  createSession,
  createWorkspace,
  type ProjectId,
  type ResourceBoundary,
  type ResourceBoundaryRevision,
  type ResponsibilityBoundAgentBinding,
  type ResponsibilityDefinition,
  type ResponsibilityRevision,
  type Revision,
  type SessionId,
  type WorkspaceId,
  type WorkspacePolicy,
} from "@arbor/domain";
import type {
  PendingDomainEvent,
  SessionRepositoryService,
  WorkspaceRepositoryService,
  WorkspaceResourceActivationStoreService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { commandErr, commandOk } from "../command-result.js";
import type { FormationDelegationApproval } from "../formation-plan.js";
import type { CommandHandler } from "../gateway.js";

export interface CreateChildWorkspacePayload {
  readonly parentWorkspaceId: WorkspaceId;
  readonly workspaceId: WorkspaceId;
  readonly primarySession: {
    readonly sessionId: SessionId;
    readonly contextEpoch: ContextEpochNumber;
  };
  readonly name: string;
  readonly responsibilityDefinition: ResponsibilityDefinition;
  readonly responsibilityRevision: ResponsibilityRevision;
  readonly resourceBoundary: ResourceBoundary;
  readonly resourceBoundaryRevision: ResourceBoundaryRevision;
  readonly agentBinding: ResponsibilityBoundAgentBinding;
  readonly workspacePolicy: WorkspacePolicy;
  readonly workspacePolicyRevision: Revision;
  readonly revision: Revision;
  readonly ownershipDelegationApproval?: FormationDelegationApproval;
}

export interface CreateChildWorkspaceResult {
  readonly workspaceId: WorkspaceId;
  readonly projectId: ProjectId;
  readonly parentWorkspaceId: WorkspaceId;
  readonly primarySessionId: SessionId;
}

export interface CreateChildWorkspaceDependencies {
  readonly workspaces: WorkspaceRepositoryService;
  readonly sessions: SessionRepositoryService;
  readonly activations?: Pick<
    WorkspaceResourceActivationStoreService,
    "insertPending"
  >;
}

export const makeCreateChildWorkspaceHandler = (
  dependencies: CreateChildWorkspaceDependencies,
): CommandHandler<CreateChildWorkspacePayload, CreateChildWorkspaceResult> => ({
  commandType: "CreateChildWorkspace",
  schemaVersion: "1",
  authority: {
    tag: "CreateChildWorkspaceAuthority",
    targetMatches: (authority, payload) =>
      authority._tag === "CreateChildWorkspaceAuthority" &&
      authority.parentWorkspaceId === payload.parentWorkspaceId,
  },
  stopAdmission: { _tag: "Unclassified" },
  execute: (envelope) =>
    Effect.gen(function* () {
      const payload = envelope.payload;
      if (
        payload.resourceBoundary.basisResponsibilityRevision !==
        payload.responsibilityRevision
      ) {
        return commandErr({
          _tag: "AuthorityDenied",
          reason: "resource boundary basis revision mismatch",
        });
      }

      const parent = yield* dependencies.workspaces.findById(
        payload.parentWorkspaceId,
      );
      if (Option.isNone(parent)) {
        return commandErr({
          _tag: "WorkspaceNotFound",
          workspaceId: payload.parentWorkspaceId,
        });
      }
      const parentWorkspace = parent.value;
      if (parentWorkspace.projectId !== envelope.projectId) {
        return commandErr({
          _tag: "AuthorityDenied",
          reason: "parent workspace belongs to another project",
        });
      }
      if (parentWorkspace.lifecycle !== "Active") {
        return commandErr({
          _tag: "TerminalLifecycleMutation",
          entity: "Workspace",
          lifecycle: parentWorkspace.lifecycle,
        });
      }
      const delegation = payload.ownershipDelegationApproval;
      if (delegation !== undefined) {
        const identity = (address: unknown): string | null => {
          if (
            typeof address !== "object" ||
            address === null ||
            Array.isArray(address)
          )
            return null;
          const value = address as Record<string, unknown>;
          switch (value._tag) {
            case "FileTree":
              return typeof value.path === "string"
                ? `FileTree:${value.path}`
                : null;
            case "GitWorktree":
              return typeof value.path === "string"
                ? `GitWorktree:${value.path}:${String(value.repositoryRef ?? "")}:${String(value.branch ?? "")}`
                : null;
            case "DatabaseNamespace":
              return typeof value.namespace === "string"
                ? `DatabaseNamespace:${value.namespace}`
                : null;
            case "ExternalResource":
              return typeof value.address === "string"
                ? `ExternalResource:${value.address}`
                : null;
            default:
              return null;
          }
        };
        const delegatedIdentities = delegation.addresses.map(identity);
        if (
          dependencies.activations === undefined ||
          delegation.delegationSourceId !==
            `formation:${delegation.formationProposalId}:${delegation.formationProposalRevision}` ||
          delegation.parentWorkspaceId !== payload.parentWorkspaceId ||
          delegation.expectedParentWorkspaceRevision !==
            parentWorkspace.revision ||
          delegation.expectedParentBoundaryRevision !==
            parentWorkspace.resourceBoundaryRevision ||
          delegation.expectedChildWorkspaceRevision !== payload.revision ||
          delegation.expectedParentOwnershipRevision < 0 ||
          !Number.isSafeInteger(delegation.expectedParentOwnershipRevision) ||
          delegation.expectedChildOwnershipRevision !== 0 ||
          delegation.addresses.length === 0 ||
          delegation.addresses.length > 16 ||
          delegatedIdentities.some((value) => value === null) ||
          new Set(delegatedIdentities).size !== delegatedIdentities.length
        ) {
          return commandErr({
            _tag: "AuthorityDenied",
            reason:
              "formation ownership delegation approval binding is invalid or stale",
          });
        }
      }

      yield* dependencies.workspaces.create(
        createWorkspace({
          workspaceId: payload.workspaceId,
          projectId: envelope.projectId,
          parentWorkspaceId: payload.parentWorkspaceId,
          name: payload.name,
          responsibilityDefinition: payload.responsibilityDefinition,
          responsibilityRevision: payload.responsibilityRevision,
          resourceBoundary: payload.resourceBoundary,
          resourceBoundaryRevision: payload.resourceBoundaryRevision,
          agentBinding: payload.agentBinding,
          primarySessionId: payload.primarySession.sessionId,
          workspacePolicy: payload.workspacePolicy,
          workspacePolicyRevision: payload.workspacePolicyRevision,
          revision: payload.revision,
        }),
      );
      yield* dependencies.sessions.create(
        createSession({
          sessionId: payload.primarySession.sessionId,
          binding: {
            _tag: "WorkspacePrimary",
            workspaceId: payload.workspaceId,
          },
          contextEpoch: payload.primarySession.contextEpoch,
        }),
      );
      if (delegation !== undefined) {
        const activationStore = dependencies.activations;
        if (activationStore === undefined) {
          return yield* Effect.die(
            new Error("S3 formation requires the activation intent store"),
          );
        }
        yield* activationStore.insertPending({
          projectId: envelope.projectId,
          workspaceId: payload.workspaceId,
          resourceBoundaryRevision: payload.resourceBoundaryRevision,
          status: "Pending",
          createdAt: envelope.issuedAt,
          updatedAt: envelope.issuedAt,
          activatedAt: null,
          delegation: {
            ...delegation,
          },
        });
      }

      const events: PendingDomainEvent[] = [
        {
          projectId: envelope.projectId,
          eventType: "WorkspaceCreated",
          eventVersion: 1,
          occurredAt: envelope.issuedAt,
          aggregateRef: payload.workspaceId,
          actor: envelope.actor,
          causedByCommandId: envelope.commandId,
          payload: {
            workspaceId: payload.workspaceId,
            projectId: envelope.projectId,
            parentWorkspaceId: payload.parentWorkspaceId,
            name: payload.name,
          },
        },
      ];

      return commandOk({
        result: {
          workspaceId: payload.workspaceId,
          projectId: envelope.projectId,
          parentWorkspaceId: payload.parentWorkspaceId,
          primarySessionId: payload.primarySession.sessionId,
        },
        events,
      });
    }),
});
