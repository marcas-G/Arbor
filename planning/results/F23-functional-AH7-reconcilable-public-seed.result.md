# F23 functional AH7 Reconcilable public Work seed

Date: 2026-10-10

Status: **targeted PASS, 3/3**. This is a test-fixture migration only; it does
not close AH7 or claim full functional qualification.

## Scope

Updated only
`tests/functional/process/agent-action-ah7-reconcilable.functional.test.ts`
so the three Reconcilable / NonIdempotent crash cases no longer create their
positive Work setup through the unsupported external `/commands` `AssignWork`
origin. No production code, design document, shared support helper, or other
test was changed.

The setup now uses public `SubmitHumanMessage`, waits for the exact CAPA Inbox
approval, approves that approval through public `ResolveControlApproval`, and
observes the same root Workspace's revision-0 Open Work. The ordinary daemon
then receives the Work and enters a public Manual wait; the test confirms the
Work is idle before crashing that daemon. It restarts the probe child, applies
public `SteerWork` against revision 0, and confirms the same Work advances to
revision 1 before the shell action is probed. The existing `shell:exec`
PermissionGrant remains unchanged.

The added Root seed creates its own legitimate control Action. Crash and
recovery assertions therefore select Actions and ToolInvocations by the
probe's exact Work `executionId`, and match the Action by the probe's exact
`callRef`; uniqueness is still required within that target Execution. This
keeps the public seed's Root action from being confused with the tested shell
Action without weakening the target assertions.

## Evidence

- Baseline RED: the three original cases all failed at setup with
  `/commands 403`, `UnsupportedOrigin:AssignWork`, before reaching a crash
  probe.
- The first migration attempt found and corrected a test-only trigger-marker
  collision (the Steer marker appeared in the Work objective). A subsequent
  run reached all three probes and exposed the old global `actions[0]`
  assumption after the legitimate Root seed Action was added; assertions now
  scope to the exact probed Work Execution.
- Final targeted run:
  `pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-action-ah7-reconcilable.functional.test.ts`
  — **1 file, 3/3 tests passed** in 118.39 seconds:
  - Reconcilable shell intent committed before executor entry;
  - Reconcilable shell effect before P4 settlement;
  - NonIdempotent shell effect before P4 settlement.
- `pnpm typecheck` passed.
- `pnpm exec biome check tests/functional/process/agent-action-ah7-reconcilable.functional.test.ts` passed after formatting the changed test.

The original target assertions remain: exact WorkEpisode and invocation /
logical-action / callRef identity, P4 Pending intent at crash, marker effect
absent before executor entry and exactly once when the effect had occurred,
restart to `ReconciliationPending` / `OutcomeUnknown` as appropriate, and
unchanged effect content with no replay. This run did not execute `pnpm check`,
the complete functional suite, or any other tests.
