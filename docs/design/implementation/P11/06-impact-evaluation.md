# P11 — 06 Impact Evaluation — wake broad, invalidate narrow (GQ5)

**Authority:** GQ5 裁决; SD §11.5 chain; P7 wake sink; P10 Attention read-model.
**Status:** DRAFT.

## 1. The narrowing funnel (frozen)

```text
BROAD    EnvironmentChanged event → wake every waiter whose observedRevision < toRevision
NARROW   impact = f(changedRegions, resolved-boundary snapshots):
           Workspaces/Works whose ResourceBoundary (resolved regions) overlaps changedRegions
           + active ownership claims whose resolved regions overlap
         → ImpactReport { affectedWorkIds, affectedWorkspaceIds, affectedClaimIds }
CONSUME   affected objects → stale overlay (derived, `07`) + Inbox notification + Attention rows
```

- Inputs use **resolved-region snapshots** (or claims' resolved snapshots) — overlap is on canonical regions, never raw addresses (round-1 fix).
- Deterministic pure function over canonical state; no model calls; no auto-Steer (governance stays human/parent — SD §11.5 middle steps land as cognition inputs, not mutations).

## 2. Must Not Decide

- No region revision counters; no per-workspace environment state; no automatic Work creation.

## (mapping: CI-4 → convergence target; CI-5 pre-step)
