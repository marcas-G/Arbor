import {
  type DependencyId,
  type DependencyRevision,
  declareDependency,
  type ExpectedDeliverable,
  type ProducerBinding,
  type WorkId,
  type WorkRevision,
} from "@arbor/domain";
import type {
  DependencyRepositoryService,
  PendingDomainEvent,
  WorkRepositoryService,
  WorkspaceRepositoryService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { commandErr, commandOk } from "../command-result.js";
import type { CommandHandler } from "../gateway.js";

/** P7 `01` §2. Declares an unmet result requirement bound to an Open
 * consumer Work at the caller's observed revision. Pure declaration —
 * no Yield / WorkWait side effect (DID §8.16); the emitted
 * `DependencyDeclared` fact is the coordinator re-check trigger (`04` §1). */
export interface DeclareDependencyPayload {
  readonly dependencyId: DependencyId;
  readonly consumerWorkId: WorkId;
  readonly producerBinding: ProducerBinding;
  readonly expectedDeliverable: ExpectedDeliverable;
  readonly expectedConsumerWorkRevision: WorkRevision;
  readonly revision: DependencyRevision;
}

export interface DeclareDependencyResult {
  readonly dependencyId: DependencyId;
  readonly consumerWorkId: WorkId;
  readonly state: "Unsatisfied";
  readonly revision: DependencyRevision;
}

export interface DeclareDependencyDependencies {
  readonly works: Pick<WorkRepositoryService, "findById">;
  readonly workspaces: Pick<WorkspaceRepositoryService, "findById">;
  readonly dependencies: Pick<DependencyRepositoryService, "insert">;
}

export const makeDeclareDependencyHandler = (
  dependencies: DeclareDependencyDependencies,
): CommandHandler<DeclareDependencyPayload, DeclareDependencyResult> => ({
  commandType: "DeclareDependency",
  schemaVersion: "1",
  authority: {
    tag: "DeclareDependencyAuthority",
    // `targetWorkspaceId` is bound at fact projection to the Workspace
    // owning consumerWorkId (§2 authority fact); the payload carries no
    // workspace field, so the pure payload match binds consumerWorkId —
    // a Work belongs to exactly one Workspace, transitively fixing the
    // target.
    targetMatches: (authority, payload) =>
      authority._tag === "DeclareDependencyAuthority" &&
      authority.consumerWorkId === payload.consumerWorkId,
  },
  stopAdmission: { _tag: "NormalExecutionMutation" },
  execute: (envelope) =>
    Effect.gen(function* () {
      const payload = envelope.payload;
      const existing = yield* dependencies.works.findById(
        payload.consumerWorkId,
      );
      if (Option.isNone(existing)) {
        return commandErr({
          _tag: "WorkNotFound",
          workId: payload.consumerWorkId,
        });
      }
      const work = existing.value;
      // Project scoping via CommandEnvelope.projectId (P1).
      if (work.projectId !== envelope.projectId) {
        return commandErr({
          _tag: "WorkNotFound",
          workId: payload.consumerWorkId,
        });
      }
      if (work.lifecycle !== "Open") {
        return commandErr({
          _tag: "TerminalLifecycleMutation",
          entity: "Work",
          lifecycle: work.lifecycle,
        });
      }
      if (work.revision !== payload.expectedConsumerWorkRevision) {
        return commandErr({
          _tag: "RevisionConflict",
          expected: payload.expectedConsumerWorkRevision,
          actual: work.revision,
        });
      }
      const ownerOption = yield* dependencies.workspaces.findById(
        work.workspaceId,
      );
      if (Option.isNone(ownerOption)) {
        return commandErr({
          _tag: "WorkNotFound",
          workId: payload.consumerWorkId,
        });
      }
      if (ownerOption.value.lifecycle !== "Active") {
        return commandErr({
          _tag: "TerminalLifecycleMutation",
          entity: "Workspace",
          lifecycle: ownerOption.value.lifecycle,
        });
      }

      // Cross-Project producer targets are forbidden (§2): the Project
      // boundary precedes any later matching.
      if (payload.producerBinding._tag === "WorkspaceBound") {
        const producerOption = yield* dependencies.workspaces.findById(
          payload.producerBinding.workspaceId,
        );
        if (
          Option.isNone(producerOption) ||
          producerOption.value.projectId !== envelope.projectId
        ) {
          return commandErr({
            _tag: "AuthorityDenied",
            reason:
              "WorkspaceBound producer target not found or outside the project",
          });
        }
      }
      if (payload.producerBinding._tag === "WorkBound") {
        const producerOption = yield* dependencies.works.findById(
          payload.producerBinding.workId,
        );
        if (
          Option.isNone(producerOption) ||
          producerOption.value.projectId !== envelope.projectId
        ) {
          return commandErr({
            _tag: "AuthorityDenied",
            reason:
              "WorkBound producer target not found or outside the project",
          });
        }
      }

      const declared = declareDependency({
        dependencyId: payload.dependencyId,
        consumerWorkId: payload.consumerWorkId,
        producerBinding: payload.producerBinding,
        revision: payload.revision,
        expectedDeliverable: payload.expectedDeliverable,
      });
      // The gateway's CommandHandlerError union predates the P7 dependency
      // store; insert's only failure mode is operational (SqlError), which
      // is unrecoverable at this boundary — the transaction aborts as a
      // defect (the gateway uses the same orDie convention for its own
      // retry-attempt writes). Re-declaration with a different commandId
      // cannot surface here: same-commandId replays are absorbed by the
      // CommandReceipt before the handler runs.
      yield* dependencies.dependencies
        .insert(declared, envelope.projectId)
        .pipe(Effect.orDie);

      const events: PendingDomainEvent[] = [
        {
          projectId: envelope.projectId,
          eventType: "DependencyDeclared",
          eventVersion: 1,
          occurredAt: envelope.issuedAt,
          aggregateRef: payload.dependencyId,
          actor: envelope.actor,
          causedByCommandId: envelope.commandId,
          payload: {
            dependencyId: declared.dependencyId,
            consumerWorkId: declared.consumerWorkId,
            producerBinding: declared.producerBinding,
            expectedDeliverable: declared.expectedDeliverable,
            revision: declared.revision,
          },
        },
      ];

      return commandOk({
        result: {
          dependencyId: declared.dependencyId,
          consumerWorkId: declared.consumerWorkId,
          state: "Unsatisfied",
          revision: declared.revision,
        },
        events,
      });
    }),
});
