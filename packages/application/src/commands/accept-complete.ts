import {
  type AcceptanceId,
  completeWork,
  incrementOrdinal,
  isWorkCurrent,
  Revision,
  type VerificationId,
  type WorkId,
  type WorkRevision,
  type WorkspaceId,
} from "@arbor/domain";
import type {
  AcceptanceRepositoryService,
  PendingDomainEvent,
  VerificationRepositoryService,
  WorkRepositoryService,
  WorkspaceRepositoryService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { commandErr, commandOk } from "../command-result.js";
import type { CommandHandler } from "../gateway.js";
import {
  emitHumanIntervention,
  isHumanOriginatedPrincipal,
} from "../human-intervention.js";

/**
 * P8 `01` §4/§5: the acceptance and completion command faces.
 * `AcceptWorkOutcome` is the Parent semantic decision (double-uniqueness
 * idempotency); `CompleteWork` is the mechanical closure re-validating the
 * full seven-fold precondition via the P0 `completeWork` transition (DID
 * §3.6 frozen form — no submitter is exempt, G3). The verification and
 * acceptance store channels are defects-only here: their adapter errors
 * are not part of the gateway error union yet (P7 `dependency-transitions`
 * precedent), so reads/writes go through `Effect.orDie`.
 */

// --- AcceptWorkOutcome (P8 `01` §4) -----------------------------------------

export interface AcceptWorkOutcomePayload {
  readonly acceptanceId: AcceptanceId;
  readonly workId: WorkId;
  readonly targetWorkRevision: WorkRevision;
  readonly verificationId: VerificationId;
}

export interface AcceptWorkOutcomeResult {
  readonly acceptanceId: AcceptanceId;
  readonly workId: WorkId;
  readonly targetWorkRevision: WorkRevision;
  readonly verificationId: VerificationId;
}

export interface AcceptWorkOutcomeDependencies {
  readonly works: Pick<WorkRepositoryService, "findById">;
  readonly verifications: Pick<VerificationRepositoryService, "findById">;
  readonly acceptances: Pick<
    AcceptanceRepositoryService,
    "insert" | "findByWorkRevision"
  >;
}

export const makeAcceptWorkOutcomeHandler = (
  dependencies: AcceptWorkOutcomeDependencies,
): CommandHandler<AcceptWorkOutcomePayload, AcceptWorkOutcomeResult> => ({
  commandType: "AcceptWorkOutcome",
  schemaVersion: "1",
  authority: {
    tag: "AcceptanceAuthority",
    // `targetWorkspaceId` is the Parent Workspace of the Work's owner,
    // bound at fact projection (SD §9.7 governance chain; Root milestone =
    // explicit human). The payload match binds the exact decision target:
    // workId + verificationId.
    targetMatches: (authority, payload) =>
      authority._tag === "AcceptanceAuthority" &&
      authority.workId === payload.workId &&
      authority.verificationId === payload.verificationId,
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
      if (work.lifecycle !== "Open") {
        return commandErr({
          _tag: "TerminalLifecycleMutation",
          entity: "Work",
          lifecycle: work.lifecycle,
        });
      }
      const verificationOption = yield* dependencies.verifications
        .findById(payload.verificationId)
        .pipe(Effect.orDie);
      if (Option.isNone(verificationOption)) {
        return commandErr({
          _tag: "VerificationNotFound",
          verificationId: payload.verificationId,
        });
      }
      const verification = verificationOption.value;
      // DID §3.6 frozen triple binding: the (workId, targetWorkRevision,
      // verificationId) triple must match the verification record exactly
      // at the Work's current revision, and the conclusion must be Pass.
      // PASS is never re-judged (SD §9.7); "insufficient" is expressed by
      // not submitting, never by a Reject command.
      const tripleBinds =
        verification.workId === payload.workId &&
        verification.targetWorkRevision === payload.targetWorkRevision &&
        payload.targetWorkRevision === work.revision &&
        verification.state.status === "Concluded" &&
        verification.state.verdict === "Pass";
      if (!tripleBinds) {
        return commandErr({
          _tag: "VerificationAcceptanceMismatch",
          workId: payload.workId,
        });
      }
      // Double uniqueness (round-1): same-acceptanceId replays above the
      // gateway are receipt dedup; anything reaching the handler with a
      // (workId, revision) row already present is the typed rejection.
      // The repository unique index backstops concurrent inserts.
      const prior = yield* dependencies.acceptances
        .findByWorkRevision(payload.workId, payload.targetWorkRevision)
        .pipe(Effect.orDie);
      if (Option.isSome(prior)) {
        return commandErr({
          _tag: "AcceptanceAlreadyExists",
          workId: payload.workId,
        });
      }
      yield* dependencies.acceptances
        .insert(
          {
            acceptanceId: payload.acceptanceId,
            workId: payload.workId,
            targetWorkRevision: payload.targetWorkRevision,
            verificationId: payload.verificationId,
            actor: envelope.actor,
            acceptedAt: envelope.issuedAt,
          },
          envelope.projectId,
        )
        .pipe(Effect.orDie);

      const events: PendingDomainEvent[] = [
        {
          projectId: envelope.projectId,
          eventType: "WorkOutcomeAccepted",
          eventVersion: 1,
          occurredAt: envelope.issuedAt,
          aggregateRef: payload.workId,
          actor: envelope.actor,
          causedByCommandId: envelope.commandId,
          payload: {
            acceptanceId: payload.acceptanceId,
            workId: payload.workId,
            targetWorkRevision: payload.targetWorkRevision,
            verificationId: payload.verificationId,
            actor: envelope.actor,
          },
        },
      ];

      // P10 `06` §2: AcceptWorkOutcome is one of the four human-originated
      // mutating governance commands — the fact is emitted ONLY for a
      // human-originated submitting principal (provenance
      // AuthenticatedHuman, DID §8.4A); agent submissions emit nothing.
      // Same semantic transaction as WorkOutcomeAccepted.
      if (isHumanOriginatedPrincipal(context.principal)) {
        events.push(
          emitHumanIntervention({
            projectId: envelope.projectId,
            commandId: envelope.commandId,
            actor: envelope.actor,
            targetWorkspaceId: work.workspaceId,
            summaryRef: `work outcome accepted: ${payload.workId} at revision ${payload.targetWorkRevision}`,
            occurredAt: envelope.issuedAt,
            kind: "GovernanceDecision",
          }),
        );
      }

      return commandOk({
        result: {
          acceptanceId: payload.acceptanceId,
          workId: payload.workId,
          targetWorkRevision: payload.targetWorkRevision,
          verificationId: payload.verificationId,
        },
        events,
      });
    }),
});

