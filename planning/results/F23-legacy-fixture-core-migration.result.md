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

## AH19 public Work-seed pre-header gate PoC

An isolated-tree AH19 Work-seed migration remains limited to
`tests/functional/process/ah19-provider-native-binding-recovery.functional.test.ts`
and its test-only support in `tests/functional/support/production-fixture.ts`.
The public route reaches RootConversation `assign_work`, exposes the exact CAPA
Inbox approval, commits public `ResolveControlApproval`, and makes the Work
visible as Open.

The generic production fixture now has an optional asynchronous
`beforeResponse` gate. It runs only after the provider has received the full
HTTP request body and before the fake writes any response headers or bytes;
returning `abort` destroys the held response without synthesizing a provider
response. The AH19 `AH17BeforeCheckpointEpochCommit` case waits for the first
Work provider request at this gate, verifies the Work is Open/current and the
active attempt contains only `TurnStarted`, all six replay-safety observation
facts are false, and there is no Native request, checkpoint, or action. It
then kills the ordinary daemon, aborts the old HTTP connection, and starts the
AH19 child. The child reaches the original `AH17BeforeCheckpointEpochCommit`
checkpoint boundary. This demonstrates a retryable, known-no-effect provider
attempt; it does not treat an unknown external effect as replay-safe.

Verification for this PoC: the targeted Vitest invocation for
`persists one real ProviderNative checkpoint at AH17BeforeCheckpointEpochCommit`
passed 1/1 (about 37 seconds; 35 other cases skipped). `pnpm typecheck` and
Biome on the two changed test files passed. Filtered follow-up cases passed
individually: public Work Session history 1/1, AH17After checkpoint commit
1/1, ordinary Native AH17After source-identity recovery after child restart
1/1, and ConversationCommon fail-closed negative control 1/1. The existing
checkpoint/hash/epoch/Provider-call assertions were retained; ConversationResponse
does not use the Work pre-header gate.

After the complete Work-seed gate rollout and persistent report-endpoint fix,
the full AH19 file passed in one Vitest run:

```powershell
pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/ah19-provider-native-binding-recovery.functional.test.ts
```

Result: 1 file, 36/36 tests passed in 3331.12 seconds. This qualifies the AH19
file only, not the full functional suite. `pnpm typecheck`, Biome on the two
changed test files, and `git diff --check` passed. Full `pnpm check` and
`pnpm test:functional` were not run.

The AH19 identity/manifest corruption `it.each` group had a previous
120-second bound. It alone is now 160 seconds; no other test timeout changed.
The analogous `compiledRequestHash` recovery case passed in 129.366 seconds
with its existing 180-second bound, providing the measured budget basis. In
the full-file run, the five identity-corruption fields passed in 127.384,
127.478, 129.859, 129.218, and 128.437 seconds. No production Provider/model
timeout, business wait, or assertion was changed.

The first full-file attempt after introducing the gate was stopped after
repeated timeout failures showed the same missing-report-endpoint child setup
error on later restarts. After putting the report URL in the persistent base
daemon environment for each AH19 fixture, the single full-file run above passed.

The earlier HTTP 500 attempt remains rejected evidence, not the successful
path: its persisted snapshot showed Work Execution `Failed`, ProviderAttempt
`TerminalFailure`/`ProviderUnavailable`, and `responseStarted = true`, so it
was not a retryable seed under P9 and was not used for this PoC.

The initial target-tree attempt also found the ignored `apps/web/dist` missing;
the test fixture's readiness probe GET `/` returns 503 when that static dist
is absent. Building the Web dist removed that readiness issue. In a separate
earlier setup, switching to the AH19 child while CAPA was still pending, then
approving publicly, returned Committed but left `current-work` null for the
bounded observation window. That remains unexplained test-child/recovery
evidence, not a production-bug conclusion; the AH19 child is specialized for
Native Work traces and does not implement the RootConversation `assign_work`
seed response. The filtered ordinary Native restart initially exposed a test
child setup omission: a later child restart lacked `ARBOR_AH19_REPORT_URL`;
the database already had a valid Native checkpoint and source successor, and
the child log said `AH19 report endpoint required`. AH19 fixtures now keep the
report URL in their persistent base daemon environment across child restarts.
All public Work seed call sites use the
same pre-header hold/kill/abort before AH19 child takeover; no 500 is treated as
replayable. No direct internal command, DDL Work seed, assertion weakening, or
production change was used. The complete AH19 file passed as stated above; it
does not claim the full functional suite passed.
