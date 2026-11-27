# CI Architecture — adopted transformation plan

Status: adopted 2026-11-27 (owner decision, full 16-section source plan
from the owner's parallel analysis). Owner document for the CI campaign.
The interim four-job split (PR #51) is a stepping stone inside stage 2. The current quality workflow runs on dedicated `self-hosted, linux, x64, arbor-ci` runners; CodeQL remains GitHub-hosted.

## Problems measured at master@1492bfe2

Single serial quality job; core tests run twice (pnpm test then
test:coverage); three overlapping build paths; 10-file Vitest batches
serialize ~51 process launches; **no independent Web checks** (unit,
typecheck, build absent from CI); full functional journey on every PR;
impact-map exists (scripts/testing/plan-test-impact.mjs +
tests/impact-map.json) but unused by CI; upstream failure
masks downstream results (health reports "coverage missing" instead of
the real fault).

## Target architecture

Four pipelines by verification obligation (not by speed alone):
- **PR CI** — merge-blocking correctness: static / build / core shards
  / web / required integration (smoke + risk-tagged recovery)
- **Main CI** — full deterministic regression on master: complete
  functional, recovery, browser E2E, coverage aggregation
- **Nightly** — expensive/statistical: flakiness repetition, real
  provider eval, benchmarks, mutation, Knip/jscpd, migration matrix,
  long-running leak tests
- **Release CI** — artifact qualification: clean-environment install,
  upgrade/backup/restore, native-sandbox qualification on controlled
  runners, SBOM/provenance, manual Go/No-Go

Safety invariants (permissions, transactions, execution recovery) keep
merge-blocking evidence — slowness never defers a required invariant.

The adopted implementation keeps six functional shards and caps hosted and
local execution at six concurrent shards. Container UIDs match the runner
workspace owner, hosted jobs use a writable per-job pnpm store, and Linux
process-tree cleanup distinguishes zombie descendants from live processes
while retaining the descendant disappearance check. These boundaries are part
of the CI contract because otherwise a green test result can depend on runner
filesystem ownership or PID-reaping timing.

## PR-CI job DAG (stage-2 target)

plan → {static, build, core(×4 shards), web, integration, security} →
coverage(merge-only) → gate.

- **Sharding**: `vitest run --shard=N/4 --coverage --reporter=blob`,
  fail-fast=false; merge via `--merge-reports --coverage` (verify blob
  paths on Vitest 5.0.1). Coverage NEVER re-executes tests.
  Ramp workers conservatively (1 → 2 → 4) after leak/race observation —
  the old 10-file batching may have masked resource accumulation.
- **Impact analysis**: plan.mjs reuses plan-test-impact.mjs as a
  verification-plan generator emitting an auditable CI Plan
  (sourceSha/baseSha/policyDigest/riskTags/requiredChecks/selection).
  Shadow Mode first: full runs continue; skipped-suggestions must stay
  green for N runs before selection actually reduces scope.
- **Merge gate**: one stable required check ("Arbor Merge Gate")
  validating job results against the plan — success/failure/cancelled/
  unexpected-skip/missing-report/wrong-SHA each decided explicitly;
  never treats a skip as a pass.
- **Health split**: Hard Gate (blocks) / Ratchet Gate (blocks:
  naming, source-size) / Diagnostic (non-blocking trends). Upstream
  failure must surface as itself, not as "coverage missing".
  Structured per-run JSON + GitHub Job Summary tables.

## Build & cache

pnpm store cache on (already landed in #51); playwright browser cache
after measurement; build-artifact sharing measured before adoption;
frozen-lockfile install always runs (cache is speed, not evidence).
Release artifacts always built independently, never from cache.

## Functional reclassification

Existing profiles gain owner/resource/risk tags in the manifest (one
test runs at most once per plan): public-journey / recovery / authority
/ persistence / browser / package channels; PR runs smoke +
risk-selected recovery; Main runs release (full); process-profile
overlap with package deduplicated without losing the install
obligation.

## Implementation sequence (six PRs)

1. Correctness fixes: restore independent Web checks; fix naming-gate
   default empty scan; fix test-classification ledger; keep all
   current obligations.
2. Pipeline split: composite action (setup-arbor: node+pnpm+cache+env
   prep), static/build/web/core split, CodeQL stays independent,
   merge gate lands. (#51 is an early partial of this.)
3. Sharding + coverage merge (baseline timings first; set-equality
   audit of covered files; remove double core execution).
4. Resource isolation (tmpdir/scan conflicts, process/db leak checks,
   worker ramp).
5. Impact analysis shadow mode + Main/Nightly workflows.
6. Release workflow + structured evidence + planning-config migration.

## Acceptance targets (to be calibrated by measurement)

Ordinary PR CI ≤10–15 min; static feedback ≤3 min; zero unplanned test
omissions; zero duplicate core executions; zero unexpected required-
check skips; resource conflicts never hidden by retries; runner-minute
cost tracked against wall-clock; evidence bound to tested SHA; ten
consecutive controlled green full runs before gate switchover.
