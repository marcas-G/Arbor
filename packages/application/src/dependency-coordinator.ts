import {
  Actor,
  type ArtifactRole,
  type CommandSubmissionContext,
  type DeliverableId,
  type DeliverableKind,
  type DeliverableMatchView,
  type Dependency,
  type DependencyId,
  matchesExpectedDeliverable,
  type Principal,
  type ProjectId,
  parse,
  type WorkId,
  type WorkspaceId,
} from "@arbor/domain";
import { Effect, Option } from "effect";
import {
  type SatisfyDependencyPayload,
  satisfactionCommandId,
} from "./commands/satisfy-dependency.js";
import { semanticRequestFingerprint } from "./fingerprint.js";
import type { CommandGatewayService, GatewayEnvelope } from "./gateway.js";

/** P7 `04` §1 (DID v1.10 G5/G6): the event-driven satisfaction coordinator —
 * an at-least-once consumer on the project event stream. Fully
 * deterministic, no model calls, no AgentId (a runtime execution role, not
 * a long-term entity). Its ONLY mutation face is the same `SatisfyDependency`
 * Command the agent explicit path uses; it never bypasses the Command
 * Handler. This module owns the trigger consumption and candidate-pair
 * submission; P1 consumer-infrastructure wiring (poll/offset/dead-letters)
 * is the P7-011/012 composition, so the consumer here is a pure
 * events-array-driven function (formation-consumer precedent). */
export interface CoordinatorEvent {
  readonly eventType: string;
  readonly payload: unknown;
  readonly eventId: string;
}

/** Deliverable-side candidate snapshot for the dependency-side re-check.
 * The lookup shape is NOT frozen (G5): sound + complete within the Project
 * are the only frozen properties, so the project-scoped deliverable listing
 * is injected as a query callback — scan / index / materialized view are
 * all legal production shapes. */
export interface DeliverableCandidateSnapshot {
  readonly deliverableId: DeliverableId;
  readonly sourceWorkId: WorkId;
  readonly sourceWorkRevision: number;
  readonly kind: string;
  readonly artifactRoles: ReadonlyArray<string>;
}

export interface DependencyCoordinatorDependencies<R> {
  readonly gateway: CommandGatewayService;
  readonly dependencies: {
    readonly listUnsatisfiedByProject: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<Dependency>, unknown, R>;
  };
  readonly deliverables: {
    readonly findById: (deliverableId: DeliverableId) => Effect.Effect<
      Option.Option<{
        readonly deliverableId: DeliverableId;
        readonly sourceWorkId: WorkId;
        readonly sourceWorkRevision: number;
        readonly kind: string;
      }>,
      unknown,
      R
    >;
    readonly listArtifactRoles: (
      deliverableId: DeliverableId,
    ) => Effect.Effect<ReadonlyArray<string>, unknown, R>;
    readonly deliverablesByProject: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<DeliverableCandidateSnapshot>, unknown, R>;
  };
  readonly works: {
    readonly findById: (
      workId: WorkId,
    ) => Effect.Effect<
      Option.Option<{ readonly workspaceId: WorkspaceId }>,
      unknown,
      R
    >;
  };
}

/** Contract §1 frozen trigger set — dependency-side events. All four share
 * one uniform re-check: the store snapshot already carries the current
 * contract/state, terminal rows drop out of the Unsatisfied lookup (an
 * idempotent no-op, "幂等无害"), and a revised contract is re-evaluated
 * as stored. */
const DEPENDENCY_SIDE_TRIGGERS: ReadonlySet<string> = new Set([
  "DependencyDeclared",
  "DependencyContractRevised",
  "DependencyWithdrawn",
  "DependencyMarkedUnfulfillable",
]);

const asDeliverableProduced = (
  payload: unknown,
): { readonly deliverableId: DeliverableId } | null => {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const candidate = payload as Record<string, unknown>;
  return typeof candidate.deliverableId === "string"
    ? { deliverableId: candidate.deliverableId as DeliverableId }
    : null;
};

