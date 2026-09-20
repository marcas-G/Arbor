import {
  assignWork,
  type ProjectId,
  type Revision,
  type VerificationMission,
  type WorkId,
  type WorkRevision,
  type WorkspaceId,
} from "@arbor/domain";
import type {
  PendingDomainEvent,
  ProjectRepositoryService,
  WorkRepositoryService,
  WorkspaceRepositoryService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { commandErr, commandOk } from "../command-result.js";
import type { CommandHandler } from "../gateway.js";

export interface AssignWorkPayload {
  readonly workId: WorkId;
  readonly workspaceId: WorkspaceId;
  readonly expectedWorkspaceRevision: Revision;
  readonly objective: string;
  readonly why: string;
  readonly constraints: ReadonlyArray<string>;
  readonly completionExpectation: string;
  readonly verificationMission: VerificationMission;
  readonly provenance: {
    readonly predecessorWorkId: WorkId | null;
    readonly reason: string;
  };
  readonly revision: WorkRevision;
}

export interface AssignWorkResult {
  readonly workId: WorkId;
  readonly workspaceId: WorkspaceId;
  readonly lifecycle: "Open";
  readonly revision: WorkRevision;
}

export interface AssignWorkDependencies {
  readonly projects: ProjectRepositoryService;
  readonly workspaces: WorkspaceRepositoryService;
  readonly works: WorkRepositoryService;
}

export const makeAssignWorkHandler = (
  dependencies: AssignWorkDependencies,
): CommandHandler<AssignWorkPayload, AssignWorkResult> => ({
  commandType: "AssignWork",
  schemaVersion: "1",
  authority: {
    tag: "AssignWorkAuthority",
    targetMatches: (authority, payload) =>
      authority._tag === "AssignWorkAuthority" &&
      authority.targetWorkspaceId === payload.workspaceId,
  },
  stopAdmission: { _tag: "Unclassified" },
  execute: (envelope) =>
    Effect.gen(function* () {
      const payload = envelope.payload;
      const workspace = yield* dependencies.workspaces.findById(
        payload.workspaceId,
      );
      if (Option.isNone(workspace)) {
        return commandErr({
          _tag: "WorkspaceNotFound",
          workspaceId: payload.workspaceId,
        });
      }
      const currentWorkspace = workspace.value;
      if (currentWorkspace.projectId !== envelope.projectId) {
        return commandErr({
          _tag: "AuthorityDenied",
          reason: "workspace belongs to another project",
        });
      }

      const project = yield* dependencies.projects.findById(envelope.projectId);
      if (Option.isSome(project) && project.value.lifecycle !== "Open") {
        return commandErr({
          _tag: "TerminalLifecycleMutation",
          entity: "Project",
          lifecycle: project.value.lifecycle,
        });
      }
      if (currentWorkspace.lifecycle !== "Active") {
        return commandErr({
          _tag: "TerminalLifecycleMutation",
          entity: "Workspace",
          lifecycle: currentWorkspace.lifecycle,
        });
      }
      if (currentWorkspace.revision !== payload.expectedWorkspaceRevision) {
        return commandErr({
          _tag: "RevisionConflict",
          expected: payload.expectedWorkspaceRevision,
          actual: currentWorkspace.revision,
        });
      }

      const assigned = assignWork({
        workId: payload.workId,
        projectId: envelope.projectId,
        workspaceId: payload.workspaceId,
        objective: payload.objective,
        why: payload.why,
        constraints: payload.constraints,
        completionExpectation: payload.completionExpectation,
        verificationMission: payload.verificationMission,
        provenance: payload.provenance,
        revision: payload.revision,
        authorized: true,
        workspaceAcceptsWork: true,
      });
      if (!assigned.ok) {
        return commandErr(assigned.error);
      }
      yield* dependencies.works.create(assigned.value);

      const events: PendingDomainEvent[] = [
        {
          projectId: envelope.projectId,
          eventType: "WorkAssigned",
          eventVersion: 1,
          occurredAt: envelope.issuedAt,
          aggregateRef: payload.workspaceId,
          actor: envelope.actor,
          causedByCommandId: envelope.commandId,
          payload: {
            workId: payload.workId,
            workspaceId: payload.workspaceId,
            projectId: envelope.projectId,
            objective: payload.objective,
          },
        },
      ];

      return commandOk({
        result: {
          workId: payload.workId,
          workspaceId: payload.workspaceId,
          lifecycle: "Open" as const,
          revision: payload.revision,
        },
        events,
      });
    }),
});
