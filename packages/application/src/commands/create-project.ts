import {
  type ContextEpochNumber,
  createProject,
  createSession,
  createWorkspace,
  err,
  ok,
  type ProjectId,
  type ProjectPolicy,
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
  ProjectRepositoryService,
  SessionRepositoryService,
  WorkspaceRepositoryService,
} from "@arbor/ports";
import { Effect } from "effect";
import type { CommandHandler } from "../gateway.js";

export interface CreateProjectPayload {
  readonly name: string;
  readonly revision: Revision;
  readonly projectPolicy: ProjectPolicy;
  readonly projectPolicyRevision: Revision;
  readonly defaultConfiguration: Readonly<Record<string, unknown>>;
  readonly environmentRef: string;
  readonly rootWorkspaceId: WorkspaceId;
  readonly primarySession: {
    readonly sessionId: SessionId;
    readonly contextEpoch: ContextEpochNumber;
  };
  readonly rootWorkspace: {
    readonly name: string;
    readonly responsibilityDefinition: ResponsibilityDefinition;
    readonly responsibilityRevision: ResponsibilityRevision;
    readonly resourceBoundary: ResourceBoundary;
    readonly resourceBoundaryRevision: ResourceBoundaryRevision;
    readonly agentBinding: ResponsibilityBoundAgentBinding;
    readonly workspacePolicy: WorkspacePolicy;
    readonly workspacePolicyRevision: Revision;
    readonly revision: Revision;
  };
}

export interface CreateProjectResult {
  readonly projectId: ProjectId;
  readonly rootWorkspaceId: WorkspaceId;
  readonly primarySessionId: SessionId;
}

export interface CreateProjectDependencies {
  readonly projects: ProjectRepositoryService;
  readonly workspaces: WorkspaceRepositoryService;
  readonly sessions: SessionRepositoryService;
}

export const makeCreateProjectHandler = (
  dependencies: CreateProjectDependencies,
): CommandHandler<CreateProjectPayload, CreateProjectResult> => ({
  commandType: "CreateProject",
  schemaVersion: "1",
  authority: { tag: "CreateProjectAuthority", targetMatches: () => true },
  execute: (envelope) =>
    Effect.gen(function* () {
      const payload = envelope.payload;
      if (
        payload.rootWorkspace.resourceBoundary.basisResponsibilityRevision !==
        payload.rootWorkspace.responsibilityRevision
      ) {
        return err({
          _tag: "AuthorityDenied",
          reason: "resource boundary basis revision mismatch",
        });
      }

      yield* dependencies.projects.create(
        createProject({
          projectId: envelope.projectId,
          name: payload.name,
          rootWorkspaceId: payload.rootWorkspaceId,
          projectPolicy: payload.projectPolicy,
          projectPolicyRevision: payload.projectPolicyRevision,
          revision: payload.revision,
          defaultConfiguration: payload.defaultConfiguration,
          environmentRef: payload.environmentRef,
        }),
      );
      yield* dependencies.workspaces.create(
        createWorkspace({
          workspaceId: payload.rootWorkspaceId,
          projectId: envelope.projectId,
          parentWorkspaceId: null,
          name: payload.rootWorkspace.name,
          responsibilityDefinition:
            payload.rootWorkspace.responsibilityDefinition,
          responsibilityRevision: payload.rootWorkspace.responsibilityRevision,
          resourceBoundary: payload.rootWorkspace.resourceBoundary,
          resourceBoundaryRevision:
            payload.rootWorkspace.resourceBoundaryRevision,
          agentBinding: payload.rootWorkspace.agentBinding,
          primarySessionId: payload.primarySession.sessionId,
          workspacePolicy: payload.rootWorkspace.workspacePolicy,
          workspacePolicyRevision:
            payload.rootWorkspace.workspacePolicyRevision,
          revision: payload.rootWorkspace.revision,
        }),
      );
      yield* dependencies.sessions.create(
        createSession({
          sessionId: payload.primarySession.sessionId,
          binding: {
            _tag: "WorkspacePrimary",
            workspaceId: payload.rootWorkspaceId,
          },
          contextEpoch: payload.primarySession.contextEpoch,
        }),
      );

      const events: PendingDomainEvent[] = [
        {
          projectId: envelope.projectId,
          eventType: "ProjectCreated",
          eventVersion: 1,
          occurredAt: envelope.issuedAt,
          aggregateRef: envelope.projectId,
          actor: envelope.actor,
          causedByCommandId: envelope.commandId,
          payload: {
            projectId: envelope.projectId,
            name: payload.name,
            rootWorkspaceId: payload.rootWorkspaceId,
          },
        },
        {
          projectId: envelope.projectId,
          eventType: "WorkspaceCreated",
          eventVersion: 1,
          occurredAt: envelope.issuedAt,
          aggregateRef: payload.rootWorkspaceId,
          actor: envelope.actor,
          causedByCommandId: envelope.commandId,
          payload: {
            workspaceId: payload.rootWorkspaceId,
            projectId: envelope.projectId,
            parentWorkspaceId: null,
            name: payload.rootWorkspace.name,
          },
        },
      ];

      return ok({
        result: {
          projectId: envelope.projectId,
          rootWorkspaceId: payload.rootWorkspaceId,
          primarySessionId: payload.primarySession.sessionId,
        },
        events,
      });
    }),
});