const asDependencyTrigger = (
  payload: unknown,
): { readonly dependencyId: DependencyId } | null => {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const candidate = payload as Record<string, unknown>;
  return typeof candidate.dependencyId === "string"
    ? { dependencyId: candidate.dependencyId as DependencyId }
    : null;
};

/** One batch record per advisory decision: "SatisfyDependency" for a
 * committed submission, "skipped:<rejection tag>:<dependencyId>" for an
 * advisory matcher-negative or a typed gateway rejection. Single-pair
 * rejections never interrupt the batch (§2/§4). */
export const runDependencyCoordinator = <R>(
  events: ReadonlyArray<CoordinatorEvent>,
  dependencies: DependencyCoordinatorDependencies<R>,
  projectId: ProjectId,
  principal: Principal,
): Effect.Effect<ReadonlyArray<string>, unknown, R> =>
  Effect.gen(function* () {
    const records: string[] = [];
    const actor = parse(Actor)(principal);

    const workspaceOf = (
      workId: WorkId,
    ): Effect.Effect<WorkspaceId, never, R> =>
      Effect.gen(function* () {
        const found = yield* dependencies.works
          .findById(workId)
          .pipe(Effect.orDie);
        if (Option.isNone(found)) {
          // Referential-integrity break, same convention as the handler —
          // defect, not a domain rejection.
          return yield* Effect.die(new Error(`work row not found: ${workId}`));
        }
        return found.value.workspaceId;
      });

    /** §1.8 frozen view construction. The event is only the trigger; the
     * candidate is built from the read snapshot (store facts, not payload
     * claims). */
    const viewOf = (
      deliverableId: DeliverableId,
      roles: ReadonlyArray<string>,
      sourceWorkId: WorkId,
      kind: string,
    ): Effect.Effect<DeliverableMatchView, never, R> =>
      Effect.gen(function* () {
        const sourceWorkspaceId = yield* workspaceOf(sourceWorkId);
        return {
          deliverableId,
          sourceWorkId,
          sourceWorkspaceId,
          kind: kind as DeliverableKind,
          artifactRoles: new Set(roles as ReadonlyArray<ArtifactRole>),
        };
      });

    /** §1/§2: one submission per matching (deliverable, Unsatisfied
     * dependency) pair — deterministic CommandId, P7Coordinator authority
     * (exact-bound, G6), full-payload fingerprint. At-least-once redelivery
     * is absorbed by the existing CommandReceipt. */
    const submit = (
      dependency: Dependency,
      view: DeliverableMatchView,
      eventId: string,
    ): Effect.Effect<string, never, R> =>
      Effect.gen(function* () {
        const targetWorkspaceId = yield* workspaceOf(dependency.consumerWorkId);
        const payload: SatisfyDependencyPayload = {
          dependencyId: dependency.dependencyId,
          targetDependencyRevision: dependency.revision,
          deliverableId: view.deliverableId,
        };
        const commandId = satisfactionCommandId(
          view.deliverableId,
          dependency.dependencyId,
          dependency.revision,
        );
        const context: CommandSubmissionContext = {
          _tag: "System",
          principal,
          causationRef: `p7-coordinator:${eventId}`,
        };
        const envelope: GatewayEnvelope<SatisfyDependencyPayload> = {
          commandType: "SatisfyDependency",
          commandId,
          projectId,
          actor,
          issuedAt: new Date().toISOString(),
          causationRef: eventId,
          payload,
        };
        // Dead-letter semantics (§4; P1 `05` §3 / `06`): consumer failures
        // quarantine into the P1 consumer_dead_letters infrastructure with
        // the offset advance — that wiring is the 011/012 composition. At
        // this boundary an operational Effect failure is a defect: the
        // trigger's produce transaction already committed and is never
        // rolled back by consumption; recovery is catch-up/replay, absorbed
        // by the deterministic CommandId.
        const receipt = yield* dependencies.gateway
          .execute(envelope, context, {
            _tag: "SatisfyDependencyAuthority",
            source: { _tag: "P7Coordinator" },
            principal,
            commandId,
            semanticRequestFingerprint: semanticRequestFingerprint({
              commandType: "SatisfyDependency",
              projectId,
              actor,
              schemaVersion: "1",
              payload,
            }),
            projectId,
            targetWorkspaceId,
            dependencyId: dependency.dependencyId,
            deliverableId: view.deliverableId,
          })
          .pipe(Effect.orDie);
        if (receipt.resolution._tag === "Committed") {
          return "SatisfyDependency";
        }
        // Typed rejection (authoritative handler refusal): record, never
        // interrupt the batch. Advisory misses are harmless by §2.
        return `skipped:${receipt.resolution.error._tag}:${dependency.dependencyId}`;
      });

    for (const event of events) {
      if (event.eventType === "DeliverableProduced") {
        const trigger = asDeliverableProduced(event.payload);
        if (trigger === null) {
          continue;
        }
        const stored = yield* dependencies.deliverables
          .findById(trigger.deliverableId)
          .pipe(Effect.orDie);
        if (Option.isNone(stored)) {
          // Not visible on this snapshot — advisory skip, nothing to
          // consume (§3 lookup is advisory; the handler is authoritative).
          continue;
        }
        const roles = yield* dependencies.deliverables
          .listArtifactRoles(trigger.deliverableId)
          .pipe(Effect.orDie);
        const view = yield* viewOf(
          stored.value.deliverableId,
          roles,
          stored.value.sourceWorkId,
          stored.value.kind,
        );
        // Primary path: the new candidate against all project Unsatisfied
        // Dependencies (every producer binding — AnyProducer/WorkspaceBound/
        // WorkBound — matcher decides, coordinator has no freedom).
        const unsatisfied = yield* dependencies.dependencies
          .listUnsatisfiedByProject(projectId)
          .pipe(Effect.orDie);
        for (const dependency of unsatisfied) {
          if (
            !matchesExpectedDeliverable(
              dependency.producerBinding,
              dependency.expectedDeliverable,
              view,
            )
          ) {
            records.push(
              `skipped:DependencyNotSatisfiable:${dependency.dependencyId}`,
            );
            continue;
          }
          records.push(yield* submit(dependency, view, event.eventId));
        }
      } else if (DEPENDENCY_SIDE_TRIGGERS.has(event.eventType)) {
        const trigger = asDependencyTrigger(event.payload);
        if (trigger === null) {
          continue;
        }
        // Re-check (symmetric completeness — the "不漏" dependency-side
        // entry): existing deliverables may already match the new/changed
        // requirement.
        const unsatisfied = yield* dependencies.dependencies
          .listUnsatisfiedByProject(projectId)
          .pipe(Effect.orDie);
        const dependency = unsatisfied.find(
          (candidate) => candidate.dependencyId === trigger.dependencyId,
        );
        if (dependency === undefined) {
          // Terminal or already satisfied on the snapshot — advisory no-op
          // (§2 skip conditions; "幂等无害").
          continue;
        }
        const snapshots = yield* dependencies.deliverables
          .deliverablesByProject(projectId)
          .pipe(Effect.orDie);
        for (const snapshot of snapshots) {
          const view = yield* viewOf(
            snapshot.deliverableId,
            snapshot.artifactRoles,
            snapshot.sourceWorkId,
            snapshot.kind,
          );
          if (
            !matchesExpectedDeliverable(
              dependency.producerBinding,
              dependency.expectedDeliverable,
              view,
            )
          ) {
            continue;
          }
          records.push(yield* submit(dependency, view, event.eventId));
        }
      }
    }
    return records;
  });
