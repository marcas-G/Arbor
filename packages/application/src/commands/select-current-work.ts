import {
  type ActiveMainFocusFact,
  type CandidateWorkFact,
  type Revision,
  selectCurrentWork,
  type WorkId,
  type WorkspaceId,
} from "@arbor/domain";
import type {
  ExecutionRepositoryService,
  PendingDomainEvent,
  WorkRepositoryService,
  WorkspaceRepositoryService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { commandErr, commandOk } from "../command-result.js";
import type { CommandHandler } from "../gateway.js";

/**
 * `SelectCurrentWork` (DID §1.4 / §8.18A; P5 `01` §3.1). The canonical
 * mutation of `workspace.currentWorkId`. The **selection decision** is owned by
 * the scheduler evaluator; this handler only applies the decision it is given
 * (the caller must pass the evaluator's exact `workId`). First implemented and
 * integrated by P5; P6/P7 reuse it.
 */
export interface SelectCurrentWorkPayload {
  readonly workspaceId: WorkspaceId;
  readonly workId: WorkId;
  readonly expectedWorkspaceRevision: Revision;
}

export interface SelectCurrentWorkResult {
  readonly workspaceId: WorkspaceId;
  readonly workId: WorkId;
  readonly revision: Revision;
}

export interface SelectCurrentWorkDependencies {
  readonly workspaces: WorkspaceRepositoryService;
  readonly works: WorkRepositoryService;
  readonly executions: ExecutionRepositoryService;
}

export const makeSelectCurrentWorkHandler = (
  dependencies: SelectCurrentWorkDependencies,
): CommandHandler<SelectCurrentWorkPayload, SelectCurrentWorkResult> => ({
  commandType: "SelectCurrentWork",
  schemaVersion: "1",
  authority: {
    tag: "SelectCurrentWorkAuthority",
    targetMatches: (authority, payload) =>
      authority._tag === "SelectCurrentWorkAuthority" &&
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

      const work = yield* dependencies.works.findById(payload.workId);
      if (Option.isNone(work)) {
        return commandErr({
          _tag: "AuthorityDenied",
          reason: "SelectCurrentWork candidate not found",
        });
      }
      const candidate: CandidateWorkFact = {
        workId: work.value.workId,
        workspaceId: work.value.workspaceId,
        lifecycle: work.value.lifecycle,
      };

      const active = yield* dependencies.executions.findActiveMainByWorkspace(
        payload.workspaceId,
      );
      const activeMainFocus: ActiveMainFocusFact | null = Option.isSome(active)
        ? {
            kind:
              active.value.binding._tag === "WorkspaceExecution" &&
              active.value.binding.focus._tag === "Work"
                ? "Work"
                : "Coordination",
            workId:
              active.value.binding._tag === "WorkspaceExecution" &&
              active.value.binding.focus._tag === "Work"
                ? active.value.binding.focus.workId
                : null,
          }
        : null;

      const transitioned = selectCurrentWork(currentWorkspace, {
        authorized: true,
        expectedRevision: payload.expectedWorkspaceRevision,
        candidate,
        activeMainFocus,
      });
      if (!transitioned.ok) {
        return commandErr(transitioned.error);
      }

      yield* dependencies.workspaces.selectCurrentWorkIfRevision(
        payload.workspaceId,
        payload.expectedWorkspaceRevision,
        payload.workId,
        transitioned.value.revision,
      );

      const events: PendingDomainEvent[] = [
        {
          projectId: envelope.projectId,
          eventType: "CurrentWorkChanged",
          eventVersion: 1,
          occurredAt: envelope.issuedAt,
          aggregateRef: payload.workspaceId,
          actor: envelope.actor,
          causedByCommandId: envelope.commandId,
          payload: {
            workspaceId: payload.workspaceId,
            workId: payload.workId,
            revision: transitioned.value.revision,
          },
        },
      ];

      return commandOk({
        result: {
          workspaceId: payload.workspaceId,
          workId: payload.workId,
          revision: transitioned.value.revision,
        },
        events,
      });
    }),
});
