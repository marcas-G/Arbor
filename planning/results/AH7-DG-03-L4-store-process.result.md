# AH7-DG-03 L4 P4 store-process qualification

Status: **targeted store-process batch PASS; L4 remains OPEN**.

The test uses a file-backed SQLite database seeded by the parent test process,
independent Node child processes running the production SQLite
`ToolInvocationStoreLive` and `TransactionPortLive`, and a separate read-only
SQLite connection for assertions. Each child parks either inside the store
transaction before COMMIT or directly after COMMIT; the parent sends SIGKILL,
checks durable state, and launches a fresh child with the same invocation
identity to retry or replay.

## Evidence

- `tests/functional/process/agent-action-ah7-p4-store-process-crash.functional.test.ts`:
  1 test passed, covering six before/after-COMMIT branches:
  - approval claim: pre-COMMIT kill leaves no intent and approval unconsumed;
    retry creates exactly one `NotAdmitted` invocation and consumes the exact
    approval; post-COMMIT kill preserves both and same-invocation replay is
    idempotent;
  - no-effect Denied: pre-COMMIT kill leaves no denial row and approval
    unchanged; retry records one `Denied`/`NotAdmitted` row; post-COMMIT kill
    preserves it and same-identity replay is idempotent;
  - StopRequested Interrupted: pre-COMMIT kill preserves the already committed
    claim but not interruption; retry settles the same invocation as
    `Interrupted`; post-COMMIT kill preserves it and same-identity replay is
    idempotent.
- Each branch inspects canonical invocation count and approval consumer from a
  separate SQLite connection. The store child has no Sandbox or Executor path;
  this evidence therefore asserts no external effect was started, but is not a
  production daemon, ProviderTurn/Action/cursor, or approved Executable
  handoff qualification.
- `node --check tests/functional/support/ah7-p4-store-crash-child.mjs`: PASS.
- `pnpm exec biome check --write` on the two L4 test/helper files: PASS, no
  formatting changes required.
- Target command:
  `pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-action-ah7-p4-store-process-crash.functional.test.ts --testTimeout 120000`
  — **1/1 test PASS**, 19.65s total, 16.063s test time.
- The first two target attempts failed before reaching a crash probe because
  fixture rows were seeded as approval suffixes `001`–`006`, while the six
  scenarios requested `101`–`106`; the child correctly rejected the missing
  approval at claim CAS. The seed range was aligned to the six requested ids;
  no production code or contract changed.

## Boundary

This closes only the initial P4 store-process claim/Denied/Interrupted batch.
It does not qualify real daemon crash/restart, approved Executable routing,
effect admission, external effect/reconciliation, P4 settlement, or P3
ToolResult/Action/cursor convergence. Those remain subsequent L4 rows; AH7 is
not closed. No full suite, real dual-daemon test, or integration/main-tree
change was performed in this batch.
