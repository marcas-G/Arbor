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

P6 acceptance Story B seeds an Open/current Work owned by its actual parent
workspace (`CHILD_B_STORY`) and binds the synthetic execution to that exact
WorkEpisode. Its formation assertion compares against the post-seed Work count
and requires exactly one additional Work; it also checks that the parent Work
and formed child's initial Work have distinct IDs and their respective
workspace owners. This preserves the original “formation adds one Work”
behavior while avoiding a root Work masquerading as the child Work.

P9 recovery fixtures that previously used values such as `exe_p9_b2`,
`exe_sb_clean`, and `exe_p9_df1` now use UUIDv7 ExecutionIds. Session fixture
IDs derive from the UUID tail with the `ses_` prefix, with related SQL
assertions/reference values updated consistently.

One legacy exception remains intentionally visible in
`tests/p9-workflow-interruption.test.ts`: its P12 old-schema-13 raw database
fixture inserts `focus_kind = 'coordination'` directly into `executions`. This
is historical phase-schema state used by recovery/legacy migration coverage,
not a current `AdmitExecution` Gateway payload or new write. It should not be
read as evidence that P9 current writes still use Coordination focus.

## Verification

- `pnpm build`: PASS.
- Focused P2/P6 regression (`p2-driver`, `p2-settle-execution`, `p6-acceptance`,
  `p6-critical-steer`, `p6-specialist-spawn`): 5 files / 18 tests PASS.
- P6 Story B standalone: 1/1 PASS.
- Related P6 acceptance/critical-steer/specialist-spawn files: 3 files / 12
  tests PASS.
- Full targeted core command (18 files / 76 tests):

  ```powershell
  pnpm vitest run tests/p2-admit-execution.test.ts tests/p2-driver.test.ts tests/p2-recovery.test.ts tests/p2-recovery-matrix.test.ts tests/p2-settle-execution.test.ts tests/p2-stop-execution.test.ts tests/p3-integration.test.ts apps/single-workspace/test/p5-restart-continuity.test.ts tests/p6-acceptance.test.ts tests/p6-critical-steer.test.ts tests/p6-specialist-spawn.test.ts tests/p9-acceptance.test.ts tests/p9-lease-expiry.test.ts tests/p9-lease-renewal.test.ts tests/p9-recovery-driver.test.ts tests/p9-recovery-visibility.test.ts tests/p9-worker-crash.test.ts tests/p9-workflow-interruption.test.ts
  ```

  Result: 18 files / 76 tests PASS.
- `pnpm typecheck`: PASS (`tsc -b` and test project).
- Biome check on the 17 changed test/helper files: PASS.
- Full `pnpm check` and functional suite were not run, per task scope.

## Boundary / follow-up

The earlier nine P9 failures were fixture format defects, not a recovery
runtime regression. A direct decoder check on the old settlement payload
`{ executionId: "exe_p9_b2", settlement: Interrupted(StopRequested) }`
returns exactly `{ path: ["executionId"], rule: "format" }`; after replacing
the invalid fixture ExecutionIds, all 76 targeted tests pass.

Separately, `packages/execution-runtime/src/recovery.ts` still synthesizes
`CommandId` strings as `cmd_recovery_completion_${executionId}` and
`cmd_recovery_settle_${executionId}`. This was not the cause of the nine
fixture failures: internal ingress decodes command payloads, and the failure
path was the payload `executionId`. The generated CommandId/replay-identity
concern remains an independent audit/follow-up; no runtime or receipt code was
changed here.
