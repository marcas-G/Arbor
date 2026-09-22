import type { WorkId, WorkspaceId, WorkspaceLifecycle } from "@arbor/domain";

// --- P10 `02` §1 frozen vocabulary ---

/** SD §12.3 severities. `Normal` is the absence of facts (default state,
 * not a row) — rows only ever carry Attention or ActionRequired. */
export type AttentionSeverity = "Attention" | "ActionRequired";

/** Six fact sources exactly per P10 `02` §1 (GAP-01 vacant producer
 * realized as the `WaitingOnVacantProducer` derived view label). */
export type AttentionSource =
  | "DependencyUnfulfillable"
  | "Deadlock"
  | "RuntimeSafetyEnvelope"
  | "ReconciliationEscalated"
  | "VerifierOrphan"
  | "WaitingOnVacantProducer";

/** Attention read-model row (P10 `05` §1 AttentionReq response core). */
export interface AttentionRow {
  readonly source: AttentionSource;
  readonly severity: AttentionSeverity;
  readonly targetWorkspaceId: WorkspaceId;
  readonly dedupKey: string;
  readonly summary: string;
  /** Event-carried sources carry occurredAt; state-derived joins
   * (vacant producer) have no event timestamp and render null. */
  readonly occurredAt: string | null;
}

// --- fact inputs (extracted journal rows / canonical-state joins) ---

/** `DependencyMarkedUnfulfillable` event fact (consumer resolved from the
 * dependency row — the payload carries only ids). */
export interface UnfulfillableEventFact {
  readonly dependencyId: string;
  readonly dependencyRevision: number;
  readonly consumerWorkId: WorkId;
  readonly occurredAt: string;
}

/** `DeadlockAttentionRequested` event fact (emitted only under the No.42
 * project-idle gate — every emitted fact is already Action Required). */
export interface DeadlockEventFact {
  readonly cycleWorkIds: ReadonlyArray<WorkId>;
  readonly dependencyIds: ReadonlyArray<string>;
  readonly detectedAt: string;
}

/** `Interrupted(RuntimeSafetyStop)` settlement fact. */
export interface SafetyStopFact {
  readonly executionId: string;
  readonly workspaceId: WorkspaceId;
  readonly settledAt: string | null;
}

/** `ReconciliationEscalated` event fact (target workspace resolved from
 * the execution row). */
export interface EscalationEventFact {
  readonly executionId: string;
  readonly invocationRefsFingerprint: string;
  readonly workspaceId: WorkspaceId;
  readonly occurredAt: string;
}

/** Open verification fact (owner workspace = owning workspace of the
 * target Work, P8 `02` §3). */
export interface OpenVerificationFact {
  readonly verificationId: string;
  readonly ownerWorkspaceId: WorkspaceId;
  readonly executionIds: ReadonlyArray<string>;
}

/** Execution settlement fact for the verifier-orphan join. */
export interface ExecutionSettlementFact {
  readonly executionId: string;
  readonly settled: boolean;
  readonly settledAt: string | null;
}

/** GAP-01 join input: an `Unsatisfied ∧ WorkspaceBound(ws)` dependency. */
export interface VacantProducerCandidateFact {
  readonly dependencyId: string;
  readonly producerWorkspaceId: WorkspaceId;
  readonly consumerWorkId: WorkId;
}

/** GAP-01 join input: producer workspace vacancy facts
 * (`works(no Open Work) ∧ ¬Retired`). */
export interface WorkspaceVacancyFact {
  readonly workspaceId: WorkspaceId;
  readonly lifecycle: WorkspaceLifecycle;
  readonly hasOpenWork: boolean;
}

/** workId → owning workspace resolution for consumer/member targets. */
export interface WorkOwnerFact {
  readonly workId: WorkId;
  readonly workspaceId: WorkspaceId;
}

export interface AttentionFacts {
  readonly unfulfillableEvents: ReadonlyArray<UnfulfillableEventFact>;
  readonly deadlockEvents: ReadonlyArray<DeadlockEventFact>;
  readonly safetyStopSettlements: ReadonlyArray<SafetyStopFact>;
  readonly reconciliationEscalatedEvents: ReadonlyArray<EscalationEventFact>;
  readonly openVerifications: ReadonlyArray<OpenVerificationFact>;
  readonly executionSettlements: ReadonlyArray<ExecutionSettlementFact>;
  readonly vacantProducerCandidates: ReadonlyArray<VacantProducerCandidateFact>;
  readonly workspaceVacancies: ReadonlyArray<WorkspaceVacancyFact>;
  readonly workOwners: ReadonlyArray<WorkOwnerFact>;
}

// --- frozen dedup identities (P10 `02` §2) ---

/** Deadlock dedup identity: the cycle fingerprint (member works +
 * dependency edges, order-canonicalized; detection time excluded — the
 * same cycle re-detected is the same fact). */
