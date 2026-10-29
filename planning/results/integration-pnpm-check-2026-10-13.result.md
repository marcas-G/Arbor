# Integration full `pnpm check` result

Date: 2026-10-13  
Checked HEAD: `a8f9980e8dffc0d71bec5d662bd357e4aca5e705`  
Outcome: **FAIL** (exit 1 at the root Vitest stage)

## Command and durable output

Ran exactly one `pnpm check`. The raw, unedited console log is at
`C:\Users\ThinkPad\.codex\worktrees\full-code-convergence-release\Arbor\planning\results\integration-pnpm-check-2026-10-13.log`.
It is ignored by the repository's `*.log` rule and was not force-added.
SHA-256: `13761B4266E1018171D5AC4FC373EEC49E75FA601C665F2664B6B5EE030F10B5`
(87,219 bytes).

## Stage results

- `pnpm lint`: PASS, Biome checked 1,139 files.
- `pnpm typecheck`: PASS.
- Architecture: PASS, 31 files / 159 tests.
- Root Vitest: FAIL, 392 files; 353 passed, 39 failed. Tests: 2,066 passed,
  79 failed, 13 skipped. The Web typecheck/build/test stages did not run because
  `pnpm check` stops at Vitest failure.

## Failure grouping

The log contains 82 `FAIL` report headings, including two suite-level headings;
61 headings include `P39_WRITER_LOCK_UNSUPPORTED_DEPLOYMENT`. This remains the
dominant cause after the focused P39 fix passed its 22 persistence, 3 writer,
and 2 Blocked restart tests. A representative failure is
`apps/single-workspace/test/p13-web-e2e.test.ts`: production startup raises
`P39MaintenanceFailure` → `P39_UNSUPPORTED_DEPLOYMENT` →
`P39_WRITER_LOCK_UNSUPPORTED_DEPLOYMENT`. The black-box subprocess also exits
from `apps/single-workspace/dist/main.js` with that diagnostic before HTTP is
available (`fetch-failed`).

P39-coded failure files:

- `apps/single-workspace/test/`: `i0-send-message-durable`,
  `mac-p1-root-work-initiation`, `mac-p1-workspace-knowledge`,
  `mac-p2-formation-fulfillment`, `mac-p2-parent-accept-result`,
  `mac-p2-workspace-placement`, `mac-p3-dependency-delivery`, `p13-web-e2e`,
  `p14-conversation-history-pagination`, `p14-real-provider-conversation`,
  `p34-attention-projection-daemon`, `p38-runtime-schema-boundary`,
  `p5-completion-claim`, `p5-composition`, `p5-directive-unsupported`,
  `p5-restart-continuity`, `p5-session-continuity`, `p5-slice-acceptance`,
  `p5-slice-registry`, `p5-yield-wake`, `provider-config`,
  `wave2-claim-completion`.
- Other P39-coded files: `tests/capability/black-box/s1-s4-public-api.test.ts`,
  `tests/capability/gray-box/b01-public-conversation.test.ts`,
  `tests/f21-create-project-resource-admission.test.ts`,
  `tests/p12-acceptance.test.ts`, `tests/p12-production-composition.test.ts`,
  `tests/p12-runtime-safety.test.ts`, `tests/p12-secret-store.test.ts`,
  `tests/p7-wake-pipeline.test.ts`.

Other observed failure groups:

- P9 four-tier recovery: `tests/p9-tool-outcome-unknown.test.ts` has TT1–TT3
  `LeaseFencingRejected`; TT4 and the P9 Story E test fail before their
  injected crash with `Cannot read properties of undefined (reading 'map')`.
- Rebuild floor assertions fail in
  `adapters/persistence-sqlite/test/p1-journal-consumer.test.ts` and
  `tests/p9-rebuild-durability.test.ts` (`replayed: 2, floor: 2`).
- `adapters/persistence-sqlite/test/p4-tool-settlement-fence-expiry.test.ts`
  is denied with `ResourceResolutionDenied` before the settlement-time probe.
- `tests/workflow-signal-consumer.test.ts` fails because the mocked
  `admitUpsertSequenced` result is not iterable.
- `apps/single-workspace/test/blocked-workepisode-restart-wake.test.ts` has a
  30-second timeout followed by `EPERM` deleting its temporary test directory.
- `tests/p11-controlbasis.test.ts` reports `ExecutionDriverOperationalFailure`
  from `PersistenceCorruption`; P12 transport/story assertions and P38 schema
  boundary expectations also fail independently of the P39-coded group.

## Test side effects and scope

The full run changed only the generated timestamp/hash fields in
`planning/results/P12.restore-drill.json`; these two fields were restored to
their exact pre-run HEAD values. The P39 writer test left one untracked root
sidecar, `.arbor-p39-writer-650dffe795249f18518b610197aee7e4be03ac33c51c5534dae26d499e2ea7aa.sqlite`;
after confirming the test process had exited and the file was untracked,
non-ignored, a single regular file in this worktree root, it was removed with a
literal path. No production data, migration state, live service, or deployment
was changed. No automatic retry or second full check was run.