// --- CompleteWork (P8 `01` §5) ----------------------------------------------

export interface CompleteWorkPayload {
  readonly workId: WorkId;
  readonly expectedWorkRevision: WorkRevision;
}

export interface CompleteWorkResult {
  readonly workId: WorkId;
  readonly workspaceId: WorkspaceId;
  readonly lifecycle: "Completed";
  readonly revision: WorkRevision;
  readonly clearedCurrentWork: boolean;
}

export interface CompleteWorkDependencies {
  readonly works: Pick<
    WorkRepositoryService,
    "findById" | "completeIfRevision"
  >;
  readonly workspaces: Pick<
    WorkspaceRepositoryService,
    "findById" | "clearCurrentWorkIfRevision"
  >;
  readonly verifications: Pick<VerificationRepositoryService, "findById">;
  readonly acceptances: Pick<AcceptanceRepositoryService, "findByWorkRevision">;
}

export const makeCompleteWorkHandler = (
  dependencies: CompleteWorkDependencies,
): CommandHandler<CompleteWorkPayload, CompleteWorkResult> => ({
  commandType: "CompleteWork",
  schemaVersion: "1",
  authority: {
    tag: "CompleteWorkAuthority",
    // Deterministic consumer (System origin, causationRef = the
    // WorkOutcomeAccepted event) or explicit submitter; `targetWorkspaceId`
    // is the Work's owning Workspace, bound at fact projection.
    targetMatches: (authority, payload) =>
      authority._tag === "CompleteWorkAuthority" &&
      authority.workId === payload.workId,
  },
  stopAdmission: { _tag: "NormalExecutionMutation" },
  execute: (envelope) =>
    Effect.gen(function* () {
      const payload = envelope.payload;
      const existing = yield* dependencies.works.findById(payload.workId);
      if (Option.isNone(existing)) {
        return commandErr({ _tag: "WorkNotFound", workId: payload.workId });
      }
      const work = existing.value;
      if (work.lifecycle !== "Open") {
        return commandErr({
          _tag: "TerminalLifecycleMutation",
          entity: "Work",
          lifecycle: work.lifecycle,
        });
      }
      // Binding resolution (§5): the payload names no verificationId —
      // the acceptance at (workId, expectedWorkRevision) carries it. Any
      // miss on the way to the triple is the seven-fold Mismatch.
      const acceptanceOption = yield* dependencies.acceptances
        .findByWorkRevision(payload.workId, payload.expectedWorkRevision)
        .pipe(Effect.orDie);
      if (Option.isNone(acceptanceOption)) {
        return commandErr({
          _tag: "VerificationAcceptanceMismatch",
          workId: payload.workId,
        });
      }
      const acceptance = acceptanceOption.value;
      const verificationOption = yield* dependencies.verifications
        .findById(acceptance.verificationId)
        .pipe(Effect.orDie);
      if (Option.isNone(verificationOption)) {
        return commandErr({
          _tag: "VerificationAcceptanceMismatch",
          workId: payload.workId,
        });
      }
      // P0 frozen seven-fold transition: work Open; current-revision Pass
      // verification; current-revision acceptance whose verificationId
      // matches; expectedWorkRevision matches — clause by clause.
      const completed = completeWork(
        work,
        verificationOption.value,
        acceptance,
      );
      if (!completed.ok) {
        return commandErr(completed.error);
      }
      yield* dependencies.works.completeIfRevision(
        payload.workId,
        work.revision,
      );
      // If the completed Work is the Workspace's currentWork, clear it
      // atomically in this same transaction (DID §12.11 Work row); the
      // clear CAS-bumps the Workspace revision like every mutation.
      const workspaceOption = yield* dependencies.workspaces.findById(
        work.workspaceId,
      );
      let clearedCurrentWork = false;
      if (
        Option.isSome(workspaceOption) &&
        isWorkCurrent(work, workspaceOption.value.currentWorkId)
      ) {
        const workspace = workspaceOption.value;
        yield* dependencies.workspaces.clearCurrentWorkIfRevision(
          workspace.workspaceId,
          workspace.revision,
          incrementOrdinal(Revision)(workspace.revision),
        );
        clearedCurrentWork = true;
      }

      const events: PendingDomainEvent[] = [
        {
          projectId: envelope.projectId,
          eventType: "WorkCompleted",
          eventVersion: 1,
          occurredAt: envelope.issuedAt,
          aggregateRef: payload.workId,
          actor: envelope.actor,
          causedByCommandId: envelope.commandId,
          payload: {
            workId: payload.workId,
            workspaceId: work.workspaceId,
            revision: work.revision,
            clearedCurrentWork,
          },
        },
      ];

      return commandOk({
        result: {
          workId: payload.workId,
          workspaceId: work.workspaceId,
          lifecycle: "Completed",
          revision: work.revision,
          clearedCurrentWork,
        },
        events,
      });
    }),
});
