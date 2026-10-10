import {
  type ContextEpochNumber,
  createProject,
  createSession,
  createWorkspace,
  err,
  normalizeProjectName,
  ok,
  type ProjectId,
  type ProjectPolicy,
  parse,
  type ResourceAddress,
  ResourceBoundaryRevision,
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
  ProjectResourceProfilePortService,
  SessionRepositoryService,
  WorkspaceRepositoryService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { commandErr } from "../command-result.js";
import type { CommandHandler } from "../gateway.js";

export type CreateProjectResourceSelection =
  | {
      readonly _tag: "Profile";
      readonly resourceProfileRef: string;
      readonly version: string;
    }
  | { readonly _tag: "ConversationOnly" };

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
    readonly resourceSelection: CreateProjectResourceSelection;
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
  readonly projectResourceProfiles?: ProjectResourceProfilePortService;
}

export const makeCreateProjectHandler = (
  dependencies: CreateProjectDependencies,
): CommandHandler<CreateProjectPayload, CreateProjectResult> => ({
  commandType: "CreateProject",
  schemaVersion: "2",
  authority: { tag: "CreateProjectAuthority", targetMatches: () => true },
  stopAdmission: { _tag: "Unclassified" },
  execute: (envelope) =>
    Effect.gen(function* () {
      const payload = envelope.payload;
      const projectName = normalizeProjectName(payload.name);
      if (!projectName.ok) {
        return err(projectName.error);
      }
      let trustedAddresses: ReadonlyArray<ResourceAddress> = [];
      if (payload.rootWorkspace.resourceSelection._tag === "Profile") {
        const profiles = dependencies.projectResourceProfiles;
        const selected =
          profiles === undefined
            ? Option.none()
            : yield* profiles.resolve(
                payload.rootWorkspace.resourceSelection.resourceProfileRef,
                payload.rootWorkspace.resourceSelection.version,
              );
        if (Option.isNone(selected)) {
          return commandErr({
            _tag: "ProjectResourceUnavailable",
            commandId: envelope.commandId,
          });
        }
        trustedAddresses = [selected.value.canonicalAddress];
      }
      const resourceBoundary = {
        basisResponsibilityRevision:
          payload.rootWorkspace.responsibilityRevision,
        addresses: trustedAddresses,
      };
      const resourceBoundaryRevision = parse(ResourceBoundaryRevision)(0);

      yield* dependencies.projects.create(
        createProject({
          projectId: envelope.projectId,
          name: projectName.value,
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
          resourceBoundary,
          resourceBoundaryRevision,
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
            name: projectName.value,
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
