# F18-05 Verification signal reconciliation checkpoint

Date: 2026-10-21  
Implementation HEAD: `15ab5efc`  
Status: **checkpoint only; F18-05 crash matrix and F18-06 read model remain open**

## Implemented at this checkpoint

- Durable workflow reconciliation identity and P51 state store: Pending phases,
  generation-fenced lease takeover and CAS, immutable source/effect digests,
  terminal Attention facts, and retained P10 Attention admission queue.
- Historical source scan is limited to `workflow-signals` dead letters with
  the accepted reasons and raw `VerificationConcluded(v2)` source. It validates
  exact envelope/payload, canonical Verification/Work/owner/Parent route, and
  the committed ordinary v2 receipt or G5 RetryVerification v1 receipt. The
  bounded `LegacyAbsentReasonV2` tuple is high-water gated. It does not replay
  commands, Verification, Provider, Verifier, or model turns.
- Live/recovery effect plan convergence: exact Verification wait release and
  owner reevaluation, Child Pass Inbox admission/validation with consumed state
  preservation, atomic Parent Inbox plus phase commit, then Parent wake and
  terminal completion.
- P10 live projection reads the retained queue independent of journal offset;
  rebuild recreates markers from immutable Attention facts and updates queue
  state in its transaction. Public Attention uses the fixed Root-targeted
  ActionRequired source/summary/failure-code projection.
- Production startup and periodic recovery run the bounded reconciliation
  sweep before admitting new dispatch.

## Evidence

- Focused F18/application/persistence/read-model set: **9 files, 59 tests
  passed**.
- P39 schema-registry suffix checks updated for schema 51: **3 files, 8 tests
  passed**.
- Real F18 public-process qualification: `tests/functional/process/organization.functional.test.ts`,
  **1/1 passed**. The test injects a poison dead-letter and forward-only
  `workflow-signals` offset in its disposable database, crashes the daemon
  after the atomic Parent Inbox/`ParentInboxCommitted` commit, verifies both
  survive restart, then synchronizes two independent daemon processes after
  source validation. One generation-2 lease owner converges the row; the
  Parent Inbox row remains unique, Parent Acceptance succeeds, and the child
  Work completes.
- `pnpm build`: **PASS**.
- Biome on the 10 checkpoint files: **PASS**; `git diff --check`: **PASS**.
- `pnpm check`: **not completed**. The latest attempt passed Biome, typecheck,
  architecture (37 files / 194 tests), and core batch 1 (20 files / 64 tests),
  then was stopped at the explicit request to defer the full gate until the
  read-model layer is complete. Earlier full-gate attempts exposed stale
  current-migration suffix expectations; those P39 expectations were fixed,
  but the complete gate has not been rerun afterward.

## Remaining work / limits

- This is not F18-05 closure. The public process probe covers the
  `ParentInboxCommitted` restart boundary and a synchronized two-daemon lease
  competition; it does not yet qualify every reconciliation effect/disposition
  boundary, every fixed Attention failure code, lease-generation regressions,
  or every kill-before/after-commit permutation.
- F18-06's exact four-state Verification criterion read model is not yet
  implemented or qualified. Consequently this checkpoint makes no claim that
  the public criterion read-model portion of F18 passes.
- No preserved or online database was migrated. Functional process
  qualification used a disposable schema-50 clone upgraded to 51; focused
  offline schema upgrade tests are recorded in the F18-03 checkpoint.
- A separate independent implementation/code review and final full
  `pnpm check` / `pnpm test:functional` remain required before closure.