export const deadlockCycleFingerprint = (
  cycleWorkIds: ReadonlyArray<WorkId>,
  dependencyIds: ReadonlyArray<string>,
): string =>
  `[${[...cycleWorkIds].sort().join(",")}|${[...dependencyIds].sort().join(",")}]`;

const unfulfillableDedupKey = (fact: UnfulfillableEventFact): string =>
  `unfulfillable:${fact.dependencyId}:${fact.dependencyRevision}`;

const deadlockDedupKey = (
  fact: DeadlockEventFact,
  target: WorkspaceId,
): string =>
  `deadlock:${deadlockCycleFingerprint(fact.cycleWorkIds, fact.dependencyIds)}:${target}`;

const safetyStopDedupKey = (fact: SafetyStopFact): string =>
  `safety-stop:${fact.executionId}`;

const escalationDedupKey = (fact: EscalationEventFact): string =>
  `reconciliation-escalated:${fact.executionId}:${fact.invocationRefsFingerprint}`;

const verifierOrphanDedupKey = (verificationId: string): string =>
  `verifier-orphan:${verificationId}`;

const vacantProducerDedupKey = (dependencyId: string): string =>
  `vacant-producer:${dependencyId}`;

/** Verifier-orphan derived condition (P8 `02` §3): an Open verification
 * with at least one bound execution whose executions are all settled
 * (settle-without-conclude → nobody drives the verification anymore). */
export const isVerifierOrphan = (
  verification: OpenVerificationFact,
  settlements: ReadonlyMap<string, ExecutionSettlementFact>,
): boolean => {
  if (verification.executionIds.length === 0) {
    return false;
  }
  return verification.executionIds.every((executionId) => {
    const settlement = settlements.get(executionId);
    return settlement?.settled === true;
  });
};

/** GAP-01 predicate (P7-GAP-01 ruling): dependencies(Unsatisfied ∧
 * WorkspaceBound) × works(no Open Work) ∧ ¬Retired. The retired-workspace
 * negative fixture is mandatory — a retired producer with no Open Work
 * does NOT report. */
export const isVacantProducer = (
  candidate: VacantProducerCandidateFact,
  vacancies: ReadonlyMap<WorkspaceId, WorkspaceVacancyFact>,
): boolean => {
  const vacancy = vacancies.get(candidate.producerWorkspaceId);
  if (vacancy === undefined) {
    return false;
  }
  return vacancy.lifecycle !== "Retired" && !vacancy.hasOpenWork;
};

/** Six-source fact → row derivation, exactly per P10 `02` §1. Pure
 * function of canonical state + journal facts; Normal is the absence of
 * rows. Deduplicated on read by the frozen dedup identities (bubbling
 * aggregates deduplicated facts, not raw events). */
