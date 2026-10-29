# Schema-42 P12 / F21 Fixture Migration

Date: 2026-10-13

## Scope and implementation

Current composition, transport, daemon, F21, pending view, and B01 capability
fixtures use suite-level schema-42 templates with independent SQLite clones.
Each active app case has a 120-second timeout and disposes its clone in a
`finally` path. Suite template hooks also have explicit 120-second timeouts.
The shared capability harness gives app-backed capability cases a 120-second
test timeout. `public-chat` keeps a clone for the full suite when a case
deliberately reuses the same database across multiple app invocations; the
suite factory owns its cleanup.

`p12-transport` retains its two explicitly documented adapter-only P38 cases.
The F21 tuple-conflict assertions now match the current external 409 contract.
The pending view cases authenticate the non-loopback listener when exercising
unauthenticated requests and verify that an unconfigured wildcard listener is
rejected before serving traffic. P39 ACL helper subprocesses have a bounded
30-second timeout. Ordinary test cleanup refuses to remove the invocation
TEMP root or any ancestor; only `p39-windows-global-setup.ts` removes that root
at global teardown.

## Static verification

- Biome on the affected files: PASS.
- `pnpm typecheck`: PASS.
- `git diff --check`: PASS.

## Targeted qualification

- P12 acceptance / production composition / runtime safety / secret store /
  transport plus F21, single worker: latest full batch was 6 files, 5 passed
  and 1 failed; 77 tests, 74 passed and 3 failed. Production composition,
  runtime safety, secret store, transport, and F21 passed. The remaining
  failures were Story 9 D2 (`P39_WRITER_LOCK_UNSUPPORTED_DEPLOYMENT`) and D3/D4
  (PowerShell ACL setup exceeded the former 5-second timeout).
- After bounding P39 Windows security and ACL operations, Story 9 D2–D4 passed
  in a focused run: 3 passed, 16 skipped.
- Capability gray-box B01 passed: 1 passed.
- Pending P12 view auth cases passed in the dedicated functional config: 2
  passed. These confirm 401 for unauthenticated requests to an explicitly
  authenticated remote listener, rejection of an unconfigured wildcard
  listener, and successful loopback reads.

There was an earlier full-batch run where Story 6/7/9 saw `ENOENT` for the
invocation TEMP root. Static path review found that test fixtures remove only
their own `mkdtemp` children; the root's only removal call is global setup
teardown. A guard now fails closed if ordinary P39 directory cleanup is ever
given the invocation TEMP root or an ancestor. The subsequent full batch did
not reproduce the TEMP-root error.

The full P12/F21 batch has not completed entirely green: Story 9 D2–D4 passed
only in the focused retry after the ACL timeout fix. The remaining P12
acceptance cases and real-provider tests that use `public-chat` were not
rerun. No production/design scope beyond the separately cherry-picked P39
Windows security timeout fix was changed.

## Commits

- Fixture migration and test cleanup: `8d7be0bb`, `9d9a937e`, `ce5fd7ad`,
  `655ea71d`, `6e1e10ee`, `141c7530`, `f579f24e`, `a646cdb4`, `b6af3e61`.
- F21 and pending-view corrections: `e48811fc` and this result record.
- P39 Windows security timeout: `75ae9fba`.
- P39 test-support child-process timeouts: `ec5c0afb`.
