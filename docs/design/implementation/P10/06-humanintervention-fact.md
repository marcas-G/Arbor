# P10 — 06 HumanInterventionApplied Fact (GQ7)

**Authority:** DID v1.13 G7, §5.3 (payload note); SD v1.3 §14 No.40/A2 (Intervention Summary propagation, L6); P6 `04` §2 (WorkSteered frozen payload — back-fill), P2 `01` (StopExecution).
**Status:** DRAFT.

## 1. Event payload (frozen, DID v1.13 G7)

```ts
HumanInterventionApplied {
  actor: Principal,            // human-originated principal (provenance AuthenticatedHuman — DID §8.4A)
  targetWorkspaceId: WorkspaceId,
  summaryRef: ContentRef,      // bounded intervention summary (steer guidance / stop reason)
  occurredAt: string,
  kind: "Steer" | "CriticalSteer" | "Stop" | "GovernanceDecision"
}
```

## 2. Emission points (same semantic transaction as the successful mutation)

| Kind | Emitter (inherited evolution) | Same-transaction pairing |
|---|---|---|
| Steer / CriticalSteer | SteerWork handler (P6) | WorkSteered event + HumanInterventionApplied(Steer) |
| Stop | StopExecution submission path for human-originated stops (P2 command, external origin) — **precondition: resolver-admitted (P12, GQ4). Until the resolver lands this branch is dormant by frozen design; P10 acceptance covers it wire-only** (Story F asserts the steer/governance-decision emissions + the dormant-branch declaration, not an actual human-stop mutation) | ExecutionStopRequested + HumanInterventionApplied(Stop) |
| GovernanceDecision | human-originated governance commands that mutate canon: RecordDecision (formation approval), AcceptWorkOutcome, WithdrawDependency, MarkDependencyUnfulfillable — each emits the fact **only when the submitting principal is human-originated** (provenance AuthenticatedHuman, DID §8.4A); agent-originated submissions emit nothing | DecisionRecorded / WorkOutcomeAccepted / DependencyWithdrawn / DependencyMarkedUnfulfillable + HumanInterventionApplied(GovernanceDecision) |

- Back-fill of the P6 WorkSteered path is an **inherited evolution** (P6 not reopened): the handler already pairs event emission; the fix equips the frozen payload shapes (both `WorkSteered {workId, fromRevision, toRevision, severity}` per P6 `04` §2 and the new fact above) — the current empty-shell events were the implementation deviation (recorded, DID v1.13 G7).
- Emission is fire-once per successful mutation (idempotent by command receipt); P10 only consumes.

## 3. Consumption (P10)

- Intervention Summary propagation (invariant 40): the Attention/Tree read-models aggregate these facts upward as governance-trace entries (no context copying — same bubbling rule as `02` §2).
- Audit timeline in Workspace Detail ⑥ renders them in order.

## 4. Must Not Decide

- No new governance semantics; no resolver; no P6/P2 contract reopening (additive emission only).
