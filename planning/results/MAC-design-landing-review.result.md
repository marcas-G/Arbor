# MAC Design Landing Consistency Review

**Date:** 2026-10-03
**Status:** PASS — Blocking = 0
**Accepted proposal:**
`44B549EA81E21B3D4BE5D545EA446B544D50CCA0061C83E6FC40CDC2ADCCA932`

## Landing reviewed

```text
docs/design/00-problem-goals.md                 v1.3
docs/design/01-scenarios.md                     v1.3
docs/design/02-system-design.md                 v1.9
docs/design/03-detailed-implementation-design.md v1.31
docs/design/implementation/MAC/**               FROZEN
```

P2/P3/P6/P7/P8/P12/P17 contract indices contain explicit MAC successor
notices; historical contracts remain available for replay/migration evidence.

## Checks

| Check | Result |
|---|---|
| accepted proposal hash matches decision record and every owning baseline | PASS |
| Workspace is durable identity; Agent is runtime role | PASS |
| LocalPlan has explicit zero-authority boundary | PASS |
| WorkspaceKnowledgeView admits accepted/canonical sources only | PASS |
| Specialist is superseded for active new writes; optional runtime subagent is MAC-P4 | PASS |
| one ActionCall facade preserves route-specific handlers/safety | PASS |
| PermissionGrant and one-time ActionApproval remain distinct | PASS |
| async Decision / Fulfillment / Result separation is explicit | PASS |
| MAC-P1…P4 order and phase gates are explicit | PASS |
| existing Command/Event, Lease/Fence, Provider/Tool and Verification foundations retained | PASS |
| RGI/SDO independent proposals disabled | PASS |
| AGENTS.md baseline and authorization state updated | PASS |
| `git diff --check` semantic output clean (line-ending warnings only) | PASS |
| `pnpm lint` | PASS — 868 files |
| architecture suite | PASS — 27 files / 147 tests |

## Authorization consequence

The MAC-P1 entry gate is satisfied. Implementation may begin with MAC1-001 and
must follow `planning/phases/MAC-P1-single-workspace-golden-path.md`. MAC-P2…P4
remain gated.
