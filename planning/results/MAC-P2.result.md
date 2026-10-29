# MAC-P2 — Long-Term Responsibility and Child Workspace Closure Result

**Date:** 2026-10-04
**Status:** COMPLETE / FORMALLY CLOSED
**Phase:** `planning/phases/MAC-P2-long-term-responsibility.md`

## Outcome

Root/Parent Agents now receive canonical placement facts and can choose:

```text
current Workspace
existing Active Direct Child via opaque wref_
new long-lived child proposal with initial Work
```

Users approve a concrete organization proposal; `Approved` is distinct from
asynchronous fulfillment. Ordinary direct-child PASS results can be accepted
by the Parent Agent through opaque `rref_`, then the existing completion
consumer closes the child Work without routine human babysitting.

## Exit-criterion evidence

| Criterion | Evidence | Result |
|---|---|---|
| 1. Agent chooses placement from user goal | Root placement prompt v5, PlacementContext, real MAC-P2 Root formation sentinel | PASS |
| 2. Existing/in-flight candidates prevent blind duplication | paged children + Open Work counts + Pending/Approved formation summaries | PASS |
| 3. Decision and fulfillment separate | migration 0031 + `mac-p2-formation-fulfillment.test.ts` | PASS |
| 4. Approval creates one child and initial Work | deterministic P6 consumer + Applied/replay integration | PASS |
| 5. Ceiling cannot expand parent | inherited P6 capability/resource ceiling suites | PASS |
| 6. Parent Agent accepts ordinary child PASS | `accept_result(rref_)` integration and completion-consumer closure | PASS |
| 7. Root acceptance remains Human/policy | MAC-P1 root path unchanged | PASS |
| 8. Placement behavior | current/existing/new/stale/paging/in-flight/rejected tests + real B07 | PASS |
| 9. Full restart/replay/check | formation migration re-entry, deterministic IDs, `pnpm check` | PASS |
| 10. No Dependency/subagent requirement | TurnProfile still hides declare_dependency and legacy specialist | PASS |

## Implemented contracts

- `WorkspacePlacementPort` with deterministic pagination/query;
- revision-bound opaque `wref_`, `pref_` and `rref_` references;
- `list_workspaces` and `read_workspace` read-only controls;
- `assign_work.targetWorkspaceRef`, with legacy raw ID replay-only;
- PlacementContext includes current/direct children, Open Work summaries,
  ready PASS results and in-flight Formation state;
- root prompt `goal-placement:v5` chooses current/existing/new without asking
  users to select internal nouns;
- `FormationFulfillmentStore` and migration 0031;
- states: AwaitingDecision, PendingApplication, WorkspaceCreated, Applied,
  Blocked;
- RecordDecision atomically establishes PendingApplication/Blocked/new
  AwaitingDecision projection;
- formation consumer advances exact fulfillment and records typed block;
- `accept_result` resolves only active direct-child, current-revision,
  concluded PASS, not-yet-accepted results;
- completion consumer then completes the child Work.

## Verification

```text
pnpm check PASS
Biome             884 files
Architecture       28 files / 149 tests
Core              302 files / 1663 passed / 3 skipped
Web                31 files / 216 tests
Build              PASS; existing >500KB chunk warning only
SQLite baseline    user_version 31
```

Key tests:

```text
apps/single-workspace/test/mac-p2-workspace-placement.test.ts
apps/single-workspace/test/mac-p2-formation-fulfillment.test.ts
apps/single-workspace/test/mac-p2-parent-accept-result.test.ts
adapters/persistence-sqlite/test/mac-p2-formation-fulfillment-migration.test.ts
packages/agent-runtime/test/control-workspace-placement.test.ts
```

Real-provider evidence:

```text
planning/testing/core-capability/reports/capability-real-provider-2026-10-03T18-48-24.909Z-534771b7-a197-46df-b1d3-841c842947e4.md
```

The B07 batch passed L1/L2/L3 with FAILED = 0, including a Root prompt where
the user supplied only the long-lived responsibility, first goal and no-trading
constraint; the real model generated a Pending child proposal with initialWork
and no pre-approval Work mutation.

## Closure

Blocking = 0. MAC-P3 entry gate is satisfied.
