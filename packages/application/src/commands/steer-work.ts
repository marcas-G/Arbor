import {
  type Principal,
  type SteerWorkInput,
  steerWork,
  type WorkId,
  type WorkRevision,
  type WorkspaceId,
} from "@arbor/domain";
import type {
  InboxProjectionStoreService,
  PendingDomainEvent,
  WorkRepositoryService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { commandErr, commandOk } from "../command-result.js";
import type { CommandHandler } from "../gateway.js";

/** P6 `04` §2. Human steer payload; the guidance ContentRef enters the
 * target Workspace Inbox (bounded view), never a Session write. `severity`
 * is persisted as declared — the Critical quiescence wiring is a separate
 * task (P6-012); this handler treats Normal and Critical identically. */
export interface SteerWorkPayload {
  readonly workId: WorkId;
  readonly workspaceId: WorkspaceId;
  readonly steer: {
    readonly severity: "Normal" | "Critical";
    readonly guidance: string;
    readonly scope?: "Direction" | "Constraint";
  };
  readonly expectedWorkRevision: WorkRevision;
  readonly provenance: {
    readonly source: "HumanInput";
  };
}

export interface SteerWorkResult {
  readonly workId: WorkId;
  readonly workspaceId: WorkspaceId;
  readonly lifecycle: "Open";
  readonly fromRevision: WorkRevision;
  readonly toRevision: WorkRevision;
  readonly severity: "Normal" | "Critical";
}

export interface SteerWorkDependencies {
  readonly works: Pick<WorkRepositoryService, "findById" | "refineIfRevision">;
  readonly inbox: Pick<InboxProjectionStoreService, "admitUpsert">;
}

const isHumanPrincipal = (principal: Principal): boolean =>
  principal.startsWith("user:");

export const makeSteerWorkHandler = (
  dependencies: SteerWorkDependencies,
): CommandHandler<SteerWorkPayload, SteerWorkResult> => ({
  commandType: "SteerWork",
  schemaVersion: "1",
  authority: {
    tag: "SteerWorkAuthority",
    targetMatches: (authority, payload) =>
      authority._tag === "SteerWorkAuthority" &&
      authority.targetWorkspaceId === payload.workspaceId &&
      authority.workId === payload.workId,
  },
  stopAdmission: { _tag: "NormalExecutionMutation" },
  execute: (envelope, context) =>
    Effect.gen(function* () {
      const payload = envelope.payload;
      const existing = yield* dependencies.works.findById(payload.workId);
      if (Option.isNone(existing)) {
        return commandErr({ _tag: "WorkNotFound", workId: payload.workId });
      }
      const work = existing.value;
      if (work.workspaceId !== payload.workspaceId) {
        return commandErr({ _tag: "WorkNotFound", workId: payload.workId });
      }
      if (work.lifecycle !== "Open") {
        return commandErr({
          _tag: "TerminalLifecycleMutation",
          entity: "Work",
          lifecycle: work.lifecycle,
        });
      }
      if (!isHumanPrincipal(context.principal)) {
        return commandErr({
          _tag: "AuthorityDenied",
          reason:
            "SteerWork is human steer only: principal must use the user: prefix",
        });
      }
      if (work.revision !== payload.expectedWorkRevision) {
        return commandErr({
          _tag: "RevisionConflict",
          expected: payload.expectedWorkRevision,
          actual: work.revision,
        });
      }

      // Semantic steer does not rewrite protected fields here: the guidance
      // rides the Inbox; the domain transition carries the WorkRevision
      // increment (DID §2.3) and would surface AuthorityDenied if a producer
      // path ever weakened protected requirements.
      const input: SteerWorkInput = {
        authorized: true,
        weakensProtectedRequirements: false,
      };
      const steered = steerWork(work, input);
      if (!steered.ok) {
        return commandErr(steered.error);
      }
      const next = steered.value;
      yield* dependencies.works.refineIfRevision(
        payload.workId,
        work.revision,
        {
          objective: next.objective,
          completionExpectation: next.completionExpectation,
          verificationMission: next.verificationMission,
        },
        next.revision,
      );

      const events: PendingDomainEvent[] = [
        {
          projectId: envelope.projectId,
          eventType: "WorkSteered",
          eventVersion: 1,
          occurredAt: envelope.issuedAt,
          aggregateRef: payload.workId,
          actor: envelope.actor,
          causedByCommandId: envelope.commandId,
          payload: {
            workId: payload.workId,
            fromRevision: work.revision,
            toRevision: next.revision,
            severity: payload.steer.severity,
          },
        },
      ];

      // P6 `04` §3: admission goes to the target Workspace Inbox only —
      // never a Session write. Promotion semantics belong to the next task.
      yield* dependencies.inbox.admitUpsert({
        recipientWorkspaceId: payload.workspaceId,
        entryKey: `steer:${payload.workId}:${next.revision}`,
        kind: "HumanInput",
        summary: `${payload.steer.severity} steer: ${payload.steer.guidance}`,
        admittedAt: envelope.issuedAt,
      });

      return commandOk({
        result: {
          workId: payload.workId,
          workspaceId: payload.workspaceId,
          lifecycle: "Open",
          fromRevision: work.revision,
          toRevision: next.revision,
          severity: payload.steer.severity,
        },
        events,
      });
    }),
});
