# P38 Wave 2 public, freshness, migration, and Queue qualification

Status: **PASS for the scoped Wave 2 cases; P38 remains open.**

- Baseline: `0cf2ce4b` (P38/P40 Stop-existing-winner follow-up).
- Scope: public ResolveExecutableApproval authorization/stale receipt behavior,
  P39 environment freshness and selected-region binding, legacy Control
  migration refusal, and browser Queue Reject/Expired recovery. No frozen design
  documents or production composition probes changed.
- The stale-revision result follows the frozen P12/P1/DID contract: an
  authorized stale revision returns a durable `TerminalRejected(RevisionConflict)`
  receipt with no domain event; exact same-CommandId replay returns that receipt
  without additional writes. Unauthorized actor mismatch is rejected before
  receipt admission with the exact `authority/denied` Problem and no writes.

## Evidence

- P39 `EnvironmentRevisionStore=None` with observed revision `"0"` succeeds.
  The binding hashes the exact selected target region, not the larger workspace
  boundary region set. A first stale snapshot causes one fresh resolution and
  then succeeds; a second stale snapshot fails closed before intent, approval
  consumption, admission, binding, or effect writes.
- The public process case asserts unauthorized ResolveExecutableApproval is
  HTTP 403 `authority/denied` with `principal/actor-mismatch`, no command/event
  count changes, and no approval/action/P4 state changes. A stale authorized
  revision returns the exact `TerminalRejected` / `RevisionConflict` receipt,
  increments the command ledger once, writes no domain event, preserves
  approval/action/P4 state, and exact replay returns the same receipt without
  further ledger changes.
- The schema-37 legacy Control migration negative asserts the failure is a
  SQLite `SqlError` with constraint code 275; user_version remains 37 and
  preserved source rows remain unchanged.
- Browser Queue Reject commits the decision, resumes the same action to
  `TerminalRejected` with P4 `Denied(ApprovalRejected)`, consumes the exact
  Inbox item once, and creates no effect. Browser expiry renders the expired
  status with no Approve/Reject controls, resumes to P4
  `Denied(ApprovalExpired)`, and creates no effect.

## Verification

- P39 freshness target:
  `pnpm exec vitest run --maxWorkers=1 --no-file-parallelism --retry=0 packages/tool-runtime/test/p4-pipeline.test.ts -t "P39 environment None|first stale P39|single allowed P39"`
  — **3 passed, 30 skipped**.
- Public authorization/stale target:
  `pnpm exec vitest run --config vitest.functional.config.ts --maxWorkers=1 --no-file-parallelism --retry=0 tests/functional/process/p38-executable-approval-public.functional.test.ts -t "unauthorized and stale public"`
  — **1 passed, 10 skipped**.
- Legacy migration negative:
  `pnpm exec vitest run --maxWorkers=1 --no-file-parallelism --retry=0 adapters/persistence-sqlite/test/p38-legacy-control-consumption-migration.test.ts`
  — **1 passed**.
- Browser Queue target:
  `pnpm exec playwright test --config playwright.functional.config.ts tests/functional/ui/p38-executable-approval-browser.spec.ts`
  — **3 passed** (Approve baseline, Reject, Expired).
- `pnpm typecheck` — **PASS**.
- Biome on the four changed TypeScript files — **PASS**.
- `git diff --check` — **PASS**.

No full functional or full repository suite was run. These cases do not close
P38 beyond the listed rows or establish broader P39 freshness qualification.
