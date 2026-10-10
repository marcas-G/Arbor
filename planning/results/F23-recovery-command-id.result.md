# F23 recovery CommandId repair

## Scope

Worktree: `C:\Users\ThinkPad\.codex\worktrees\f23-recovery-command-id\Arbor`

Baseline: `106f4bbad9539f88557fdc8211e79086ef4585bc`, clean before edits.
This change is limited to `packages/execution-runtime/src/recovery.ts`, the
dedicated `tests/recovery-command-id.test.ts`, and this result record. No design
documents, other recovery tests, fixture-migration worktree, or shared tree were
changed.

Recovery now derives `SettleExecution` CommandIds as
`cmd_${newUuid7("recovery", "${executionId}:${branch}")}`, where branch is
`completion` or `stop`, then decodes the result through the Domain `CommandId`
schema. This uses the existing SHA-256-based deterministic UUIDv7 helper: the
identity depends only on exact ExecutionId and deterministic recovery branch,
not wall time, randomness, or worker/fencing generation. The two branch labels
produce distinct IDs for the same execution. Existing authority, fencing,
payload and fingerprint logic were left unchanged.

## RED / verification

- Before the production change, the focused test failed at the Domain CommandId
  decoder with `expected cmd_<uuid-v7>` after it triggered each existing
  deterministic branch using a valid UUIDv7 ExecutionId.
- After the change, `pnpm test -- tests/recovery-command-id.test.ts`: PASS,
  1 file / 1 test. It asserts the actual persisted IDs equal the deterministic
  derivation for both branches, are valid UUIDv7 CommandIds, and differ between
  branches for the same ExecutionId.
- The test replays each exact SettleExecution envelope through the Gateway with
  the same CommandId and semantic fingerprint. The stored receipt row is
  unchanged and the event count does not increase; the subsequent recovery pass
  adds no receipt/event.
- `pnpm typecheck`: PASS.
- `pnpm build`: PASS (`tsc -b`).
- Biome on the two implementation/test files: PASS; `git diff --check`: PASS.
- Full `pnpm check` and functional suite were not run.

## Boundary / remaining work

This is only evidence for valid deterministic recovery command identity and
same-request receipt replay. It does **not** claim to fix or green the nine
existing P9 recovery RED tests: their fixtures primarily use malformed
ExecutionIds and were not modified or run here. Any fixture repair or further
recovery behavior remains separate work.

## Shared core fixture follow-up

After the recovery CommandId change was integrated with the core fixture
migration, two P9 tests still queried the retired literal forms
`cmd_recovery_completion_<ExecutionId>` / `cmd_recovery_settle_<ExecutionId>`.
Their assertions now derive the exact expected `CommandId` with the exported
stable `newUuid7("recovery", "<ExecutionId>:<branch>")` helper, pass it through
the Domain `CommandId` parser, and retain the existing one-row receipt and
second-recovery no-duplicate assertions. The completion recovery tests also
assert the seeded fact plus exactly one `ExecutionSettled` event.

Verification after this fixture-only follow-up:

- `tests/p9-acceptance.test.ts` + `tests/p9-recovery-driver.test.ts` — PASS,
  2 files / 15 tests.
- Core targeted matrix — PASS, 18 files / 76 tests.
- P12/app targeted matrix — PASS, 21 files / 172 passed / 2 skipped.
