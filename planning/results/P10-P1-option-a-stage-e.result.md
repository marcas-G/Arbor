# P10 → P1 Option A — Stage E Result

Status: **OPEN — blocked by CandidateRead pre-intent bootstrap Design Gap**

## Evidence

On the isolated Option A implementation worktree, the focused Windows
functional reproduction uses a fresh schema-50 SQLite database, the public
`workspace-detail` CandidateRead, the production V3 source/high-water writer
and the D2 signed-manifest verifier. It does not call
`buildSandboxPolicyCandidateReadV2` directly and does not invoke a provider or
native helper.

The tested public sequence is:

1. A first executable shell Action is persisted by P3. P4 commits its exact
   NotAdmitted ToolInvocation/RecoveryBinding before the policy gate.
2. The test obtains the candidate from public `workspace-detail`, then commits
   P1 `OsEnforced` with the selected exact Supported tuple
   `windows-restricted-appcontainer-job / t3d-v1 / capabilityRevision 4`.
3. After process restart and live-lease expiry, P4 resumes the same invocation
   and binding. The production Windows provider remains Experimental; no
   provider/helper is run. The provider mismatch returns a typed
   `ProviderVersionMismatch` no-effect outcome.
4. P9 commits one fact, one P10 queue row and the wake event atomically. The
   P3 action is `TerminalRejected`, the Step is `StepEffectsCommitted`, and
   execution returns `RecoveryBlocked`.
5. No second P4 intent or second ProviderTurn occurs. The focused test checks
   one provider/model call and no new intent probe after a bounded scheduler
   interval.

P4/06 requires this P9 outcome to terminate the action/Step and states no
later action occurs. Therefore the requested same-Execution sequence
“first P1 candidate → legal first-action settlement → second ProviderTurn →
fresh-policy P4 intent → source/high-water drift and restart” cannot be
completed under the current candidate-read bootstrap. The implementation
stopped at the contract-required terminal P9 outcome; it did not manufacture a
successor or downgrade P9 to an ordinary ExpectedFailure.

The earlier P9 exact-decision rejection was an implementation defect, fixed
at `cf165fd5b8523d6d13e17c1cb2406b14914709fc`. P4 now keeps the current
decision's provider tuple in the P9 identity while preserving actual probe
evidence and `ProviderVersionMismatch` as the opaque failure code. This change
does not alter the P9 terminal contract.

The full second-action drift portion remains intentionally unqualified. The
governance draft
`planning/proposals/P10-P1-candidate-read-preintent-bootstrap-gap-draft.md`
recommends an action-bound pre-intent requirement producer and compares
proactive Workspace candidates and changing P9 continuation semantics. It is
not accepted and authorizes no implementation.
Canonical LF SHA-256 of the proposal at this checkpoint:
`77B7DDF7026D5CE81653CF2510E8F5A073394F50F2EB2D2899976A6F82B51164`.

## Verification

- `pnpm exec vitest run packages/tool-runtime/test/p4-pipeline.test.ts -t "mismatch unavailability"` — PASS, 2/2.
- `pnpm exec vitest run apps/single-workspace/test/scrc-executable-outcome.test.ts` — PASS, 17/17.
- `pnpm build` — PASS before production functional run.
- `pnpm typecheck` — PASS after test fixture typing correction.
- `pnpm architecture` — PASS, 193/193.
- Targeted Biome — PASS for P4/runtime and sandbox functional source files.
- `pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/sandbox-policy-v6-registry-drift-restart.functional.test.ts` — PASS, 1/1, 46.8 seconds; proves the pre-intent bootstrap/P9 terminal counterexample only, not V6-E drift closure.

No online DB was opened or upgraded. No provider was run. No T3 Supported
qualification claim is made. Stage E remains open pending manual governance
acceptance and landing of a pre-intent CandidateRead source contract.
