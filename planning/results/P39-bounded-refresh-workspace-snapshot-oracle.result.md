# P39 bounded-refresh Workspace snapshot oracle

Date: 2026-10-16

Scope: diagnose the three `p4-pipeline.test.ts` failures at
`fdb21ca2bab52b42aa0236b70de0a595230878b5`. They were exact-object assertion
failures after test instrumentation began recording Workspace snapshots; no
production behavior change was required.

## Call-source classification

- `InitialBoundaryResolve`: ToolRuntime reads the canonical Workspace to resolve
  the requested mount and capture its resource boundary. When the invocation
  and boundary environment revisions are non-stale/equal, there is no refresh.
- `RefreshedBoundaryResolve`: only after an invocation-vs-boundary stale
  mismatch consumes the single bounded refresh, ToolRuntime repeats initial
  resolution and captures the refreshed boundary.
- `FinalClaimFreshness`: the P39 claim transaction performs a fresh Workspace
  read in `validateCapturedSnapshotAndAdmit`; revision and ordered addresses
  must still equal the captured boundary before admission, intent, approval
  consumption, RecoveryBinding or attempt-0.
- P39 RecoveryBinding projection does not perform another Workspace lookup. It
  projects the captured Workspace revision and is checked against the initial
  snapshot (or the refreshed snapshot after the one permitted refresh). Thus a
  non-stale successful P39 invocation has two Workspace reads, not an
  unbounded reread; a refreshed successful invocation has three.
- Early exits before the claim transaction do not run final claim freshness:
  ApprovalRequired and a P38 approval id without exact executable context each
  have only the initial boundary snapshot. ResourceAdmissionDenied enters the
  claim transaction, so it has initial + final-freshness snapshots but writes
  no intent, consumes no approval and admits no effect.

The test fixture now labels its Workspace reads by phase and asserts Workspace
identity, revision, and addresses. Exact P39 success ties the RecoveryBinding's
`resourceBoundaryRevision` to the captured snapshot. The bounded-refresh success
ties it to the refreshed snapshot. Existing final-stale cases assert the third
read detects revision/address drift and that claim writes roll back.

## Verification

- `pnpm exec vitest run --maxWorkers=1 --no-file-parallelism --retry=0 packages/tool-runtime/test/p4-pipeline.test.ts` — **1 file / 38 tests passed**.
- `pnpm typecheck` — **PASS**.
- `pnpm exec biome check packages/tool-runtime/test/p4-pipeline.test.ts` — **PASS**.
- `git diff --check` — **PASS**.

No full suite was run. No frozen design document or production source was changed.
