# F18-07 targeted qualification checkpoint

Date: 2026-10-21
Feature HEAD: `84cde0d5`
Implementation/qualification commits: `1f84e51c`, `a7b984ea`, `4a9c2a7f`,
`34c1ad4f`, `620cf911`, `786648e5`, `db8a2b7b`, `3a076d87`, `cc688142`,
`3fe7f95c`, `9f6bd343`, `84cde0d5`
Status: **targeted layers passed; full F18-07/F18-08 qualification remains open**

## Review-finding disposition

The independent implementation review identified four B1 issues. The two
F18-06 type/read-model findings and both F18-07 persistence/recovery findings
were addressed in the commits above:

- Public F18 criterion snapshot assertions now include `requirement` and
  `required` in their typed view shape.
- P51 migration-source pin verification normalizes CRLF to canonical LF before
  hashing, matching the immutable accepted source hash on Windows and Unix.
- Dead-letter candidate selection excludes terminal reconciliation rows and
  unexpired leases before applying the ordered batch limit. Expired leases
  remain eligible for takeover, and later candidates are not starved.
- The activation high-water reader returns the complete raw fact. The
  application validates Project binding, non-negative safe sequence, canonical
  UTC capture time, and the accepted fact digest. Invalid facts fail closed to
  `StateCorruption` Attention; verified compatibility facts are included in
  `sourceDigest`.

Independent targeted re-review of `620cf911` found B0/B1/B2 = 0. The later
compatibility-test-only commits (`786648e5` through `84cde0d5`) have not yet
received the final latest-HEAD review; that review is requested by the parent
integrator.

## Targeted evidence

- F18 domain/event, receipt, schema migration, workflow consumer,
  reconciliation, P10 Attention/rebuild, and Verification view batch:
  **9 files / 60 tests passed**.
- P51 offline schema-50 → 0051 upgrade/resume case:
  `apps/single-workspace/test/schema-upgrade-operator.test.ts -t "upgrades a
  disposable schema-50 copy through 0051"`, **1 passed / 24 skipped**.
- Real daemon/public F18 reconciliation crash matrix:
  `pnpm exec vitest run --config vitest.functional.config.ts --no-cache
  --no-file-parallelism tests/functional/process/organization.functional.test.ts`,
  **12/12 passed in 624.03s**. It covers source validation before claim;
  lease-claim commit; Verification wake effect and disposition; Parent Inbox
  atomic commit before/after; Parent wake effect and disposition; Completed
  disposition before/after; and Attention fact/queue commit before/after.
  Recovery scenarios assert offset/dead-letter retention, one conclusion event,
  exact Inbox cardinality, lease expiry/takeover, and synchronized dual-daemon
  competition where work remains nonterminal.
- Store/app reconciliation focused tests, including terminal/active/expired
  candidate selection and captured-at/digest tampering: **5/5 passed**.
- P10 Verification view: **15/15 passed**.
- Strict-writer compatibility fixes: P5's current-schema table assertion now
  includes the five schema-51 tables; P9 poison-reader tests assert public
  writer rejection and inject only their historical poison rows through raw
  SQL; the prior-generation v2 receipt fixture now uses explicit null.
  Targeted affected files passed: P5 slice **1/1**, verification replay
  **1/1**, and P9 acceptance/consumer/rebuild **29 passed / 1 expected fail**.
- Core full-check progress on the feature branch: Biome **1357 files**,
  TypeScript and architecture **37 files / 194 tests** passed. Core batches
  1–21 passed on the candidate before the final poison-fixture-only change.
  The batch-22 failure (P9 tests attempting to write unregistered poison
  pairs) was corrected in `84cde0d5`; the corrected P9 files then passed the
  targeted result above. The exact remaining batch 23 passed separately:
  **7 files / 59 tests**.
- Web gates: `@arbor/web` typecheck and build passed; Vitest **34 files /
  262 tests passed**.
- `pnpm exec tsc -b --pretty false`: **passed**.
- Biome on the touched implementation, qualification, and test files:
  **passed**; `git diff --check`: **passed**.

The current candidate's targeted batch was rerun with this command and returned
**9 files / 60 tests passed**:

```text
pnpm exec vitest run --no-file-parallelism packages/domain/test/events.test.ts packages/application/test/command-result-codec.test.ts tests/p8-conclude.test.ts adapters/persistence-sqlite/test/verification-v2-consumer-reconciliation-migration.test.ts tests/workflow-signal-consumer.test.ts packages/application/test/verification-signal-reconciliation.test.ts adapters/persistence-sqlite/test/verification-signal-reconciliation-store.test.ts packages/application/test/p37-attention-poll-loop.test.ts tests/p10-activation-attention-reconciliation.test.ts tests/p10-views-detail.test.ts
```

The earlier independent review reported **52/52** at its reviewed snapshot;
these are distinct recorded runs, not additive counts. The current result
includes the later store, high-water tamper, and read-model regression tests.
No count is carried forward without its command/result pairing.

The full offline schema-upgrade operator file passed as part of core batch 9
after canonical LF hashing. An earlier run had 8 failures caused by the Windows
CRLF/raw-hash mismatch; the targeted P51 schema-50 → 0051 upgrade/resume case
also passed after the fix.

## Remaining qualification

The exact `pnpm check` command has not yet completed end-to-end on the latest
feature HEAD. A run on the immediately preceding candidate passed batches
1–21, then failed batch 22 only at the strict-writer poison fixtures; the
corrected P9 test files and batch 23 were qualified separately above. The
parent integrator will run the final official full check after merging this
feature with preintent. Full `pnpm test:functional`, clean-checkout F18 rerun,
final latest-HEAD review, and final implementation result/runbook remain open.
This checkpoint is not a release-readiness or F18 closure claim.
