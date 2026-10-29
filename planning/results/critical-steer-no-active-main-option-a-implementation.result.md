# Critical Steer Option A Implementation Result

**Decision:** `ACCEPT_CRITICAL_STEER_NO_ACTIVE_MAIN_OPTION_A`  
**Accepted proposal SHA-256:** `41A732B1092CF2147BA319E0FEE5D7513CF899C53917051EF501AA8EBCDF8F20`  
**Governance landing:** `307f6f2d9ef25060a080cc85f8082669846dbe1a`  
**Independent design landing review:** `b69eeefa` — PASS, Blocking = 0  
**Implementation:** `2aac9071`  
**Focused qualifications:** `1ac2a939`

## Implemented behavior

- The outer human `SteerWork` remains the single Gateway command and receipt.
- For Critical severity, the composition root prepares the exact P12 external
  Stop authority using the outer principal, CommandId, StopExecution
  fingerprint, and selected active main.
- The Critical handler re-reads the active main by Workspace inside the outer
  Gateway transaction; it does not filter by WorkId.
- If no active main exists at this transaction-time read, the handler executes
  SteerWork normally: Work stays Open, revision advances, HumanInput is
  admitted, and no StopExecution or `ExecutionStopRequested` event is emitted.
- If a main becomes active after preparation, the handler resolves Stop
  authority again for that exact transaction-time Execution and commits the
  SteerWork and Stop handler outcomes together. A stale no-active preparation
  cannot suppress the Stop. If exact authorization or Stop application fails,
  the transaction rolls back with no partial Work, Inbox, Event, or Receipt
  facts.
- Exact Gateway receipt replay bypasses preparation and does not reselect an
  active main.

## Evidence

- `pnpm build` — PASS.
- `pnpm exec tsc -p tsconfig.test.json --noEmit` — PASS.
- `pnpm exec vitest run tests/p6-critical-steer.test.ts apps/single-workspace/test/external-command-composition.test.ts` — PASS, 2 files / 17 tests.
- Biome on all changed source and test files — PASS.
- `git diff --check` — PASS.

The focused tests cover one outer receipt and event set, exact replay without
reselection, no-active commit without Stop, the stale-no-active/new-main race,
P12 exact authority re-resolution, and Stop-child failure rollback. No daemon,
real Provider, browser, or full suite was run. This result is not process
qualification and makes no crash/restart claim.
