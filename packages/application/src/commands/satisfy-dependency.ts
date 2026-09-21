import {
  type ArtifactRole,
  CommandId,
  type DeliverableId,
  type DeliverableKind,
  type DeliverableMatchView,
  type DependencyId,
  type DependencyRevision,
  type ExecutionId,
  parse,
  satisfyDependency,
  type WakeReason,
  type WorkspaceId,
} from "@arbor/domain";
import type {
  DeliverableRepositoryService,
  DependencyRepositoryService,
  PendingDomainEvent,
  WorkRepositoryService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import {
  SATISFY_AUTHORITY_SOURCES,
  type VerifiedCommandAuthority,
} from "../authority.js";
import { commandErr, commandOk } from "../command-result.js";
import { newUuid7 } from "../formation-plan.js";
import type { CommandHandler } from "../gateway.js";

/** P7 `01` §4 (v1.10 G6): the single Dependency-satisfaction command face.
 * Agent path and coordinator path submit the same Command, hit the same
 * rejection table and the same frozen matcher — no agent-path exemption;
 * request ≠ satisfaction: the authority fact legalizes submission, the
 * matcher decides the fact. Satisfaction records are immutable
 * (`satisfiedAtDependencyRevision`); later revisions never reinterpret
 * them. */
export interface SatisfyDependencyPayload {
  readonly dependencyId: DependencyId;
  readonly targetDependencyRevision: DependencyRevision;
  readonly deliverableId: DeliverableId;
}

/** P7 `06` §2 wake production (same commit boundary). The payload lives in
 * the delivery record, never in the WakeReason type (P2-frozen, not
 * extended). This handler only produces the signals; delivery-record
 * persistence and consumer-side routing are the gateway committer's /
 * P7-011's duty. */
export interface SatisfyDependencyWakeSignal {
  readonly workspaceId: WorkspaceId;
  readonly reason: WakeReason;
  readonly detail: {
    readonly dependencyId: DependencyId;
    readonly fromRevision: DependencyRevision;
    readonly toRevision: DependencyRevision;
  };
}

export interface SatisfyDependencyResult {
  readonly dependencyId: DependencyId;
  readonly state: "Satisfied";
  readonly dependencyRevision: DependencyRevision;
  readonly deliverableId: DeliverableId;
  readonly satisfiedAtDependencyRevision: DependencyRevision;
  readonly wakeSignals: ReadonlyArray<SatisfyDependencyWakeSignal>;
}

type SatisfyDependencyAuthorityFact = Extract<
  VerifiedCommandAuthority,
  { _tag: "SatisfyDependencyAuthority" }
>;

export interface SatisfyDependencyDependencies {
  readonly dependencies: Pick<
    DependencyRepositoryService,
    "findById" | "transitionIfUnsatisfiedRevision"
  >;
  readonly deliverables: Pick<
    DeliverableRepositoryService,
    "findById" | "listArtifactRoles"
  >;
  readonly works: Pick<WorkRepositoryService, "findById">;
  /** Optional G6 seam: verify that a `ConsumerExecution` source is an
   * execution of the Workspace owning the consumer Work
   * (`targetWorkspaceId`). Minimal contract: deps are not forced — the
   * submission-time fact projection guarantees the binding; the callback
   * exists so later wiring can enforce it without changing the face. */
  readonly verifyConsumerExecution?: (
    source: {
      readonly workspaceId: WorkspaceId;
      readonly executionId: ExecutionId;
    },
    targetWorkspaceId: WorkspaceId,
  ) => boolean;
}

/** Automatic-path deterministic CommandId (§4; DID §5.4; P6 `01` §4.2
 * precedent): at-least-once redelivery is absorbed idempotently by the
 * existing receipt. Agent path uses caller-preallocated ids. */
export const satisfactionCommandId = (
  deliverableId: DeliverableId,
  dependencyId: DependencyId,
  revision: DependencyRevision,
): CommandId =>
  parse(CommandId)(
    `cmd_${newUuid7(
      "satisfy",
      `${deliverableId}:${dependencyId}:${revision}`,
    )}`,
  );

const isExactBoundSource = (
  source: SatisfyDependencyAuthorityFact["source"],
): boolean =>
  SATISFY_AUTHORITY_SOURCES.some((allowed) => allowed._tag === source._tag);

export const makeSatisfyDependencyHandler = (
  dependencies: SatisfyDependencyDependencies,
): CommandHandler<SatisfyDependencyPayload, SatisfyDependencyResult> => ({
  commandType: "SatisfyDependency",
  schemaVersion: "1",
  authority: {
    tag: "SatisfyDependencyAuthority",
    // Exact-bound fact (G6): the authority binds (dependencyId,
    // deliverableId); `targetWorkspaceId` is bound at fact projection to
    // the Workspace owning the consumer Work (§4). The TS type already
    // two-values `source`; the runtime membership check keeps the bound
    // explicit at the command face.
    targetMatches: (authority, payload) => {
      if (authority._tag !== "SatisfyDependencyAuthority") {
        return false;
      }
      if (!isExactBoundSource(authority.source)) {
        return false;
      }
      if (
        authority.source._tag === "ConsumerExecution" &&
        dependencies.verifyConsumerExecution !== undefined &&
        !dependencies.verifyConsumerExecution(
          authority.source,
          authority.targetWorkspaceId,
        )
      ) {
        return false;
      }
      return (
        authority.dependencyId === payload.dependencyId &&
        authority.deliverableId === payload.deliverableId
      );
    },
  },
  stopAdmission: { _tag: "NormalExecutionMutation" },
  execute: (envelope) =>
    Effect.gen(function* () {
      const payload = envelope.payload;

      // Rejection table (§4, frozen order): not found → terminal →
      // revision. The store channels not carried by the gateway error
      // union are defects-only here (semantic-boundary convention).
      const existing = yield* dependencies.dependencies
        .findById(payload.dependencyId)
        .pipe(Effect.orDie);
      if (Option.isNone(existing)) {
        return commandErr({
          _tag: "DependencyNotFound",
          dependencyId: payload.dependencyId,
        });
      }
      const dependency = existing.value;
      if (dependency.state !== "Unsatisfied") {
        return commandErr({
          _tag: "TerminalLifecycleMutation",
          entity: "Dependency",
          lifecycle: dependency.state,
        });
      }
      if (dependency.revision !== payload.targetDependencyRevision) {
        return commandErr({
          _tag: "RevisionConflict",
          expected: payload.targetDependencyRevision,
          actual: dependency.revision,
        });
      }

      const storedOption = yield* dependencies.deliverables
        .findById(payload.deliverableId)
        .pipe(Effect.orDie);
      if (Option.isNone(storedOption)) {
        return commandErr({
          _tag: "DeliverableNotFound",
          deliverableId: payload.deliverableId,
        });
      }
      const deliverable = storedOption.value;

      // Matcher input: works→workspace mapping for the deliverable's
      // source Work. A deliverable row without its source Work row is a
      // referential-integrity break — defect, not a domain rejection.
      const sourceWorkOption = yield* dependencies.works.findById(
        deliverable.sourceWorkId,
      );
      if (Option.isNone(sourceWorkOption)) {
        return yield* Effect.die(
          new Error(
            `deliverable ${payload.deliverableId} has no source work row (${deliverable.sourceWorkId})`,
          ),
        );
      }
      const roles = yield* dependencies.deliverables
        .listArtifactRoles(payload.deliverableId)
        .pipe(Effect.orDie);
      const view: DeliverableMatchView = {
        deliverableId: deliverable.deliverableId,
        sourceWorkId: deliverable.sourceWorkId,
        sourceWorkspaceId: sourceWorkOption.value.workspaceId,
        kind: deliverable.kind as DeliverableKind,
        artifactRoles: new Set(roles as ReadonlyArray<ArtifactRole>),
      };

      // Matcher authoritative: the frozen domain transition re-evaluates
      // matchesExpectedDeliverable — false is DependencyNotSatisfiable with
      // no state change (DID §1.8).
      const next = satisfyDependency(dependency, view);
      if (!next.ok) {
        return commandErr(next.error);
      }

      // State + revision CAS: first committer wins (§4 Concurrency, §10).
      const applied = yield* dependencies.dependencies
        .transitionIfUnsatisfiedRevision(
          payload.dependencyId,
          payload.targetDependencyRevision,
          next.value,
        )
        .pipe(Effect.orDie);
      if (Option.isNone(applied)) {
        // Lost race: classify the loser's typed rejection by what it now
        // observes — terminal, matcher-false under the revised contract,
        // or a stale revision binding.
        const reread = yield* dependencies.dependencies
          .findById(payload.dependencyId)
          .pipe(Effect.orDie);
        const current = Option.isNone(reread) ? dependency : reread.value;
        if (current.state !== "Unsatisfied") {
          return commandErr({
            _tag: "TerminalLifecycleMutation",
            entity: "Dependency",
            lifecycle: current.state,
          });
        }
        const reevaluated = satisfyDependency(current, view);
        if (!reevaluated.ok) {
          return commandErr(reevaluated.error);
        }
        return commandErr({
          _tag: "RevisionConflict",
          expected: payload.targetDependencyRevision,
          actual: current.revision,
        });
      }

      // Wake production (P7 `06` §2): the consumer Work's Workspace. The
      // domain transition keeps the revision on satisfaction —
      // fromRevision == toRevision; WorkWait observedRevision comparison
      // is the consumer side's (011), not this boundary's.
      const consumerWorkOption = yield* dependencies.works.findById(
        dependency.consumerWorkId,
      );
      if (Option.isNone(consumerWorkOption)) {
        return yield* Effect.die(
          new Error(
            `dependency ${payload.dependencyId} has no consumer work row (${dependency.consumerWorkId})`,
          ),
        );
      }
      const wakeSignals: ReadonlyArray<SatisfyDependencyWakeSignal> = [
        {
          workspaceId: consumerWorkOption.value.workspaceId,
          reason: { _tag: "DependencySatisfied" },
          detail: {
            dependencyId: payload.dependencyId,
            fromRevision: dependency.revision,
            toRevision: next.value.revision,
          },
        },
      ];

      const events: PendingDomainEvent[] = [
        {
          projectId: envelope.projectId,
          eventType: "DependencySatisfied",
          eventVersion: 1,
          occurredAt: envelope.issuedAt,
          aggregateRef: payload.dependencyId,
          actor: envelope.actor,
          causedByCommandId: envelope.commandId,
          payload: {
            dependencyId: payload.dependencyId,
            targetDependencyRevision: payload.targetDependencyRevision,
            deliverableId: payload.deliverableId,
            satisfiedAtDependencyRevision:
              next.value.satisfiedAtDependencyRevision ?? next.value.revision,
          },
        },
      ];

      return commandOk({
        result: {
          dependencyId: payload.dependencyId,
          state: "Satisfied",
          dependencyRevision: next.value.revision,
          deliverableId: payload.deliverableId,
          satisfiedAtDependencyRevision:
            next.value.satisfiedAtDependencyRevision ?? next.value.revision,
          wakeSignals,
        },
        events,
      });
    }),
});
