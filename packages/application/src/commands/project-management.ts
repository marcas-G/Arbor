import {
  closeProject,
  type Execution,
  type Revision,
  renameProject,
} from "@arbor/domain";
import type {
  ConversationResponseJobStoreService,
  ExecutionRepositoryService,
  InboxProjectionStoreService,
  PendingDomainEvent,
  ProjectRepositoryService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { commandErr, commandOk } from "../command-result.js";
import type { CommandHandler } from "../gateway.js";

export interface RenameProjectPayload {
  readonly name: string;
  readonly expectedRevision: Revision;
}
export interface RenameProjectResult {
  readonly revision: Revision;
  readonly name: string;
}
export interface CloseProjectPayload {
  readonly expectedRevision: Revision;
  readonly confirmed: true;
}
export interface CloseProjectResult {
  readonly revision: Revision;
  readonly lifecycle: "Closed";
}
type RenameProjectDeps = {
  readonly projects: ProjectRepositoryService;
};
type CloseProjectDeps = {
  readonly projects: ProjectRepositoryService;
  readonly executions: ExecutionRepositoryService;
  readonly responseJobs: Pick<
    ConversationResponseJobStoreService,
    "listForWorkspace" | "transition"
  >;
  readonly inbox: Pick<InboxProjectionStoreService, "markConsumed">;
};

const governance = (commandType: "RenameProject" | "CloseProject") => ({
  tag: "ProjectGovernanceAuthority" as const,
  targetMatches: (authority: import("../authority.js").CommandAuthorityFact) =>
    authority._tag === "ProjectGovernanceAuthority" &&
    authority.commandType === commandType,
});

export const makeRenameProjectHandler = (
  deps: RenameProjectDeps,
): CommandHandler<RenameProjectPayload, RenameProjectResult> => ({
  commandType: "RenameProject",
  schemaVersion: "1",
  authority: governance("RenameProject"),
  stopAdmission: { _tag: "Unclassified" },
  execute: (envelope) =>
    Effect.gen(function* () {
      const project = yield* deps.projects.findById(envelope.projectId);
      if (Option.isNone(project))
        return commandErr({
          _tag: "AuthorityDenied",
          reason: "project not found",
        });
      const renamed = renameProject(project.value, {
        authorized: true,
        expectedRevision: envelope.payload.expectedRevision,
        name: envelope.payload.name,
      });
      if (!renamed.ok) return commandErr(renamed.error);
      yield* deps.projects.renameIfRevision(
        envelope.projectId,
        project.value.revision,
        renamed.value.name,
        renamed.value.revision,
      );
      const events: PendingDomainEvent[] = [
        {
          projectId: envelope.projectId,
          eventType: "ProjectRenamed",
          eventVersion: 1,
          occurredAt: envelope.issuedAt,
          aggregateRef: envelope.projectId,
          actor: envelope.actor,
          causedByCommandId: envelope.commandId,
          payload: {
            projectId: envelope.projectId,
            previousName: project.value.name,
            name: renamed.value.name,
            revision: renamed.value.revision,
          },
        },
      ];
      return commandOk({
        result: { name: renamed.value.name, revision: renamed.value.revision },
        events,
      });
    }),
});

export const makeCloseProjectHandler = (
  deps: CloseProjectDeps,
): CommandHandler<CloseProjectPayload, CloseProjectResult> => ({
  commandType: "CloseProject",
  schemaVersion: "1",
  authority: governance("CloseProject"),
  stopAdmission: { _tag: "Unclassified" },
  execute: (envelope) =>
    Effect.gen(function* () {
      if (envelope.payload.confirmed !== true)
        return commandErr({
          _tag: "AuthorityDenied",
          reason: "CloseProject requires confirmation",
        });
      const project = yield* deps.projects.findById(envelope.projectId);
      if (Option.isNone(project))
        return commandErr({
          _tag: "AuthorityDenied",
          reason: "project not found",
        });
      if (project.value.revision !== envelope.payload.expectedRevision)
        return commandErr({
          _tag: "RevisionConflict",
          expected: envelope.payload.expectedRevision,
          actual: project.value.revision,
        });
      const closed = closeProject(project.value, { authorized: true });
      if (!closed.ok) return commandErr(closed.error);
      const responseJobs = yield* deps.responseJobs.listForWorkspace(
        project.value.rootWorkspaceId,
      );
      yield* deps.projects.closeIfRevision(
        envelope.projectId,
        project.value.revision,
        closed.value.revision,
      );
      const executions = deps.executions;
      let activeExecutions: ReadonlyArray<Execution> = [];
      activeExecutions = (yield* executions.findUnsettledExecutions()).filter(
        (execution) => execution.projectId === envelope.projectId,
      );
      for (const execution of activeExecutions) {
        yield* executions.requestStop(execution.executionId, envelope.issuedAt);
      }
      for (const job of responseJobs) {
        if (
          job.state._tag === "Answered" ||
          job.state._tag === "Cancelled" ||
          job.state._tag === "Running"
        ) {
          continue;
        }
        yield* deps.responseJobs
          .transition({
            messageId: job.messageId,
            expectedRevision: job.revision,
            expectedState: job.state._tag,
            next: {
              ...job,
              state: { _tag: "Cancelled", reason: "ProjectClosed" },
              revision: job.revision + 1,
              updatedAt: envelope.issuedAt,
            },
          })
          .pipe(
            Effect.catchTag("ConversationJobConflict", () =>
              Effect.fail({
                _tag: "ConversationJobStoreRevisionConflict" as const,
              }),
            ),
          );
        yield* deps.inbox.markConsumed(
          job.rootWorkspaceId,
          `humanmsg:${job.messageId}`,
        );
      }
      const events: PendingDomainEvent[] = [
        {
          projectId: envelope.projectId,
          eventType: "ProjectClosed",
          eventVersion: 1,
          occurredAt: envelope.issuedAt,
          aggregateRef: envelope.projectId,
          actor: envelope.actor,
          causedByCommandId: envelope.commandId,
          payload: {
            projectId: envelope.projectId,
            revision: closed.value.revision,
          },
        },
        ...activeExecutions.map(
          (execution): PendingDomainEvent => ({
            projectId: envelope.projectId,
            eventType: "ExecutionStopRequested",
            eventVersion: 1,
            occurredAt: envelope.issuedAt,
            aggregateRef: execution.executionId,
            actor: envelope.actor,
            causedByCommandId: envelope.commandId,
            payload: {
              executionId: execution.executionId,
              reason: "ProjectClosed",
            },
          }),
        ),
      ];
      return commandOk({
        result: {
          lifecycle: "Closed" as const,
          revision: closed.value.revision,
        },
        events,
      });
    }),
});
