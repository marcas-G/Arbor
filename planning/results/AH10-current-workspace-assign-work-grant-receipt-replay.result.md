# AH10 Current-Workspace AssignWork PermissionGrant Receipt Replay

Date: 2026-10-15

## First-failure evidence

Release run `.test-results/2026-10-15T12-54-32-691Z-22276` at
`04ab347aa2d8b7977173f792c12bced63898a39e` reported 127/128 functional tests
passing. Its sole failure was
`converges an old Committed AssignWork receipt after the action stays Pending`
in `agent-loop-ah10-assign-work-takeover.functional.test.ts`, timing out while
waiting for the target Action to become Applied.

The final snapshot showed:

- Execution `exe_05fd1b4f-5653-77a6-8715-f863ebe4a045`, generation 4, with
  `Interrupted / RuntimeSafetyStop` (`cmd_settle_exe_..._4`).
- Pinned action `assign_work` at provider turn
  `ptn_exe_05fd1b4f-5653-77a6-8715-f863ebe4a045_0`, logical action
  `lac_bcd5988174a89cddbd9233e8a776b8f44087002d5183d4678457fe815f074c76`,
  callRef `call_e8ad9b96e1024c2baab692873e0e3dea`, still `Pending` with no
  Observation.
- The effect was already committed exactly once: Command
  `cmd_b86b6353-fd60-7544-8b55-75b22f2b8b02`, Work
  `wrk_3d25358e-00f5-78b9-8542-c7dc5331bb15`, and one WorkAssigned event
  `c34907a5-ae27-4c6a-af27-a5e5ddbe8302`.
- The target ProviderTurn had one successful attempt. The test had already
  asserted its target action was requested once.

The test's seed helper creates an active, exact
`WorkspaceAgent(root) / core.control.assign-work / target=root Workspace`
PermissionGrant. The source Work separately uses a ControlApproval; the target
receipt itself has no corresponding consumed Approval. Recovery previously
treated every current-Workspace committed receipt as Approval-backed and
returned `RecoveryBlocked` if its exact Approval row was absent. Thus the
grant-authorized receipt could not reach the handler's existing generic
prior-receipt decoder. This is an adoption gap, not a missing provider result.

## Change

For a generation-takeover Committed current-Workspace receipt, the authorizer
now first requires the decoded result to name the current Workspace. If the
deterministic Approval row exists, the existing exact consumed-Approval path
is mandatory; any mismatch remains `RecoveryBlocked` and cannot fall back to a
grant. Only when that Approval row is absent may the authorizer inspect active
grants, requiring a currently valid exact target/capability grant with a
WorkspaceAgent or Execution subject, `validFrom`, and revision. It returns
complete PermissionGrant evidence under the explicit
`receipt-first:assign-work-current-workspace-grant` authority reference and
does not set either replay flag. The action handler therefore validates and
decodes the already-Committed receipt into the Observation without submitting
a new Command.

Grant evidence construction is shared with the ordinary current-workspace
authorization path and requires a nonnegative safe-integer Grant revision in
addition to the exact subject/capability/target and validity window. Malformed
revision values fail closed in both ordinary authorization and receipt replay.
No production command semantics, receipt contents, P9 fences, or
`docs/design/**` contracts changed.

## Verification

- Focused authorizer/handler and Command tests — PASS, 40/40 across five files:
  current receipt replay, raw direct-child fail-closed replay,
  generation-scoped AssignWork receipt handling, current Approval consumption,
  and direct-child target binding.
- `pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-loop-ah10-assign-work-takeover.functional.test.ts -t "converges an old Committed AssignWork receipt after the action stays Pending"` — PASS, three consecutive rounds: 44.107s, 24.708s, 24.657s.
- `pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-loop-ah10-assign-work-takeover.functional.test.ts` — PASS, 3/3: before-fence 54.144s, after-fence 53.904s, committed-receipt recovery 24.654s.
- `pnpm build` — PASS.
- `pnpm exec tsc -p tsconfig.test.json --noEmit` — PASS.
- Biome on the changed authorizer and test — PASS.
- B2 negative matrix in
  `ah10-current-workspace-assign-work-receipt-replay.test.ts` — PASS, 18/18.
  It covers expired/future grants; HumanPrincipal, foreign WorkspaceAgent, and
  foreign Execution subjects; wrong and wildcard capabilities; wrong target;
  missing, NaN, negative, and fractional revisions; Approval-row precedence;
  no-Approval/no-grant behavior; and exact Approval/PermissionGrant success
  paths. Every negative asserts `RecoveryBlocked`, zero pending Approval/Inbox
  writes, and no replay flags.
- `pnpm exec vitest run apps/single-workspace/test/ah10-current-workspace-assign-work-receipt-replay.test.ts` — PASS, 18/18.
- `pnpm exec tsc -p tsconfig.test.json --noEmit` — PASS after the B2 additions.
- Biome on the changed authorizer and test after the B2 additions — PASS.

The full functional suite was not rerun.
