# MAC-P3 — Cross-Work Coordination and Deliverable Closure Result

**Date:** 2026-10-04
**Status:** COMPLETE / FORMALLY CLOSED
**Phase:** `planning/phases/MAC-P3-cross-work-coordination.md`

## Outcome

The complete model/runtime path is reachable:

```text
declare_dependency
→ producer receives durable Dependency request
→ produce_deliverable
→ deliver to direct parent
→ deterministic coordinator SatisfyDependency
→ exact wake / consumer integration
```

`satisfy_dependency` is not model-facing. Message, Deliverable, Dependency,
Verification and Acceptance remain distinct.

## Evidence

- production registry now includes ProduceDeliverable and SatisfyDependency;
- production daemon now runs the dependency coordinator for every open Project;
- DeliverableRepository has a typed project-listing face;
- Work TurnProfile exposes declare/produce/deliver/send only after full path;
- DependencyDeclared routes an exact durable request to WorkspaceBound/
  WorkBound producer Inbox;
- matcher remains producer/kind/role deterministic authority;
- terminal/unfulfillable/deadlock/lost-wake suites remain green;
- integration proves produce + deliver + coordinator satisfaction + parent
  Inbox with no model satisfy action.

Key test:
`apps/single-workspace/test/mac-p3-dependency-delivery.test.ts`.

## Verification

```text
pnpm check PASS
Biome             886 files
Architecture       28 files / 149 tests
Core              304 files / 1665 passed / 3 skipped
Web                31 files / 216 tests
Build              PASS; existing >500KB warning only
```

Real-provider evidence:

```text
planning/testing/core-capability/reports/capability-real-provider-2026-10-03T19-30-12.684Z-969474ae-eb92-4620-b685-41c751b8930b.md
```

B09 L1/L2/L3 PASS, FAILED = 0. The real producer called
`produce_deliverable`, consumed the returned `del_` ref, called `deliver`, and
the daemon satisfied the dependency without advertising `satisfy_dependency`.

## Closure

Blocking = 0. MAC-P4 entry gate is satisfied. The user's persistent objective
to complete all four phases is explicit MAC-P4 authorization.
