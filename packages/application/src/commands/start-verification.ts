import type {
  ArtifactId,
  DeliverableId,
  ExecutionId,
  VerificationId,
  VerificationMission,
  WorkId,
  WorkRevision,
  WorkspaceId,
} from "@arbor/domain";
import { startVerification } from "@arbor/domain";
import type {
  DeliverableArtifactBinding,
  DeliverableRepositoryError,
  DeliverableRepositoryService,
  EnvironmentRevisionStoreService,
  PendingDomainEvent,
  TransactionScope,
  VerificationRepositoryError,
  VerificationRepositoryService,
  WorkRepositoryService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { commandErr, commandOk } from "../command-result.js";
import type { CommandHandler } from "../gateway.js";

/** P8 `01` §1. Starts the one-Open Verification bound to an Open Work at
 * the caller's observed revision. The owner Workspace snapshot (v1.11 G4)
 * and the caller-preallocated `verifierExecutionId` (P8 `02` §1 — closes
 * the spawn/backfill crash window by construction) are persisted at start
 * time; later retirement/move never auto-aborts or retargets. Mission
 * structure errors are `InvalidVerificationMission` (P8-frozen enum) —
 * never `AuthorityDenied`. */
export interface StartVerificationPayload {
  readonly verificationId: VerificationId;
  readonly workId: WorkId;
  readonly observedWorkRevision: WorkRevision;
  readonly missionSnapshot: VerificationMission;
  readonly targetDeliverables?: ReadonlyArray<DeliverableId>;
  readonly verifierExecutionId: ExecutionId;
  /** B-7: mission includes executable verification (runs tests /
   * reproduces) → `targetEnvironmentRevision` required (read from the
   * store); purely static review may omit. */
  readonly executableMission: boolean;
}

export interface StartVerificationResult {
  readonly verificationId: VerificationId;
  readonly workId: WorkId;
  readonly targetWorkRevision: WorkRevision;
  readonly ownerWorkspaceId: WorkspaceId;
  readonly state: "Open";
  readonly verifierExecutionId: ExecutionId;
}

export interface StartVerificationDependencies {
  readonly works: Pick<WorkRepositoryService, "findById">;
  readonly verifications: Pick<
    VerificationRepositoryService,
    "insert" | "findOpenByWorkRevision"
  >;
  readonly deliverables: Pick<DeliverableRepositoryService, "findById"> & {
    /** role→artifactId binding rows written by ProduceDeliverable
     * (`04` §3: `targetArtifactVersions` derives from the deliverables'
     * artifacts — invariant 26 artifact part, never optional when
     * deliverables exist). The P7-frozen deliverable port has no id
     * lister, so the binding read is an injected seam rather than a
     * defaulted derivation. */
    readonly listArtifacts: (
      deliverableId: DeliverableId,
    ) => Effect.Effect<
      ReadonlyArray<DeliverableArtifactBinding>,
      DeliverableRepositoryError,
      TransactionScope
    >;
  };
  readonly environmentRevisions: Pick<
    EnvironmentRevisionStoreService,
    "current"
  >;
}

/** v1.11 G1 + P8 `04` §5 minimal mission schema: non-empty goal, every
 * criterion carries criterionId + requirement text + required flag, at
 * least one required criterion. */
const missionInvalidReason = (mission: VerificationMission): string | null => {
  if (typeof mission.goal !== "string" || mission.goal.length === 0) {
    return "mission goal must be a non-empty string";
  }
  if (!Array.isArray(mission.criteria)) {
    return "mission criteria must be an array";
  }
  for (const criterion of mission.criteria) {
    if (
      typeof criterion.criterionId !== "string" ||
      criterion.criterionId.length === 0
    ) {
      return "every criterion requires a non-empty criterionId";
    }
    if (
      typeof criterion.requirement !== "string" ||
      criterion.requirement.length === 0
    ) {
      return "every criterion requires requirement text";
    }
    if (typeof criterion.required !== "boolean") {
      return "every criterion carries the required flag";
    }
  }
  if (!mission.criteria.some((criterion) => criterion.required)) {
    return "mission requires at least one required criterion";
  }
  if (!Array.isArray(mission.riskRequirements)) {
    return "mission riskRequirements must be an array";
  }
  return null;
};

/** Event digest (§1): goal + criteria count summary — deterministic from
 * the persisted missionSnapshot. */
const missionDigest = (mission: VerificationMission): string => {
  const required = mission.criteria.filter(
    (criterion) => criterion.required,
  ).length;
  return `${mission.goal} [criteria=${mission.criteria.length} required=${required}]`;
};

/** The one-Open partial unique index (v1.11 G2) is translated by the
 * persistence adapter into a safe semantic constraint fact. Application code
 * never inspects SqlError/native causes. */
const isUniqueViolation = (failure: VerificationRepositoryError): boolean => {
  return (
    failure._tag === "PersistenceConstraintViolation" &&
    failure.repository === "VerificationRepository" &&
    failure.constraintKind === "Unique"
  );
};

export const makeStartVerificationHandler = (
  dependencies: StartVerificationDependencies,
): CommandHandler<StartVerificationPayload, StartVerificationResult> => ({
  commandType: "StartVerification",
  schemaVersion: "1",
  authority: {
    tag: "StartVerificationAuthority",
    // `targetWorkspaceId` is bound at fact projection to the Workspace
    // owning workId (§6 fact shape); the payload carries no workspace
    // field, so the pure payload match binds workId — one Work belongs to
    // exactly one Workspace, transitively fixing the target
    // (DeclareDependency precedent).
    targetMatches: (authority, payload) =>
      authority._tag === "StartVerificationAuthority" &&
      authority.workId === payload.workId,
  },
  stopAdmission: { _tag: "NormalExecutionMutation" },
  execute: (envelope) =>
    Effect.gen(function* () {
      const payload = envelope.payload;

      // Rejection table (§1, frozen order): not found → terminal →
      // revision. WorkRepositoryError is in the gateway error union;
      // P8/P7 repository failures remain typed through the gateway.
      const existing = yield* dependencies.works.findById(payload.workId);
      if (Option.isNone(existing)) {
        return commandErr({ _tag: "WorkNotFound", workId: payload.workId });
      }
      const work = existing.value;
      if (work.projectId !== envelope.projectId) {
        return commandErr({ _tag: "WorkNotFound", workId: payload.workId });
      }
      if (work.lifecycle !== "Open") {
        return commandErr({
          _tag: "TerminalLifecycleMutation",
          entity: "Work",
          lifecycle: work.lifecycle,
        });
      }
      if (work.revision !== payload.observedWorkRevision) {
        return commandErr({
          _tag: "RevisionConflict",
          expected: payload.observedWorkRevision,
          actual: work.revision,
        });
      }

      const invalidMission = missionInvalidReason(payload.missionSnapshot);
      if (invalidMission !== null) {
        return commandErr({
          _tag: "InvalidVerificationMission",
          reason: invalidMission,
        });
      }

      // Cross-deliverable consistency (invariant 26/49): every target
      // deliverable resolves, its sourceWorkRevision binds to the
      // verified revision, and its artifacts derive
      // targetArtifactVersions (empty payload → empty array).
      const targetDeliverables = payload.targetDeliverables ?? [];
      const targetArtifactVersions: ArtifactId[] = [];
      for (const deliverableId of targetDeliverables) {
        const storedOption =
          yield* dependencies.deliverables.findById(deliverableId);
        if (Option.isNone(storedOption)) {
          return commandErr({
            _tag: "InvalidVerificationMission",
            reason: `target deliverable not found: ${deliverableId}`,
          });
        }
        const deliverable = storedOption.value;
        if (deliverable.sourceWorkRevision !== payload.observedWorkRevision) {
          return commandErr({
            _tag: "InvalidVerificationMission",
            reason: `deliverable ${deliverableId} is bound to work revision ${deliverable.sourceWorkRevision}, expected ${payload.observedWorkRevision}`,
          });
        }
        const sourceWorkOption = yield* dependencies.works.findById(
          deliverable.sourceWorkId,
        );
        if (
          Option.isNone(sourceWorkOption) ||
          sourceWorkOption.value.projectId !== envelope.projectId
        ) {
          return commandErr({
            _tag: "InvalidVerificationMission",
            reason: `deliverable ${deliverableId} source work does not resolve in this project`,
          });
        }
        const artifacts =
          yield* dependencies.deliverables.listArtifacts(deliverableId);
        for (const artifact of artifacts) {
          targetArtifactVersions.push(artifact.artifactId as ArtifactId);
        }
      }

      // Executable mission (B-7): the current environment revision is
      // required; purely static review binds none.
      let targetEnvironmentRevision: string | null = null;
      if (payload.executableMission) {
        const current = yield* dependencies.environmentRevisions.current(
          envelope.projectId,
        );
        if (Option.isNone(current)) {
          return commandErr({
            _tag: "InvalidVerificationMission",
            reason:
              "executable mission requires a current environment revision (none recorded)",
          });
        }
        targetEnvironmentRevision = current.value;
      }

      // One-Open pre-check (v1.11 G2); the partial unique index backs the
      // insert race below. Orphan re-Start requires a prior
      // Unknown(Orphaned) conclusion (G5 — path in P8-004).
      const open = yield* dependencies.verifications.findOpenByWorkRevision(
        payload.workId,
        work.revision,
      );
      if (Option.isSome(open)) {
        return commandErr({
          _tag: "VerificationAlreadyOpen",
          workId: payload.workId,
        });
      }

      const verification = startVerification({
        verificationId: payload.verificationId,
        workId: payload.workId,
        targetWorkRevision: work.revision,
        missionSnapshot: payload.missionSnapshot,
        targetDeliverables,
        targetArtifactVersions,
        targetEnvironmentRevision,
        verificationExecutionIds: [payload.verifierExecutionId],
      });

      // One-Open backstop: a UniqueViolation flip on insert is the partial
      // unique index deciding a lost race (G2). Other repository failures
      // remain typed command-handler failures so the gateway can retry them.
      const insertFailure = yield* dependencies.verifications
        .insert(verification, envelope.projectId, work.workspaceId)
        .pipe(
          Effect.flip,
          Effect.map(
            (error): Option.Option<VerificationRepositoryError> =>
              Option.some(error),
          ),
          Effect.catch(() =>
            Effect.succeed(Option.none<VerificationRepositoryError>()),
          ),
        );
      if (Option.isSome(insertFailure)) {
        if (isUniqueViolation(insertFailure.value)) {
          return commandErr({
            _tag: "VerificationAlreadyOpen",
            workId: payload.workId,
          });
        }
        return yield* Effect.fail(insertFailure.value);
      }

      const events: PendingDomainEvent[] = [
        {
          projectId: envelope.projectId,
          eventType: "VerificationStarted",
          eventVersion: 1,
          occurredAt: envelope.issuedAt,
          aggregateRef: payload.verificationId,
          actor: envelope.actor,
          causedByCommandId: envelope.commandId,
          payload: {
            verificationId: verification.verificationId,
            workId: verification.workId,
            targetWorkRevision: verification.targetWorkRevision,
            missionDigest: missionDigest(verification.missionSnapshot),
          },
        },
      ];

      return commandOk({
        result: {
          verificationId: verification.verificationId,
          workId: verification.workId,
          targetWorkRevision: verification.targetWorkRevision,
          ownerWorkspaceId: work.workspaceId,
          state: "Open",
          verifierExecutionId: payload.verifierExecutionId,
        },
        events,
      });
    }),
});
