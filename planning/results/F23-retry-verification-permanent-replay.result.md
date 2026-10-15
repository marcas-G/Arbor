# F23 / P8 RetryVerification Permanent Replay — RED Evidence

状态：**真实 public-process RED；Design Gap proposal pending; not fixed and not F23/P8 closure**

## Reproduction

Added isolated pending test
`tests/functional/pending/f23-retry-verification-permanent-replay.functional.test.ts`.
It starts the production daemon/public `/commands` boundary, creates a fresh
project through the public client, then seeds only the disposable fixture DB
with one Open Work, one Open Verification, and one settled exact-bound verifier
Execution. The public `RetryVerification` command is submitted once and
commits the Orphaned conclusion, successor Verification, and receipt. The same
CommandId and exact payload are immediately submitted again.

The expected result is the original HTTP 200 Committed receipt with the same
successor IDs, as required by P8 `01` §3A and `06` Story H. At baseline
`bee70f2a58f3c42610fa245adb4d8dd9f9e06b68`, the actual result is HTTP 403
`authority/denied`, reason `NoApplicableGrant:RetryVerification`; the Resolver
rejects the now-Concluded source before Gateway. The test failure is the
intended RED evidence, not a passing qualification. The fixture is disposable;
no online/preserved DB was opened or changed.

Exact command:

```text
pnpm build
pnpm exec vitest run --config vitest.pending-functional.config.ts tests/functional/pending/f23-retry-verification-permanent-replay.functional.test.ts
```

Observed: build PASS; targeted process test **1 failed as expected** at the
same-receipt assertion (`403 authority/denied` vs first request's `200
Committed`). The first request had committed the expected stable result IDs.
The test remains under `pending/` and is not included in the release functional
green gate.

The pending Vitest config now includes the existing schema-42 fixture global
setup, matching the functional config required by `startProductionFixture`;
without it the test stopped before daemon startup with “Functional schema-42
bootstrap is missing.” This config change only enables the isolated RED
reproduction; it does not alter production migrations or online databases.

## Disposition

P8 exact replay has no expiry, Commands are permanent, and Domain Events can
be pruned after a deployment-configured horizon. Current canonical Verification
rows have no permanent originating-command binding. The event-only candidate
was therefore withdrawn: it would not prove permanent replay after pruning,
and a state-only replay authority would let arbitrary CommandIds reach the
receipt-dependent Gateway path. See
`planning/proposals/F23-retry-verification-permanent-replay-authority-draft.md`
for the complete Design Gap, candidate permanent binding, migration/backfill
boundary, and required negatives/atomicity/retention matrix.

No `docs/design/**`, production code, schema registry, migration, or online
database was changed for this gap disposition. The F23 `bee70f2` Resolver-before-
Gateway correction remains committed independently; this RED demonstrates
the unresolved P8 exact-replay interaction and does not authorize a workaround.
