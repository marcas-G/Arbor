# F23 legacy core fixture migration

## Scope and disposition

Worktree: `C:\Users\ThinkPad\.codex\worktrees\f23-fixture-core\Arbor`

Baseline was `e372f8dd4e377654ab43a9bbf3f9f9bd6455bd47`, clean before edits.
This change updates test fixtures only; no production code, design contract,
transport, receipt store, or history decoder was changed.

Repeated P2/P6/P9 WorkspaceMain fixtures now bind to an exact `WorkEpisode`
instead of writing the retired `focus: Coordination`. P3 and P5 fixtures that
already carried an exact `WorkEpisode` now omit the contradictory legacy
`focus` field. Shared helpers in `tests/support/execution-episode-fixtures.ts`
seed a real Open Work/current-work binding where needed and provide a complete
`Yielded` settlement. Driver/recovery tests that only exercise execution
settlement use `Yielded`; this preserves their execution/lease assertions
without claiming Work completion. The P2 pure event-mapping assertion that
constructs a legacy Coordination binding remains unchanged as compatibility
coverage; it is not an admission or new-write fixture.

## Verification

- `pnpm build`: PASS.
- Focused P2/P6 regression (`p2-driver`, `p2-settle-execution`, `p6-acceptance`,
  `p6-critical-steer`, `p6-specialist-spawn`): 5 files / 18 tests PASS.
- Full targeted 18-file core set: 14 files passed; 67 tests passed and 9
  failed. The remaining failures are limited to:
  - `tests/p9-acceptance.test.ts`: Story A, Story B-clean, Story G (3).
  - `tests/p9-recovery-driver.test.ts`: B-2, T1, T2/T3 (3).
  - `tests/p9-recovery-visibility.test.ts`: I-2 (1).
  - `tests/p9-workflow-interruption.test.ts`: DF1, DF2 (2).
- `pnpm typecheck`: PASS (`tsc -b` and test project).
- Biome check on the 17 changed test/helper files: PASS.
- Full `pnpm check` and functional suite were not run, per task scope.

## Open blocker

The nine remaining red tests fail at `SettleExecution` with
`InternalCommandContractDefect` / `format`. Read-only inspection identifies a
runtime-generated invalid `CommandId` in
`packages/execution-runtime/src/recovery.ts`: completion and stop settlement
paths construct IDs as `cmd_recovery_completion_${executionId}` and
`cmd_recovery_settle_${executionId}`. The current ID decoder requires
`CommandId` values to be UUIDv7 (`packages/domain/src/ids.ts`). This is a
production/replay-identity issue, not a fixture-only failure. That file was
not edited: choosing a valid deterministic replacement requires separately
checking the durable command identity and replay contract. The nine tests are
therefore intentionally left red and must not be described as closed.

No other contract or production defect was established in this bounded
fixture pass.
