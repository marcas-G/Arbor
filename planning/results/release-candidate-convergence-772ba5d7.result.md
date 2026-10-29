# Local release-gate convergence — `772ba5d7`

Date: 2026-10-24
Tested source revision: `772ba5d713032fbccd7623264f5b664bee22f4a9`

## Results on the exact candidate

- `pnpm check`: **PASS**, exit 0. Biome: 1415 files; architecture: 37 files / 194 tests; core: 465 files across 24 batches passed (retaining the runner's expected-failure and known-skip classifications); Web: typecheck/build passed and 34 files / 266 tests passed.
- `pnpm test:functional`: **PASS**, release profile, exit 0, `completeCoverage=true`. The summary selected 64 files: 6 executed in this resumed run and 58 inherited from a resume source explicitly reported compatible. The UI group passed 10/10.
- `pnpm test:package`: **PASS**, exit 0. Build passed and the clean-checkout package test passed 1/1.

Run summaries are retained locally under the ignored `.test-results` paths:

- `.test-results/2026-10-24T12-31-19-483Z-29480/summary.md`
- `.test-results/2026-10-24T13-58-29-351Z-20952/summary.md`

This closes the named local `check`, complete-coverage scripted functional,
browser, and package/clean-checkout gates for this exact candidate, using the
functional runner's recorded compatible resume. It is not a single
uninterrupted execution of all 64 files. It does not qualify real-provider
behavior, Native OS sandbox support, an upgrade of an existing online/user
database, or release readiness. Those remain separate gates.

## Remaining delivery gates

- **Real Provider:** S1 has one bounded lifecycle pass but its test/runtime
  source SHAs differ; S2 immediate Stop passes while Normal Steer previously
  ended in a terminal Verification FAIL; S3's latest real run stalled on a
  settled no-producer AnyProducer wait; S4-A has a bounded fail-closed restart
  PASS, while S4-B has not reached its Executable-approval/restart oracle.
- **Recovery:** the [current recovery closure audit](current-recovery-closure-audit-772ba5d7.result.md)
  supersedes older blanket labels for supported v1 paths on this candidate:
  registered AH7 DG-01/02/03, registered AH10 (including Deliver,
  verification actions and P41), and AH14 ambiguous-legacy Attention pass the
  current default matrix. Same-holder copied concurrency remains explicitly
  unsupported; shell@3 remains NonIdempotent; legacy shell@2 remains
  fail-closed without trusted proof.
- **Still open:** four exact verification/P8/F23 cases are awaiting default
  promotion; P6 public read qualification and Submitted DecisionEpisode
  corruption semantics remain open; Native OS, real-provider, and existing
  database gates remain separate. See the current recovery audit for exact
  paths and boundaries.
- **Native OS sandbox:** no provider is Supported. Synthetic V6 and the LPAC
  probe do not establish production OS enforcement; keep Native isolation out
  of the release claim until a supported provider and enforcement qualification
  exist.
- **Existing database:** the runtime target is schema 52 and disposable offline
  migration qualifications exist. They do not qualify an online/preserved
  user database; that operation remains separately authorized.