export const deriveAttentionRows = (
  facts: AttentionFacts,
): ReadonlyArray<AttentionRow> => {
  const workOwnerOf = new Map(
    facts.workOwners.map((o) => [o.workId, o.workspaceId]),
  );
  const settlements = new Map(
    facts.executionSettlements.map((s) => [s.executionId, s]),
  );
  const vacancies = new Map(
    facts.workspaceVacancies.map((v) => [v.workspaceId, v]),
  );

  const rows: Array<AttentionRow> = [];

  for (const fact of facts.unfulfillableEvents) {
    const target = workOwnerOf.get(fact.consumerWorkId);
    if (target === undefined) {
      continue;
    }
    rows.push({
      source: "DependencyUnfulfillable",
      severity: "Attention",
      targetWorkspaceId: target,
      dedupKey: unfulfillableDedupKey(fact),
      summary: `dependency ${fact.dependencyId} marked unfulfillable (revision ${fact.dependencyRevision})`,
      occurredAt: fact.occurredAt,
    });
  }

  for (const fact of facts.deadlockEvents) {
    for (const workId of fact.cycleWorkIds) {
      const target = workOwnerOf.get(workId);
      if (target === undefined) {
        continue;
      }
      rows.push({
        source: "Deadlock",
        // Emitted only under the No.42 project-idle gate: every emitted
        // deadlock fact is already Action Required — no conditional
        // branch exists (P7 `05` §2; P10 `02` §1).
        severity: "ActionRequired",
        targetWorkspaceId: target,
        dedupKey: deadlockDedupKey(fact, target),
        summary: `deadlock cycle ${deadlockCycleFingerprint(fact.cycleWorkIds, fact.dependencyIds)} awaits governance (withdraw / mark-unfulfillable / steer)`,
        occurredAt: fact.detectedAt,
      });
    }
  }

  for (const fact of facts.safetyStopSettlements) {
    rows.push({
      source: "RuntimeSafetyEnvelope",
      severity: "Attention",
      targetWorkspaceId: fact.workspaceId,
      dedupKey: safetyStopDedupKey(fact),
      summary: `execution ${fact.executionId} interrupted by runtime safety envelope (RuntimeSafetyStop)`,
      occurredAt: fact.settledAt,
    });
  }

  for (const fact of facts.reconciliationEscalatedEvents) {
    rows.push({
      source: "ReconciliationEscalated",
      severity: "ActionRequired",
      targetWorkspaceId: fact.workspaceId,
      dedupKey: escalationDedupKey(fact),
      summary: `unreconcilable side effect: execution ${fact.executionId} escalated (${fact.invocationRefsFingerprint})`,
      occurredAt: fact.occurredAt,
    });
  }

  for (const verification of facts.openVerifications) {
    if (!isVerifierOrphan(verification, settlements)) {
      continue;
    }
    let becameOrphanAt: string | null = null;
    for (const executionId of verification.executionIds) {
      const settledAt = settlements.get(executionId)?.settledAt ?? null;
      if (
        settledAt !== null &&
        (becameOrphanAt === null || settledAt > becameOrphanAt)
      ) {
        becameOrphanAt = settledAt;
      }
    }
    rows.push({
      source: "VerifierOrphan",
      severity: "Attention",
      targetWorkspaceId: verification.ownerWorkspaceId,
      dedupKey: verifierOrphanDedupKey(verification.verificationId),
      summary: `open verification ${verification.verificationId} has no active verifier execution (settle-without-conclude)`,
      occurredAt: becameOrphanAt,
    });
  }

  for (const candidate of facts.vacantProducerCandidates) {
    if (!isVacantProducer(candidate, vacancies)) {
      continue;
    }
    const target = workOwnerOf.get(candidate.consumerWorkId);
    if (target === undefined) {
      continue;
    }
    rows.push({
      source: "WaitingOnVacantProducer",
      severity: "Attention",
      targetWorkspaceId: target,
      dedupKey: vacantProducerDedupKey(candidate.dependencyId),
      summary: `dependency ${candidate.dependencyId} waits on vacant producer workspace ${candidate.producerWorkspaceId} (no Open Work, not retired)`,
      occurredAt: null,
    });
  }

  // Dedup on read (P10 `02` §2): first occurrence wins — inputs arrive in
  // journal/canonical order.
  const seen = new Set<string>();
  const deduplicated: Array<AttentionRow> = [];
  for (const row of rows) {
    if (seen.has(row.dedupKey)) {
      continue;
    }
    seen.add(row.dedupKey);
    deduplicated.push(row);
  }
  return deduplicated;
};

// --- bubbling (P10 `02` §2; SD §12.3) ---

export interface SubtreeAttentionSummary {
  readonly attention: number;
  readonly actionRequired: number;
}

export const ZERO_SUBTREE_ATTENTION: SubtreeAttentionSummary = {
  attention: 0,
  actionRequired: 0,
};

/** Subtree bubbling: a workspace's summary = aggregated severity counts
 * over itself + descendants. Context is never copied upward — the summary
 * carries counts only (structurally enforced); drilling in resolves
 * detail. Aggregates deduplicated rows, not raw events. */
export const subtreeAttentionAggregate = (
  rows: ReadonlyArray<AttentionRow>,
  parentOf: (workspaceId: WorkspaceId) => WorkspaceId | null,
): ReadonlyMap<WorkspaceId, SubtreeAttentionSummary> => {
  const summaries = new Map<WorkspaceId, SubtreeAttentionSummary>();
  const bump = (workspaceId: WorkspaceId, severity: AttentionSeverity) => {
    const current = summaries.get(workspaceId) ?? ZERO_SUBTREE_ATTENTION;
    summaries.set(workspaceId, {
      attention: current.attention + (severity === "Attention" ? 1 : 0),
      actionRequired:
        current.actionRequired + (severity === "ActionRequired" ? 1 : 0),
    });
  };
  for (const row of rows) {
    const visited = new Set<WorkspaceId>();
    let cursor: WorkspaceId | null = row.targetWorkspaceId;
    while (cursor !== null && !visited.has(cursor)) {
      visited.add(cursor);
      bump(cursor, row.severity);
      cursor = parentOf(cursor);
    }
  }
  return summaries;
};

/** Own-row count per workspace — the attention overlay input for status
 * derivation (`attentionFacts`). */
export const attentionCountsByWorkspace = (
  rows: ReadonlyArray<AttentionRow>,
): ReadonlyMap<WorkspaceId, number> => {
  const counts = new Map<WorkspaceId, number>();
  for (const row of rows) {
    counts.set(
      row.targetWorkspaceId,
      (counts.get(row.targetWorkspaceId) ?? 0) + 1,
    );
  }
  return counts;
};
