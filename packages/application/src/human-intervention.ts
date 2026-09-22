import type {
  Actor,
  CommandId,
  HumanInterventionKind,
  Principal,
  ProjectId,
  WorkspaceId,
} from "@arbor/domain";
import type { PendingDomainEvent } from "@arbor/ports";

// --- P10 `06` §2 (GQ7): HumanInterventionApplied emission helper ------------
//
// Emission is fire-once per successful mutation, in the SAME semantic
// transaction as the mutation (the handler's single events array — the
// gateway journals it atomically with the store writes). Kind mapping:
// Steer/CriticalSteer by severity; GovernanceDecision for the four
// human-originated mutating governance commands; Stop dormant below.

/** Provenance AuthenticatedHuman (DID §8.4A): the `user:` prefix is the
 * P1 principal convention for a human-originated submitter. */
export const isHumanOriginatedPrincipal = (principal: Principal): boolean =>
  principal.startsWith("user:");

/** The frozen payload fields (P10 `06` §1) — exactly these, no more. */
export interface HumanInterventionEmission {
  readonly actor: Actor;
  readonly targetWorkspaceId: WorkspaceId;
  /** Bounded intervention summary (steer guidance / stop reason / decision). */
  readonly summaryRef: string;
  readonly occurredAt: string;
  readonly kind: HumanInterventionKind;
}

/** Build one `HumanInterventionApplied` PendingDomainEvent paired to the
 * command that caused the mutation (`causedByCommandId` binds the pairing;
 * the handler pushes it into the same events array as the primary event). */
export const emitHumanIntervention = (
  input: {
    readonly projectId: ProjectId;
    readonly commandId: CommandId;
  } & HumanInterventionEmission,
): PendingDomainEvent => {
  // kind = "Stop" branch: DORMANT BY FROZEN DESIGN — the Stop emission
  // point is the StopExecution submission path for human-originated stops,
  // preconditioned on resolver-admitted (P12, GQ4). Until the resolver
  // lands, no production call site may pass kind "Stop" (P10 `06` §2);
  // `humanStopInterventionEvent` below is the wire-only declaration.
  return {
    projectId: input.projectId,
    eventType: "HumanInterventionApplied",
    eventVersion: 1,
    occurredAt: input.occurredAt,
    aggregateRef: input.targetWorkspaceId,
    actor: input.actor,
    causedByCommandId: input.commandId,
    payload: {
      actor: input.actor,
      targetWorkspaceId: input.targetWorkspaceId,
      summaryRef: input.summaryRef,
      occurredAt: input.occurredAt,
      kind: input.kind,
    },
  };
};

/** Wire-only declaration of the frozen precondition gating the dormant
 * Stop branch (P10 `06` §2). No production call site until P12. */
export const HUMAN_STOP_EMISSION_PRECONDITION =
  "resolver-admitted (P12, GQ4)" as const;

/** DORMANT Stop-branch emission (wire-only): pairs with
 * ExecutionStopRequested once the P12 resolver admits human stops.
 * Declared + payload-shaped for P10 acceptance; NEVER invoked in
 * production code this phase. */
export const humanStopInterventionEvent = (input: {
  readonly projectId: ProjectId;
  readonly commandId: CommandId;
  readonly actor: Actor;
  readonly targetWorkspaceId: WorkspaceId;
  readonly summaryRef: string;
  readonly occurredAt: string;
}): PendingDomainEvent =>
  emitHumanIntervention({
    projectId: input.projectId,
    commandId: input.commandId,
    actor: input.actor,
    targetWorkspaceId: input.targetWorkspaceId,
    summaryRef: input.summaryRef,
    occurredAt: input.occurredAt,
    kind: "Stop",
  });
