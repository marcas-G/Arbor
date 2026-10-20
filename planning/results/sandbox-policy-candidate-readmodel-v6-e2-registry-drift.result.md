# Sandbox Policy Candidate Readmodel V6-E2 — Registry Drift Restart

Status: **Original fixture process case passes but is not accepted E2 evidence;
real P3/P4 E2 remains open.**

## Implemented

- Added a test-only, private V2 source/high-water pair writer and source-aware
  daemon child. The child injects the file-backed source into the ordinary
  single-workspace `main` composition; it does not replace P5 validation or P2
  scheduling. Source reads still pass through the production V2 codec and
  high-water loader.
- Extended the schema-50 disposable fixture to reuse a Workspace created
  through the production `CreateProject` Gateway, then use production P3/P4/P39
  stores for one current Pending executable Action, NotAdmitted invocation and
  verified RecoveryBinding. The production P11 boundary readback proves one
  active primary Worktree.
- Added a process test that commits a valid TrustedLocal policy under V2 bundle
  revision 1, changes only the provider registry and bundle revisions, kills
  daemon 1 and restarts daemon 2 against the same SQLite file and current V2
  source. Before reapproval, P2 leaves lease absent; Pending action, step
  cursor, NotAdmitted invocation and RecoveryBinding are unchanged; provider
  calls are zero. P10 returns refreshed authority common preconditions.
- Submitting the pre-drift candidate through the existing P1 Gateway returns
  terminal `StaleSandboxPolicyInputs`. The stale request creates no additional
  policy decision or decision event.
- Fixed two implementation bridges required by the real process flow:
  - Added an explicit internal `SandboxPolicyAuthoritySnapshotV2` carrying
    issuer config identity separately from operator config revision/digest.
    `DecideSandboxPolicy` uses the validated V2 operator fields; GrantPermission
    issuer provenance continues to use issuer config fields. No command wire or
    schema/DDL changes.
  - `DecideSandboxPolicy` preparation still requires authority to match the
    current validated V2 snapshot, but no longer operational-fails on caller
    expected-field mismatch. Current P1 preconditions now produce durable
    `StaleSandboxPolicyInputs` receipts for stale bundle/operator/handle CAS.

## Verification

- Real SQLite schema-50 functional process case:
  `sandbox-policy-v6-registry-drift-restart.functional.test.ts` — PASS, 1/1.
- P1 schema-50 atomic/Gateway suite with stale V2 CAS cases — PASS, 6/6.
- V2 registry-only drift source codec test — PASS, 1/1.
- P3/P4/P39 pending-action fixture test — PASS, 1/1 before the existing
  Workspace adapter was added; the functional process case also passes that
  existing-Workspace fixture path and P11 readback.
- `@arbor/domain`, `@arbor/application`, and `@arbor/single-workspace` builds
  pass; Biome and `git diff --check` pass.

## Remaining V6-E qualification

- Fresh-candidate reapproval after the stale receipt and P1 commit-before/after
  process-kill/restart join are not yet qualified.
- No OsEnforced candidate was available in the local registry fixture; no OS
  provider run is claimed.
- V6-F broader gates, two-daemon successor convergence, and overall V5/V6
  closure remain open.

## Real public-flow RED diagnostic (2026-10-20)

The earlier process case used the manually seeded Pending Action/invocation
fixture. It is retained as a narrow store/process diagnostic, but it does not
qualify E2's production P3→P4 path. The replacement journey uses public
CreateProject/GrantPermission/Work admission and a deterministic provider
`shell` ToolCall with the same platform-specific `printf` / `Add-Content`
command used by the existing P4 live-lease process qualification. It then
pauses at `AH7AfterToolIntentCommit`.

Current RED: the real run durably produces an `ActionsInProgress` AgentLoopStep
and one Pending executable `shell` Action, but there is no matching
`ToolInvocation`, no `AH7AfterToolIntentCommit` probe, and the daemon reports no
stderr failure. This isolates the runtime ordering issue: the policy gate
interrupts before P4 can persist its intent/recovery binding. The test now
prints this exact state on failure. It must remain RED until the accepted P4
intent-before-policy gate-order correction is integrated; it is not evidence
for a P4 settlement or V6-E process case.
