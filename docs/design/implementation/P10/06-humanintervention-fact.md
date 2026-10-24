# P10 — 06 HumanInterventionApplied Fact (GQ7)

**Authority:** DID v1.59 §5.3 (event catalog); DID v1.13 G7 (payload note); SD v1.22 §14 No.40/A2 (Intervention Summary propagation, L6); P6 `04` §2 (WorkSteered / WorkAmended event pairing), P2 `01` (StopExecution).
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
| Steer / CriticalSteer | SteerWork handler (P6) | DirectionGuidance: WorkSteered; ContractAmendment: WorkAmended; paired with HumanInterventionApplied(Steer) |
| Stop | StopExecution submission path for human-originated stops (P2 command, external origin) — **precondition: resolver-admitted (P12, GQ4). Until the resolver lands this branch is dormant by frozen design; P10 acceptance covers it wire-only** (Story F asserts the steer/governance-decision emissions + the dormant-branch declaration, not an actual human-stop mutation) | ExecutionStopRequested + HumanInterventionApplied(Stop) |
| GovernanceDecision | human-originated governance commands that mutate canon: RecordDecision (formation approval), AcceptWorkOutcome, WithdrawDependency, MarkDependencyUnfulfillable — each emits the fact **only when the submitting principal is human-originated** (provenance AuthenticatedHuman, DID §8.4A); agent-originated submissions emit nothing | DecisionRecorded / WorkOutcomeAccepted / DependencyWithdrawn / DependencyMarkedUnfulfillable + HumanInterventionApplied(GovernanceDecision) |

- The P6 DirectionGuidance WorkSteered pairing remains the inherited evolution: the event and HumanInterventionApplied are emitted in the same successful command transaction. Accepted S2-RDG-01 adds the distinct versioned WorkAmended pairing for ContractAmendment; it uses the same HumanInterventionApplied(Steer) projection and does not add a new intervention kind or projection field. Event payload and DTO details remain with their owner contracts.
- Emission is fire-once per successful mutation (idempotent by command receipt); P10 only consumes.

## 3. Consumption (P10)

- Intervention Summary propagation (invariant 40): the Attention/Tree read-models aggregate these facts upward as governance-trace entries (no context copying — same bubbling rule as `02` §2).
- Audit timeline in Workspace Detail ⑥ renders them in order.

## 4. Must Not Decide

- No new governance semantics; no resolver; no P6/P2 contract reopening (additive emission only).
