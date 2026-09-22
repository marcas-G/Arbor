import {
  type Dependency,
  type DependencyId,
  DependencyRevision,
  type DomainResult,
  type ExpectedDeliverable,
  err,
  incrementOrdinal,
  markDependencyUnfulfillable,
  type Principal,
  type ProducerBinding,
  reviseExpectedContract,
  type WorkId,
  withdrawDependency,
} from "@arbor/domain";
import type {
  DependencyRepositoryService,
  PendingDomainEvent,
  TransactionScope,
  WorkRepositoryService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import {
  type CommandResult,
  commandErr,
  commandOk,
} from "../command-result.js";
import type { CommandHandler, GatewayEnvelope } from "../gateway.js";
import {
  emitHumanIntervention,
  isHumanOriginatedPrincipal,
} from "../human-intervention.js";

/** P7 `01` §5–§7: the three dependency terminal/revision commands.
 * Scope is handler-only — the §8 derived batch transitions
 * (withdrawDependenciesOnWorkCancel / markUnfulfillableOnProducerLoss)
 * are wired inside the owning governance transactions elsewhere. */

export interface DependencyTransitionDependencies {
  readonly dependencies: Pick<
    DependencyRepositoryService,
    "findById" | "transitionIfUnsatisfiedRevision"
  >;
  /** Consumer-work owner lookup — the HumanInterventionApplied target
   * (P10 `06` §2) is the Workspace owning the consumer Work. */
  readonly works: Pick<WorkRepositoryService, "findById">;
}

interface TransitionApplied {
  readonly from: Dependency;
  readonly next: Dependency;
}

/** Shared rejection baseline (§5–§7 rows, identical order): not found →
 * terminal → revision; then the domain transition and the state+revision
 * CAS (first committer wins, §10). A lost CAS re-reads the row and
 * classifies the loser's typed rejection by what it observes — the
 * store channel itself is defects-only here (adapter-specific errors
 * never cross the semantic boundary; the gateway error union does not
 * carry DependencyRepositoryError yet). */
const applyUnsatisfiedTransition = (
  dependencies: DependencyTransitionDependencies,
  dependencyId: DependencyId,
  targetDependencyRevision: DependencyRevision,
  transition: (dependency: Dependency) => DomainResult<Dependency>,
): Effect.Effect<CommandResult<TransitionApplied>, never, TransactionScope> =>
  Effect.gen(function* () {
    const existing = yield* dependencies.dependencies
      .findById(dependencyId)
      .pipe(Effect.orDie);
    if (Option.isNone(existing)) {
      return commandErr({ _tag: "DependencyNotFound", dependencyId });
    }
    const dependency = existing.value;
    if (dependency.state !== "Unsatisfied") {
      return commandErr({
        _tag: "TerminalLifecycleMutation",
        entity: "Dependency",
        lifecycle: dependency.state,
      });
    }
    if (dependency.revision !== targetDependencyRevision) {
      return commandErr({
        _tag: "RevisionConflict",
        expected: targetDependencyRevision,
        actual: dependency.revision,
      });
    }
    const next = transition(dependency);
    if (!next.ok) {
      return commandErr(next.error);
    }
    const applied = yield* dependencies.dependencies
      .transitionIfUnsatisfiedRevision(
        dependencyId,
        targetDependencyRevision,
        next.value,
      )
      .pipe(Effect.orDie);
    if (Option.isSome(applied)) {
      return commandOk({ from: dependency, next: next.value });
    }
    const reread = yield* dependencies.dependencies
      .findById(dependencyId)
      .pipe(Effect.orDie);
    const current = Option.isNone(reread) ? dependency : reread.value;
    if (current.state !== "Unsatisfied") {
      return commandErr({
        _tag: "TerminalLifecycleMutation",
        entity: "Dependency",
        lifecycle: current.state,
      });
    }
    return commandErr({
      _tag: "RevisionConflict",
      expected: targetDependencyRevision,
      actual: current.revision,
    });
  });

const dependencyEvent = (
  envelope: GatewayEnvelope<unknown>,
  dependencyId: DependencyId,
  eventType: PendingDomainEvent["eventType"],
  payload: unknown,
): PendingDomainEvent => ({
  projectId: envelope.projectId,
  eventType,
  eventVersion: 1,
  occurredAt: envelope.issuedAt,
  aggregateRef: dependencyId,
  actor: envelope.actor,
  causedByCommandId: envelope.commandId,
  payload,
});

/** P10 `06` §2: WithdrawDependency / MarkDependencyUnfulfillable are two
 * of the four human-originated mutating governance commands — the fact is
 * emitted ONLY for a human-originated submitting principal (provenance
 * AuthenticatedHuman, DID §8.4A); agent submissions emit nothing. Target
 * = the Workspace owning the consumer Work; same semantic transaction as
 * the primary event. The store channel is defects-only here (the §5–§7
 * precedent). */
const humanGovernanceFact = (
  dependencies: DependencyTransitionDependencies,
  envelope: GatewayEnvelope<unknown>,
  contextPrincipal: Principal,
  consumerWorkId: WorkId,
  summaryRef: string,
): Effect.Effect<PendingDomainEvent | null, never, TransactionScope> =>
  Effect.gen(function* () {
    if (!isHumanOriginatedPrincipal(contextPrincipal)) {
      return null;
    }
    const work = yield* dependencies.works
      .findById(consumerWorkId)
      .pipe(Effect.orDie);
    if (Option.isNone(work)) {
      return null;
    }
    return emitHumanIntervention({
      projectId: envelope.projectId,
      commandId: envelope.commandId,
      actor: envelope.actor,
      targetWorkspaceId: work.value.workspaceId,
      summaryRef,
      occurredAt: envelope.issuedAt,
      kind: "GovernanceDecision",
    });
  });

// --- WithdrawDependency (P7 `01` §5, v1.10 G1) ---

export interface WithdrawDependencyPayload {
  readonly dependencyId: DependencyId;
  readonly targetDependencyRevision: DependencyRevision;
  readonly reason: string;
}

export interface WithdrawDependencyResult {
  readonly dependencyId: DependencyId;
  readonly state: "Withdrawn";
  readonly dependencyRevision: DependencyRevision;
}

/** Consumer no longer requires the result (DID §12.11). Terminal
 * (`Withdrawn`); a new requirement means a new Dependency, never
 * history rewrite. Withdrawal does not bump the revision — the domain
 * transition keeps it. */
export const makeWithdrawDependencyHandler = (
  dependencies: DependencyTransitionDependencies,
): CommandHandler<WithdrawDependencyPayload, WithdrawDependencyResult> => ({
  commandType: "WithdrawDependency",
  schemaVersion: "1",
  authority: {
    tag: "WithdrawDependencyAuthority",
    // `targetWorkspaceId` is bound at fact projection to the Workspace
    // owning the consumer Work (§5 authority fact); the payload carries
    // no workspace field, so the pure payload match binds dependencyId —
    // one dependency has exactly one consumer Work, transitively fixing
    // the target Workspace.
    targetMatches: (authority, payload) =>
      authority._tag === "WithdrawDependencyAuthority" &&
      authority.dependencyId === payload.dependencyId,
  },
  stopAdmission: { _tag: "NormalExecutionMutation" },
  execute: (envelope, context) =>
    Effect.gen(function* () {
      const payload = envelope.payload;
      const applied = yield* applyUnsatisfiedTransition(
        dependencies,
        payload.dependencyId,
        payload.targetDependencyRevision,
        withdrawDependency,
      );
      if (!applied.ok) {
        return commandErr(applied.error);
      }
      const events: PendingDomainEvent[] = [
        dependencyEvent(envelope, payload.dependencyId, "DependencyWithdrawn", {
          dependencyId: payload.dependencyId,
          dependencyRevision: applied.value.next.revision,
          reason: payload.reason,
        }),
      ];
      const governanceFact = yield* humanGovernanceFact(
        dependencies,
        envelope,
        context.principal,
        applied.value.next.consumerWorkId,
        `dependency ${payload.dependencyId} withdrawn: ${payload.reason}`,
      );
      if (governanceFact !== null) {
        events.push(governanceFact);
      }
      return commandOk({
        result: {
          dependencyId: payload.dependencyId,
          state: "Withdrawn",
          dependencyRevision: applied.value.next.revision,
        },
        events,
      });
    }),
});

// --- MarkDependencyUnfulfillable (P7 `01` §6, v1.10 G1) ---

export interface MarkDependencyUnfulfillablePayload {
  readonly dependencyId: DependencyId;
  readonly targetDependencyRevision: DependencyRevision;
  readonly justification: string;
}

export interface MarkDependencyUnfulfillableResult {
  readonly dependencyId: DependencyId;
  readonly state: "Unfulfillable";
  readonly dependencyRevision: DependencyRevision;
}

/** Adjudicated conclusion: still needed but confirmed unfulfillable
 * (S3 step 12). Terminal (`Unfulfillable`); the Attention fact is
 * carried by the event itself (§12.10 invariant column; L6 derived
 * input — no projection shape frozen here). The authority fact is the
 * adjudication source (parent governance chain / human principal);
 * the consumer's own agent may Withdraw but cannot unilaterally mark. */
export const makeMarkDependencyUnfulfillableHandler = (
  dependencies: DependencyTransitionDependencies,
): CommandHandler<
  MarkDependencyUnfulfillablePayload,
  MarkDependencyUnfulfillableResult
> => ({
  commandType: "MarkDependencyUnfulfillable",
  schemaVersion: "1",
  authority: {
    tag: "MarkDependencyUnfulfillableAuthority",
    // Same projection-time `targetWorkspaceId` binding as §5 — the
    // payload match binds dependencyId.
    targetMatches: (authority, payload) =>
      authority._tag === "MarkDependencyUnfulfillableAuthority" &&
      authority.dependencyId === payload.dependencyId,
  },
  stopAdmission: { _tag: "NormalExecutionMutation" },
  execute: (envelope, context) =>
    Effect.gen(function* () {
      const payload = envelope.payload;
      const applied = yield* applyUnsatisfiedTransition(
        dependencies,
        payload.dependencyId,
        payload.targetDependencyRevision,
        markDependencyUnfulfillable,
      );
      if (!applied.ok) {
        return commandErr(applied.error);
      }
      const events: PendingDomainEvent[] = [
        dependencyEvent(
          envelope,
          payload.dependencyId,
          "DependencyMarkedUnfulfillable",
          {
            dependencyId: payload.dependencyId,
            dependencyRevision: applied.value.next.revision,
            justification: payload.justification,
          },
        ),
      ];
      const governanceFact = yield* humanGovernanceFact(
        dependencies,
        envelope,
        context.principal,
        applied.value.next.consumerWorkId,
        `dependency ${payload.dependencyId} marked unfulfillable: ${payload.justification}`,
      );
      if (governanceFact !== null) {
        events.push(governanceFact);
      }
      return commandOk({
        result: {
          dependencyId: payload.dependencyId,
          state: "Unfulfillable",
          dependencyRevision: applied.value.next.revision,
        },
        events,
      });
    }),
});

// --- ReviseDependencyContract (P7 `01` §7, v1.10 G1) ---

export interface ReviseDependencyContractPayload {
  readonly dependencyId: DependencyId;
  readonly targetDependencyRevision: DependencyRevision;
  readonly newProducerBinding?: ProducerBinding;
  readonly newExpectedDeliverable?: ExpectedDeliverable;
}

export interface ReviseDependencyContractResult {
  readonly dependencyId: DependencyId;
  readonly state: "Unsatisfied";
  readonly fromRevision: DependencyRevision;
  readonly toRevision: DependencyRevision;
}

const sameProducerBinding = (
  a: ProducerBinding,
  b: ProducerBinding,
): boolean => {
  if (a._tag !== b._tag) {
    return false;
  }
  if (a._tag === "WorkspaceBound" && b._tag === "WorkspaceBound") {
    return a.workspaceId === b.workspaceId;
  }
  if (a._tag === "WorkBound" && b._tag === "WorkBound") {
    return a.workId === b.workId;
  }
  return true;
};

/** `Unsatisfied → Unsatisfied`, `revision = target + 1` (§12.11).
 * `producerBinding` is immutable for the Dependency identity — a re-bind
 * attempt is the SteerWork protected-field precedent: AuthorityDenied,
 * re-binding requires Withdraw + new Declare. Never reinterprets prior
 * satisfaction: the domain transition rejects terminal states, so a
 * recorded `satisfiedAtDependencyRevision` stays bound to its revision. */
export const makeReviseDependencyContractHandler = (
  dependencies: DependencyTransitionDependencies,
): CommandHandler<
  ReviseDependencyContractPayload,
  ReviseDependencyContractResult
> => ({
  commandType: "ReviseDependencyContract",
  schemaVersion: "1",
  authority: {
    tag: "ReviseDependencyContractAuthority",
    // Consumer-side rule (same as Declare, §2); `targetWorkspaceId` is
    // bound at fact projection, payload match binds dependencyId.
    targetMatches: (authority, payload) =>
      authority._tag === "ReviseDependencyContractAuthority" &&
      authority.dependencyId === payload.dependencyId,
  },
  stopAdmission: { _tag: "NormalExecutionMutation" },
  execute: (envelope) =>
    Effect.gen(function* () {
      const payload = envelope.payload;
      const applied = yield* applyUnsatisfiedTransition(
        dependencies,
        payload.dependencyId,
        payload.targetDependencyRevision,
        (dependency) => {
          if (
            payload.newProducerBinding !== undefined &&
            !sameProducerBinding(
              payload.newProducerBinding,
              dependency.producerBinding,
            )
          ) {
            return err({
              _tag: "AuthorityDenied" as const,
              reason:
                "producerBinding is immutable for a Dependency identity: re-bind requires Withdraw + new Declare (P7 01 §7)",
            });
          }
          // `authorized: true` is guaranteed by the command authority
          // fact (gateway-validated consumer-side rule) — the domain
          // input keeps the authority seam for pure-domain callers.
          return reviseExpectedContract(dependency, {
            authorized: true,
            expectedDeliverable:
              payload.newExpectedDeliverable ?? dependency.expectedDeliverable,
            revision: incrementOrdinal(DependencyRevision)(
              payload.targetDependencyRevision,
            ),
          });
        },
      );
      if (!applied.ok) {
        return commandErr(applied.error);
      }
      const events: PendingDomainEvent[] = [
        dependencyEvent(
          envelope,
          payload.dependencyId,
          "DependencyContractRevised",
          {
            dependencyId: payload.dependencyId,
            fromRevision: applied.value.from.revision,
            toRevision: applied.value.next.revision,
          },
        ),
      ];
      return commandOk({
        result: {
          dependencyId: payload.dependencyId,
          state: "Unsatisfied",
          fromRevision: applied.value.from.revision,
          toRevision: applied.value.next.revision,
        },
        events,
      });
    }),
});
