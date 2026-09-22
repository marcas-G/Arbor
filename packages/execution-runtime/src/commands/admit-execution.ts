import { type CommandHandler, commandErr, commandOk } from "@arbor/application";
import {
  admitExecution,
  type CommandSubmissionContext,
  ContextEpochNumber,
  createSession,
  type ExecutionBinding,
  type ExecutionFocus,
  type ExecutionId,
  parse,
  type SessionId,
  type WorkspaceId,
} from "@arbor/domain";
import type {
  ExecutionRepositoryService,
  PendingDomainEvent,
  ProjectRepositoryService,
  SessionRepositoryService,
  WorkspaceRepositoryService,
} from "@arbor/ports";
import { Effect, Option } from "effect";

export type AdmitExecutionPayload =
  | {
      readonly _tag: "WorkspaceMain";
      readonly executionId: ExecutionId;
      readonly workspaceId: WorkspaceId;
      readonly focus: ExecutionFocus;
    }
  | {
      readonly _tag: "ExecutionBound";
      readonly executionId: ExecutionId;
      readonly workspaceId: WorkspaceId;
      /** M-3 (P8 `02` §1, declared P2 inherited evolution): Verifier
       * executions bind without a causal parent — the domain binding is
       * already `ExecutionId | null`; specialists keep passing a parent. */
      readonly parentExecutionId: ExecutionId | null;
      readonly mission: string;
      readonly sessionId: SessionId;
    };

export interface AdmitExecutionResult {
  readonly executionId: ExecutionId;
  readonly workspaceId: WorkspaceId;
  readonly sessionId: SessionId;
  readonly bindingKind: "WorkspaceMain" | "ExecutionBound";
}

export interface AdmitExecutionDependencies {
  readonly projects: ProjectRepositoryService;
  readonly workspaces: WorkspaceRepositoryService;
  readonly sessions: SessionRepositoryService;
  readonly executions: ExecutionRepositoryService;
}

export const makeAdmitExecutionHandler = (
  dependencies: AdmitExecutionDependencies,
): CommandHandler<AdmitExecutionPayload, AdmitExecutionResult> => ({
  commandType: "AdmitExecution",
  schemaVersion: "1",
  authority: {
    tag: "AdmitExecutionAuthority",
    targetMatches: (authority, payload) =>
      authority._tag === "AdmitExecutionAuthority" &&
      authority.workspaceId === payload.workspaceId &&
      authority.bindingKind === payload._tag,
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

      const isMain = payload._tag === "WorkspaceMain";
      const sessionId = isMain
        ? currentWorkspace.primarySessionId
        : payload.sessionId;
      const binding: ExecutionBinding = isMain
        ? {
            _tag: "WorkspaceExecution",
            workspaceId: payload.workspaceId,
            focus: payload.focus,
          }
        : {
            _tag: "ExecutionBoundAgentBinding",
            parentExecutionId: payload.parentExecutionId,
            mission: payload.mission,
          };
      const admitted = admitExecution({
        executionId: payload.executionId,
        projectId: envelope.projectId,
        workspaceId: payload.workspaceId,
        binding,
        sessionId,
        admittedAt: envelope.issuedAt,
        noOtherActiveMain: true,
      });
      if (!admitted.ok) {
        return commandErr(admitted.error);
      }

      if (isMain) {
        const inserted = yield* dependencies.executions.tryAdmitMainExecution(
          admitted.value,
        );
        if (Option.isNone(inserted)) {
          return commandErr({
            _tag: "ActiveExecutionConflict",
            workspaceId: payload.workspaceId,
          });
        }
      } else {
        yield* dependencies.sessions.create(
          createSession({
            sessionId: payload.sessionId,
            binding: {
              _tag: "ExecutionScoped",
              executionId: payload.executionId,
            },
            contextEpoch: parse(ContextEpochNumber)(0),
          }),
        );
        yield* dependencies.executions.admitExecution(admitted.value);
      }

      const events: PendingDomainEvent[] = [
        {
          projectId: envelope.projectId,
          eventType: "ExecutionAdmitted",
          eventVersion: 1,
          occurredAt: envelope.issuedAt,
          aggregateRef: payload.workspaceId,
          actor: envelope.actor,
          causedByCommandId: envelope.commandId,
          payload: {
            executionId: payload.executionId,
            workspaceId: payload.workspaceId,
            bindingKind: payload._tag,
          },
        },
      ];

      return commandOk({
        result: {
          executionId: payload.executionId,
          workspaceId: payload.workspaceId,
          sessionId,
          bindingKind: payload._tag,
        },
        events,
      });
    }),
});
