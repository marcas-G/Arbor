import type {
  ArtifactId,
  ArtifactRole,
  DeliverableId,
  DeliverableKind,
  WorkId,
  WorkRevision,
} from "@arbor/domain";
import type {
  DeliverableRepositoryError,
  DeliverableRepositoryService,
  PendingDomainEvent,
  WorkRepositoryService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { commandErr, commandOk } from "../command-result.js";
import type { CommandHandler } from "../gateway.js";

/** P7 `01` §3 (G2 orthogonality). ProduceDeliverable records the formal
 * result fact bound to a source Work revision (No.49). A Completed source
 * Work is NOT rejected — a Deliverable is a result fact, not a verified
 * result; only Cancelled is terminal here. No Verification / CompletionClaim
 * precondition exists (the quality chain is P8). Deliverables are immutable:
 * a same-deliverableId replay is absorbed by content comparison, never by
 * an update path (§10). */
export interface ProduceDeliverablePayload {
  readonly deliverableId: DeliverableId;
  readonly sourceWorkId: WorkId;
  readonly observedSourceWorkRevision: WorkRevision;
  readonly kind: DeliverableKind;
  readonly artifacts: ReadonlyArray<{
    readonly role: ArtifactRole;
    readonly artifactId: ArtifactId;
  }>;
}

export interface ProduceDeliverableResult {
  readonly deliverableId: DeliverableId;
  readonly sourceWorkId: WorkId;
  readonly sourceWorkRevision: WorkRevision;
  readonly kind: DeliverableKind;
  readonly artifactRoles: ReadonlyArray<ArtifactRole>;
}

export interface ProduceDeliverableDependencies {
  readonly works: Pick<WorkRepositoryService, "findById">;
  readonly deliverables: Pick<
    DeliverableRepositoryService,
    "insert" | "findById" | "listArtifactRoles"
  >;
}

export const makeProduceDeliverableHandler = (
  dependencies: ProduceDeliverableDependencies,
): CommandHandler<ProduceDeliverablePayload, ProduceDeliverableResult> => ({
  commandType: "ProduceDeliverable",
  schemaVersion: "1",
  authority: {
    tag: "ProduceDeliverableAuthority",
    targetMatches: (authority, payload) =>
      authority._tag === "ProduceDeliverableAuthority" &&
      authority.sourceWorkId === payload.sourceWorkId,
  },
  stopAdmission: { _tag: "NormalExecutionMutation" },
  execute: (envelope) =>
    Effect.gen(function* () {
      const payload = envelope.payload;
      const existing = yield* dependencies.works.findById(payload.sourceWorkId);
      if (Option.isNone(existing)) {
        return commandErr({
          _tag: "WorkNotFound",
          workId: payload.sourceWorkId,
        });
      }
      const work = existing.value;
      if (work.projectId !== envelope.projectId) {
        return commandErr({
          _tag: "AuthorityDenied",
          reason: "source work belongs to another project",
        });
      }
      if (work.lifecycle === "Cancelled") {
        return commandErr({
          _tag: "TerminalLifecycleMutation",
          entity: "Work",
          lifecycle: work.lifecycle,
        });
      }
      if (work.revision !== payload.observedSourceWorkRevision) {
        return commandErr({
          _tag: "RevisionConflict",
          expected: payload.observedSourceWorkRevision,
          actual: work.revision,
        });
      }
      if (payload.kind.length === 0) {
        return commandErr({
          _tag: "AuthorityDenied",
          reason: "deliverable kind required",
        });
      }

      const result: ProduceDeliverableResult = {
        deliverableId: payload.deliverableId,
        sourceWorkId: payload.sourceWorkId,
        sourceWorkRevision: work.revision,
        kind: payload.kind,
        artifactRoles: payload.artifacts.map((artifact) => artifact.role),
      };
      const artifactBindings = payload.artifacts.map((artifact) => ({
        role: artifact.role,
        artifactId: artifact.artifactId,
      }));

      // Immutable insert-only store (§10): the only insert failure is the
      // deliverableId PK — flip, then decide by content comparison.
      const insertFailure = yield* dependencies.deliverables
        .insert(
          {
            deliverableId: payload.deliverableId,
            sourceWorkId: payload.sourceWorkId,
            sourceWorkRevision: work.revision,
            kind: payload.kind,
          },
          artifactBindings,
          envelope.projectId,
        )
        .pipe(
          Effect.flip,
          Effect.map(
            (error): Option.Option<DeliverableRepositoryError> =>
              Option.some(error),
          ),
          Effect.catch(() =>
            Effect.succeed(Option.none<DeliverableRepositoryError>()),
          ),
        );

      if (Option.isSome(insertFailure)) {
        // The gateway's CommandHandlerError union predates the P7 deliverable
        // store; read failures here are operational (SqlError), unrecoverable
        // at this boundary — defect, matching the orDie convention the
        // gateway itself uses for operational write failures.
        const storedOption = yield* dependencies.deliverables
          .findById(payload.deliverableId)
          .pipe(Effect.orDie);
        if (Option.isNone(storedOption)) {
          return yield* Effect.die(
            new Error(
              `deliverable insert failed and no existing row to absorb: ${String(
                insertFailure.value._tag,
              )}`,
            ),
          );
        }
        const stored = storedOption.value;
        const storedRoles = yield* dependencies.deliverables
          .listArtifactRoles(payload.deliverableId)
          .pipe(Effect.orDie);
        // The store returns roles in index (not insertion) order — compare as
        // sorted multisets; the fact content is order-free.
        const sortedStored = [...storedRoles].sort();
        const sortedPayload = [
          ...payload.artifacts.map((artifact) => artifact.role),
        ].sort();
        const sameContent =
          stored.sourceWorkId === payload.sourceWorkId &&
          stored.sourceWorkRevision === work.revision &&
          stored.kind === payload.kind &&
          sortedStored.length === sortedPayload.length &&
          sortedStored.every((role, index) => role === sortedPayload[index]);
        if (!sameContent) {
          return commandErr({
            _tag: "IdempotencyConflict",
            commandId: envelope.commandId,
          });
        }
        return commandOk({ result, events: [] });
      }

      const events: PendingDomainEvent[] = [
        {
          projectId: envelope.projectId,
          eventType: "DeliverableProduced",
          eventVersion: 1,
          occurredAt: envelope.issuedAt,
          aggregateRef: payload.deliverableId,
          actor: envelope.actor,
          causedByCommandId: envelope.commandId,
          payload: {
            deliverableId: payload.deliverableId,
            sourceWorkId: payload.sourceWorkId,
            sourceWorkRevision: work.revision,
            kind: payload.kind,
            artifactRoles: payload.artifacts.map((artifact) => artifact.role),
          },
        },
      ];

      return commandOk({ result, events });
    }),
});
