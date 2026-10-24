import {
  amendWorkContract,
  directionGuideWork,
  type WorkContractSnapshot,
  type WorkId,
  type WorkRevision,
  type WorkspaceId,
} from "@arbor/domain";
import type {
  InboxProjectionStoreService,
  PendingDomainEvent,
  WorkBlockerStoreService,
  WorkContractRevisionRepositoryService,
  WorkRepositoryService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { commandErr, commandOk } from "../command-result.js";
import type { CommandHandler } from "../gateway.js";
import {
  emitHumanIntervention,
  isHumanOriginatedPrincipal,
} from "../human-intervention.js";

/** P6 `04` §2. Human steer payload; the guidance ContentRef enters the
 * target Workspace Inbox (bounded view), never a Session write. The base
 * handler applies the declared severity to WorkSteered; production wraps it
 * with the Gateway-owned Critical Steer/StopExecution composite. */
export interface SteerWorkPayload {
  readonly workId: WorkId;
  readonly workspaceId: WorkspaceId;
  readonly steer:
    | {
        /** Legacy schema-v1: guidance only, including scope=Constraint. */
        readonly severity: "Normal" | "Critical";
        readonly guidance: string;
        readonly scope?: "Direction" | "Constraint";
      }
    | {
        readonly severity: "Normal" | "Critical";
        readonly operation: SteerOperation;
      };
  readonly expectedWorkRevision: WorkRevision;
  readonly provenance: {
    readonly source: "HumanInput";
  };
}

export type SteerOperation =
  | { readonly kind: "DirectionGuidance"; readonly guidance: string }
  | {
      readonly kind: "ContractAmendment";
      readonly amendment: WorkContractSnapshot;
    };

export interface SteerWorkResult {
  readonly workId: WorkId;
  readonly workspaceId: WorkspaceId;
  readonly lifecycle: "Open";
  readonly fromRevision: WorkRevision;
  readonly toRevision: WorkRevision;
  readonly severity: "Normal" | "Critical";
}

export interface SteerWorkDependencies {
  readonly works: Pick<
    WorkRepositoryService,
    "findById" | "refineIfRevision" | "replaceContractIfRevision"
  >;
  /** Omitted only by legacy P6 test fixtures; production composition wires the P52-backed store. */
  readonly revisions?: Pick<WorkContractRevisionRepositoryService, "append">;
  readonly inbox: Pick<InboxProjectionStoreService, "admitUpsert"> &
    Partial<Pick<InboxProjectionStoreService, "admitUpsertSequenced">>;
  readonly blockers?: Pick<
    WorkBlockerStoreService,
    "listByWorkRevision" | "supersede"
  >;
}

export const makeSteerWorkHandler = (
  dependencies: SteerWorkDependencies,
): CommandHandler<SteerWorkPayload, SteerWorkResult> => ({
  commandType: "SteerWork",
  // The public envelope/result shape remains backward-compatible: legacy
  // guidance and typed operations are disjoint payload alternatives under
  // the existing receipt schema. The semantic fingerprint includes the
  // complete payload, so amendments cannot alias historical guidance.
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
      if (!isHumanOriginatedPrincipal(context.principal)) {
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

      const operation =
        "operation" in payload.steer
          ? payload.steer.operation
          : {
              kind: "DirectionGuidance" as const,
              guidance: payload.steer.guidance,
            };
      if (
        operation.kind === "ContractAmendment" &&
        dependencies.revisions === undefined
      ) {
        return yield* Effect.die(
          new Error("WorkContractRevisionRepositoryUnavailable"),
        );
      }
      const steered =
        operation.kind === "DirectionGuidance"
          ? directionGuideWork(work, { authorized: true })
          : amendWorkContract(work, {
              authorized: true,
              contract: operation.amendment,
            });
      if (!steered.ok) {
        return commandErr(steered.error);
      }
      const next = steered.value;
      const nextContract: WorkContractSnapshot = {
        objective: next.objective,
        why: next.why,
        constraints: next.constraints,
        completionExpectation: next.completionExpectation,
        verificationMission: next.verificationMission,
      };
      if (dependencies.revisions === undefined) {
        // Historical P6 harnesses use pre-P52 schemas and exercise only the
        // existing legacy DirectionGuidance route. Production composition
        // always supplies the history repository.
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
      } else {
        yield* dependencies.works.replaceContractIfRevision(
          payload.workId,
          work.revision,
          nextContract,
          next.revision,
        );
        yield* dependencies.revisions.append({
          workId: payload.workId,
          workRevision: next.revision,
          contract: nextContract,
          kind: operation.kind,
          sourceCommandId: envelope.commandId,
          actor: envelope.actor,
          provenance: payload.provenance,
          recordedAt: envelope.issuedAt,
        });
      }

      const interventionSummary =
        operation.kind === "DirectionGuidance"
          ? operation.guidance
          : operation.amendment.why;
      const workEvent: PendingDomainEvent =
        operation.kind === "DirectionGuidance"
          ? {
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
            }
          : {
              projectId: envelope.projectId,
              eventType: "WorkAmended",
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
            };

      const events: PendingDomainEvent[] = [
        workEvent,
        // P10 `06` §2 (inherited evolution — P6 not reopened): the same
        // semantic transaction pairs the WorkSteered event (frozen P6
        // `04` §2 payload above) with HumanInterventionApplied, kind by
        // severity. Both ride the single gateway transaction.
        emitHumanIntervention({
          projectId: envelope.projectId,
          commandId: envelope.commandId,
          actor: envelope.actor,
          targetWorkspaceId: payload.workspaceId,
          summaryRef: interventionSummary,
          occurredAt: envelope.issuedAt,
          kind:
            payload.steer.severity === "Critical" ? "CriticalSteer" : "Steer",
        }),
      ];

      if (dependencies.blockers !== undefined) {
        const currentBlockers = yield* dependencies.blockers.listByWorkRevision(
          payload.workId,
          work.revision,
        );
        yield* dependencies.blockers.supersede(payload.workId, work.revision);
        for (const blocker of currentBlockers) {
          if (blocker.state !== "Open") continue;
          events.push({
            projectId: envelope.projectId,
            eventType: "WorkBlockerSuperseded",
            eventVersion: 1,
            occurredAt: envelope.issuedAt,
            aggregateRef: payload.workId,
            actor: envelope.actor,
            causedByCommandId: envelope.commandId,
            payload: {
              blockerId: blocker.blockerId,
              workId: payload.workId,
              previousWorkRevision: work.revision,
              currentWorkRevision: next.revision,
              supersededAt: envelope.issuedAt,
            },
          });
        }
      }

      // P6 `04` §3: admission goes to the target Workspace Inbox only —
      // never a Session write. Promotion semantics belong to the next task.
      const inboxEntry = {
        recipientWorkspaceId: payload.workspaceId,
        entryKey: `steer:${payload.workId}:${next.revision}`,
        kind: "HumanInput",
        summary:
          operation.kind === "DirectionGuidance"
            ? `${payload.steer.severity} steer: ${operation.guidance}`
            : `${payload.steer.severity} contract amendment: ${operation.amendment.objective}`,
        admittedAt: envelope.issuedAt,
      } as const;
      if (
        dependencies.blockers !== undefined &&
        dependencies.inbox.admitUpsertSequenced !== undefined
      ) {
        yield* dependencies.inbox.admitUpsertSequenced(inboxEntry);
      } else {
        yield* dependencies.inbox.admitUpsert(inboxEntry);
      }

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
