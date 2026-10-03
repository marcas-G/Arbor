# MAC — Minimal Architecture Convergence — Contract Index

**Authority:** Problem & Goals v1.3; Scenarios v1.3; System Design v1.9; DID
v1.31; accepted token `ACCEPT_MINIMAL_ARCHITECTURE_CONVERGENCE`.

**Accepted proposal SHA-256:**
`44B549EA81E21B3D4BE5D545EA446B544D50CCA0061C83E6FC40CDC2ADCCA932`

**Status:** FROZEN — design accepted; MAC-P1 implementation authorized after
this landing and consistency review. MAC-P2…P4 retain their phase entry gates.

## Purpose

MAC is a convergence successor, not a parallel architecture. It preserves the
proven Command/Event, Lease/Fencing, Provider/Tool Runtime, Context provenance,
Resource/Permission and Verification foundations while reducing the active
product/domain vocabulary and requiring reachable end-to-end closure before
optional features.

## Documents

| Document | Owns |
|---|---|
| `01-minimal-vocabulary-and-cognition.md` | Product/domain/runtime vocabulary; Agent definition; LocalPlan; WorkspaceKnowledgeView; runtime subagent boundary |
| `02-action-approval-error-boundary.md` | unified model ActionCall, route-specific handlers, shared ActionApproval semantics, typed Effect errors and legacy isolation |
| `03-golden-paths-and-fulfillment.md` | MAC-P1…P4 behavior order, async fulfillment, formation and acceptance closure |
| `04-acceptance.md` | system/phase acceptance matrix and stop conditions |

## Supersession rule

```text
MAC contract
  > conflicting active-new-write clauses in P2/P3/P6/P7/P8/P12/P17
  > historical compatibility/migration behavior remains readable and fail-closed
```

No old event, command receipt or persisted row is reinterpreted from prose.
Where MAC removes an active concept, the old vocabulary becomes replay/migration
compatibility only until its phase-owned forward migration closes.

## Phase contracts

```text
planning/phases/MAC-P1-single-workspace-golden-path.md
planning/phases/MAC-P2-long-term-responsibility.md
planning/phases/MAC-P3-cross-work-coordination.md
planning/phases/MAC-P4-optional-subagent-and-final-convergence.md
```
