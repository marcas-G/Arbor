# P9 direct Control effect takeover qualification

Date: 2026-10-18

Status: **Three direct durable Control effects now commit atomically with their
P9 result handoff; targeted process qualification is complete. AH10 remains
PARTIAL.**

This batch covers the non-Gateway `propose_workspace`, `update_plan`, and
`claim_completion` handlers. It makes no schema or migration change and does
not modify `docs/design/**`.

## Implementation

`propose_workspace` and `update_plan` use a shared application helper that
commits the direct SQLite effect, sourced `ControlResult`, fenced P9 Action
transition, and step cursor in one existing `TransactionPort` transaction.
The exact pending action must match the durable step, ProviderTurn,
`LogicalActionId`, call reference, action index, action kind, and full lease
fence. A failed fence/CAS rolls the business write and P9 handoff back
together. The proposal's generated ID is created inside this transaction;
recovery after commit skips the already-Applied P9 action rather than
generating another proposal.

`claim_completion` carries its WorkWait upsert as an internal process-local
settlement effect. The Agent Runtime applies it inside the existing P9
terminal-action transaction together with the sourced result, Action
transition, and `SettlementProposed` step. The existing P2
`SettleExecution` path remains responsible for final Execution settlement.
The callback is not persisted or model-facing; it does not introduce new
settlement authority or a physical field.

Test-only qualification events include the exact action tuple and route. For
the two live-stale-worker sentinels, a test-only exact-tuple lease expiry makes
generation 0 stale while its process is paused after the durable action intent;
the real generation-1 daemon acquires the next lease and commits that same
logical action. After generation 1 commits, generation 0 is released. The
Observation and Settlement paths both report suppression before their direct
effect callback, or remain quiescent after the stale lease is observed. No
schema, event, or persisted recovery fact is added for these probes.

## Evidence

Focused module qualification:

- `apps/single-workspace/test/durable-control-action-effect.test.ts`: a stale
  fenced Action transition rolls back the staged effect, sourced Session item,
  and cursor; retry applies once and a second attempt cannot repeat the effect.
- `packages/agent-runtime/test/p9-durable-settlement-effect.test.ts`: the
  settlement effect is absent before terminal commit and is committed with the
  ActionResult/`SettlementProposed` state; recovery evidence remains one
  terminal result.

Real-process qualification is in
`tests/functional/process/agent-loop-p9-direct-control-effects.functional.test.ts`:

| Action | Before effect | Effect applied, result transaction not committed | Atomic result committed before kill | Live stale gen0 released after gen1 commit |
|---|---:|---:|---:|---:|
| `propose_workspace` | PASS | PASS | PASS | — |
| `update_plan` | PASS | PASS | PASS | PASS (Observation) |
| `claim_completion` | PASS | PASS | PASS (AH9 terminal boundary) | PASS (Settlement) |

The 9-case commit-boundary matrix passed serially **11/11** together with the
two live-stale cases (11 total), preserving the same `LogicalActionId`, one
business row/effect, one sourced `ControlResult`, and one P9 Action/cursor
transition. `propose_workspace` additionally asserts a unique Formation
Proposal, Formation Fulfillment, and Governance Inbox entry. `claim_completion`
asserts the WorkWait row and `SettlementProposed` state.

Validation on this worktree:

- `pnpm build` — PASS.
- `pnpm --filter @arbor/web build` — PASS (existing large-chunk warning only).
- Focused module tests — 2/2 PASS.
- Real-process file — 11/11 PASS.
- `pnpm exec biome check` on changed files and `git diff --check` — PASS.
- Functional manifest `--validate-only` — PASS.
- Full `pnpm check` and the full functional suite were not run for this batch.

## Scope boundary

This qualifies the three direct persistent effects only. It does not close
AH10: other action state combinations remain outside this matrix, and the
previously identified direct-child `AssignWork` committed-receipt
before/after takeover gap still needs its own disposition/qualification. No
P9/AH10 phase-closure claim follows from this batch.
