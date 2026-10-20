# Sandbox Policy Candidate Readmodel V6-E2 — Registry Drift Restart

Status: **Real public-flow registry-drift restart case PASS; the broader V6-E
crash/reapproval matrix remains open.**

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
    Issuer authorization checks still use issuer config identity and
    `config.issuers`; GrantPermission provenance, DecideSandboxPolicy authority,
    decision summary, current P1 preconditions, and candidate projection use
    the validated V2 operator identity. Regression fixtures pin issuer revision
    4/digest A separately from operator revision 9/digest F. No command wire or
    schema/DDL changes; no V1 fallback.
  - `DecideSandboxPolicy` preparation still requires authority to match the
    current validated V2 snapshot, but no longer operational-fails on caller
    expected-field mismatch. Current P1 preconditions now produce durable
    `StaleSandboxPolicyInputs` receipts for stale bundle/operator/handle CAS.

## Verification

- Real SQLite schema-50 public-flow functional process case:
  `sandbox-policy-v6-registry-drift-restart.functional.test.ts` — PASS, 1/1 on
  two consecutive runs after the bridge (about 62s and 62s). The first attempt
  after the bridge transiently timed out waiting for executable approval; a
  subsequent run passed and the sanitized diagnostics remained available. No
  provider process call is claimed.
- P1 schema-50 atomic/Gateway suite with stale V2 CAS cases — PASS, 6/6.
- P1/P5/P10 authority, preparation, projection and grant regressions — PASS,
  25/25; the P4 pipeline is PASS, 82/82 on two runs.
- V2 registry-only drift source codec test — PASS, 1/1.
- P3/P4/P39 pending-action fixture test — PASS, 1/1 before the existing
  Workspace adapter was added; the functional process case also passes that
  existing-Workspace fixture path and P11 readback.
- `pnpm build` passes. `pnpm typecheck` passes after correcting E1 test helper
  package-module imports and typed IDs/state. Full `pnpm check` reached core
  batch 6 and stopped on six baseline cases: five fixtures still start at
  `user_version 48` despite the schema-50 offline-upgrade gate, and one AH7 P39
  fact-failure fixture reaches the newly-required sandbox-policy interruption
  before its asserted OutcomeUnknown settlement. The five fixture repairs and
  the AH7 valid-policy setup are being handled on the unified line; none of
  those baseline cases were changed here. The earlier P41/P42 suffix issue was
  fixed by unified commit `05b593eb` and no longer fails. Biome and
  `git diff --check` passed before the most recent P1 test additions; rerun
  before commit.

## Remaining V6-E qualification

- Fresh-candidate reapproval after the stale receipt and P1 commit-before/after
  process-kill/restart join are not yet qualified.
- The requested follow-on sequence (commit a fresh OsEnforced policy, create a
  second P4 intent, then drift/restart) remains OPEN under a confirmed design
  gap: the current P1 payload cannot distinguish multiple Supported versions
  of the same provider/candidate tuple. No version or candidate identity may be
  guessed, and no production P1 OS selector is being added until the fixed
  governance proposal is accepted. No OS provider run is claimed.
- V6-F broader gates, two-daemon successor convergence, and overall V5/V6
  closure remain open.

## Real public-flow V6-E qualification (2026-10-20)

The earlier process case used the manually seeded Pending Action/invocation
fixture. It is retained as a narrow store diagnostic, not E2 evidence. The
replacement journey uses public
CreateProject/GrantPermission/Work admission and a deterministic provider
`shell` ToolCall with the same platform-specific `printf` / `Add-Content`
command used by the existing P4 live-lease process qualification. It then
pauses at `AH7AfterToolIntentCommit`.

The replacement journey proves public CreateProject/GrantPermission/Work
admission, a real provider shell ToolCall, P4 intent and verified recovery
binding, then P1 TrustedLocal decision at V2 bundle revision 1. It changes only
the provider registry and bundle revisions, kills daemon 1, and restarts daemon
2 against the same schema-50 SQLite file and protected source. Before
reapproval, P2 parks the same Pending action with unchanged invocation and
RecoveryBinding; the P10 candidate read refreshes, stale old P1 payload is
rejected without writes, and no sandbox provider run is claimed. This closes
the previously observed lazy P4 intent-ordering RED for this flow.

The first attempt after the operator bridge timed out while waiting for
executable approval and showed the original HumanConversation unconsumed. The
next two complete runs passed (1/1 each); do not suppress the first timeout.
Remaining: fresh-candidate reapproval, P1 pre-/post-commit kill/restart join,
successor convergence and an OsEnforced deterministic Supported-candidate
case; V6-F and overall V5/V6 closure remain open.
