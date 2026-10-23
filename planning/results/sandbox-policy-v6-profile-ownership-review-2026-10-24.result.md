# V6 Fresh Profile Ownership Review — 2026-10-24

Status: **E50 PROFILE FIX REVIEWED; P1 CURRENT DECISION DURABLE; FINAL P4 REPLAY FAILED CLOSED ON RECOVERY-BINDING MISMATCH AFTER EXACT P1 GRANT; DESIGN/IMPLEMENTATION DISPOSITION REQUIRED**

## E50 fixture review

The fresh Project now gets a distinct host Profile root. The test creates and
initializes that directory, restarts the daemon with it as the
`ARBOR_PROJECT_ROOT` Profile source, then creates the Project through the
public `CreateProject` command. Production `CreateProject` resolves the
selected Profile to its trusted canonical `FileTree` address and writes the
normal Pending resource-activation intent. The awaited post-commit composition
calls `activateCommittedProjectResource`, which uses the existing
`OwnershipWriteService` path to resolve and claim that exact address. A
read-only assertion checks that one active filesystem ownership claim exists
for the new Workspace and its source address is the fresh Profile root.

The test then inserts the primary GitWorktree at the exact same root path.
This changes the resource address kind to `GitWorktree` while keeping the
same canonical directory; it does not add a nested path or widen the boundary.
P4 still runs its normal ResourceAdmission gate. The post-drift daemon restart
uses the same Profile root so P5/P4 environment resolution remains stable.

The fake provider now stops repeating shell after a prior exact
`[Denied] tool denied:` result. That branch returns a text response and cannot
produce an EAP or pass the test. The transcript diagnostic includes its
required positive `limit` so `responseStatus` is captured when available.

The one full-file run after the Profile-root change reached the fresh Work but
still timed out waiting for an Executable approval. Its archived database
showed a Pending shell Action and one exact `NotAdmitted` ToolInvocation with
`RecoveryBinding=Bound`, but no executable-approval row. This is the accepted
post-intent P10/P1 source: `GrantPermission(shell:exec)` authorized the tool,
so the P4 handoff persisted its NotAdmitted intent without creating an EAP.
The accepted contract explicitly exposes CandidateRead from either that
post-intent source or the pre-intent Pending Action plus EAP source. The test
now waits on public Workspace Detail CandidateRead and uses SQL only to
cross-check the exact NotAdmitted/Bound invocation and its current Action/Step
source. An empty EAP table is expected and does not skip P1; the separate exact
`DecideSandboxPolicy` permission and fresh P1 decision remain required. After
that commit the same P4 invocation is expected to resume and return the
synthetic provider's no-effect `ProviderVersionMismatch`; this makes no real
OS provider claim. The public CandidateRead, its exact tuple and common
preconditions remain the submitted authority; SQL does not construct or
replace the candidate DTO.

No production/design contract changed. This is fixture setup and diagnostic
logic only. The earlier run's synthetic D2 evidence remains no claim about a
real or `OSSupported` provider. P39 canonical digest qualification remains
outside this review.

## Checks

- Targeted Biome for the production-fixture support and V6 process test: PASS.
- `git diff --check`: PASS.
- Two exact-Step P9 oracle unit tests: PASS, 2/2; the process case was filtered
  and did not start a daemon.
- `pnpm exec tsc -p tsconfig.test.json --noEmit`: only the unrelated existing
  `tests/functional/process/organization.functional.test.ts:740` error remains
  (`ProductionFixture.httpPort` is absent). No type errors were reported in
  the V6 test or the changed fixture support.
- Full-file run after the Profile-root change: **2 oracle tests passed; process
  case failed at the obsolete `waitForExecutableApproval` expectation**. The
  archived evidence supersedes the earlier nested-root diagnosis: the fresh
  Workspace had an active ownership claim at its exact new Profile root; P4
  created the NotAdmitted/Bound post-intent source and no EAP by design.
- After changing the process case to use public post-intent CandidateRead, the
  authorized full-file attempt ran once with retry 0 / one worker. It ended
  with Vitest terminal status **1 failed process case, 2 passed P9 oracle
  cases** (3 total). The process advanced through restart, stale P1 rejection,
  and reached the fresh CandidateRead diagnostic snapshot, where the test
  queried nonexistent `executions.episode_binding_json`. This is a test-local
  schema mismatch, not a production runtime failure. Evidence is retained at
  `.test-results/2026-10-24T01-10-v6-fresh-postintent-final/`, including the
  archived fixture database; the failed fixture itself remains available.
- Current schema inspection confirmed P25 `executions` stores
  `episode_kind`/`episode_ref`/`episode_revision`; P26 stores the serialized
  exact episode identity in `agent_execution_state.episode_json`. The query
  now reads those actual columns and checks both serialized and decomposed
  WorkEpisode identity against the public CandidateRead binding.
- A prepare-once audit against the retained schema-version-51 database covered
  all 30 diagnostic SQL statements in this V6 process test and all 13 in its
  `ah-durable-snapshot.ts` helper: **43/43 prepared, 0 invalid columns or
  aliases** after the fix. The test-local schema-version assertion adds one
  static `PRAGMA user_version` query, so the current microtest prepares 44
  statements total. It includes a schema microtest that
  uses `createCurrentSchemaTestDatabase`, asserts `PRAGMA user_version` equals
  `CURRENT_SCHEMA_VERSION` (51), then prepares this source-listed query set.
  This uses the production migration chain and does not start a daemon.
  Independent review caught that the first microtest draft used a historical
  schema-50 clone; that draft was replaced before any process rerun.
- The accepted fresh-decision assertions also compare the persisted effective
  summary tuple and policy digest against the refreshed public CandidateRead,
  including bundle revision/digest, provider registry revision/digest,
  provider version, capability revision, handle binding, profile and network
  policy. The canonical P39 digest qualification remains out of scope.
- The first post-review full-file attempt (schema query fixed, archive helper
  still requiring a pre-existing result directory) ended **2 P9 oracle tests
  passed, process case failed**. It is retained as intermediate evidence at
  `.test-results/2026-10-24-v6-schema51-final/vitest.json`; its archive failed
  with `ENOENT` and its fixture was removed by suite teardown. That archive
  infrastructure failure is fixed below; this intermediate artifact is not
  used to diagnose the final P4 result.
- The final authorized full-file run followed successful root/Web builds and
  used retry 0 / one worker. The fresh-phase tick was set to 25 ms; the
  post-P1 waiter required a newly observed exact-Execution predispatch, and its
  original 45-second bound was unchanged. The run ended **5 passed, 1 failed**
  (three P9/selector oracles, private-ACL archive regression, and schema-51 SQL
  microtest passed). The process case observed a post-P1 scheduler dispatch,
  then failed closed at the exact P4 recovery-binding replay with
  `ToolRuntimeOperationalFailure` / `RecoveryBindingReplayMismatch`.
  Fixture/DB/WAL are retained at
  `.test-results/2026-10-24-v6-postdecision-tick25-final/sandbox-policy-v6-fresh-work-ed139e45-b9c1-41c5-a31c-73cf4ab70b06/`;
  Vitest JSON SHA-256 is
  `2e2217b7ada415f3b3261522991d944cd4c254c48890621dda4d91fe0b7210a2` and DB
  SHA-256 is `d3b3558b0c720a49d2bac916a3cc535a0afe4ac91350b9445a243339bb207e16`.
- Read-only comparison confirms fresh P1 is current, not a stale CandidateRead
  payload or policy-digest mismatch. The committed P1 row is policy revision 1
  for the exact WorkEpisode binding stored in `executions` and
  `agent_execution_state.episode_json`; the command receipt is `Committed`.
  Recomputing `encodeEffectivePolicySummaryV1` yields the exact persisted
  `policy_digest`. The effective tuple is ReadOnly /
  `windows-restricted-appcontainer-job` / `t3d-v1` / capability revision 4;
  provider-registry revision 2 / digest `26e14c69…` and bundle revision 2 /
  digest `55e84bca…` match the archived current source and high-water. The test
  built the P1 payload from the public post-restart CandidateRead and checked
  its updated revisions/digests and unchanged profile before commit.
- The retained DB shows the NotAdmitted shell invocation remained Bound to the
  same invocation, ProviderTurn, Action and callRef. Its original immutable
  `authoritySourceRevision` and `permissionGrantRevisions` contain only the
  shell `shell:exec` grant. The fresh P1 command added a separate exact-target
  `DecideSandboxPolicy` grant; the current project's active grant set now
  contains both. On post-P1 replay, P4 emits the same exact action but
  `makeRecoveryBindingV1` recomputes `authoritySourceRevision` from the expanded
  active-grant set, so the new canonical binding no longer equals the
  immutable P3 RecoveryBinding and P4 reports `RecoveryBindingReplayMismatch`.
  Concretely, the bound source lists shell grant
  `pgr_99edf2a9-001a-735b-809a-b30bb0317a05`; the later P1 grant is
  `pgr_98c787ee-310c-77d5-8ef8-100bb45f23c5`, capability `DecideSandboxPolicy`,
  targeted to the exact fresh Execution. Its inclusion in the current active
  grant snapshot changes the binding even though the shell grant's revision
  remains unchanged.
  The invocation remains NotAdmitted/Bound and unsettled, with no observation;
  the Action is `TerminalRejected` and Step `SettlementProposed`. No sandbox
  effect or P9 provider-unavailable fact was produced.
- This is not the earlier 60-second scheduler timing issue: the 25-ms run
  proves a post-P1 predispatch and exact P4 replay. The remaining conflict is
  whether RecoveryBinding should treat a newly committed, non-shell
  `DecideSandboxPolicy` grant as changing the shell invocation's authority
  source. The current evidence localizes the failure to that immutable-source
  comparison; it does not establish whether the intended resolution is an
  implementation correction or a manually governed contract clarification.
  No production or design changes were made. The original independent P9
  terminal proof remains intact; this fresh invocation did not reach a P9
  terminal result. No OS-supported-provider qualification is claimed.
- The archive-hook cause is diagnosed and fixed in test infrastructure:
  `validateResultDirectory` creates a missing, lexically validated direct child
  after validating the real `.test-results` root and immediately applies the
  P39 private ACL. A test-local regression verifies only current SID/SYSTEM/
  Administrators FullControl ACEs on the protected directory and inherited
  private ACL on archive-skipped JSON; non-Windows verifies 0700/0600 modes.
- The earlier wrong-column failure and obsolete EAP-oracle failure remain
  separately classified harness/oracle issues, not evidence of a production
  defect. No further process run was performed.
- Post-fix lightweight verification: the V6 P9 exact-Step oracles, fresh-P4
  selector oracle, missing private-ACL archive-directory regression, and
  current-schema SQL microtest pass together (**5 passed, 1 process case
  skipped**); the microtest
  creates schema 51 through the current-schema test helper, prepares all 44
  static queries, and does not start a daemon. Targeted Biome and
  `git diff --check` pass.
  `pnpm exec tsc -p tsconfig.test.json --noEmit` reports only the
  pre-existing unrelated `organization.functional.test.ts:740` missing
  `ProductionFixture.httpPort` member; no V6 or helper errors are reported.
- Focused typecheck after this correction reports only the unrelated
  `organization.functional.test.ts:740` missing `ProductionFixture.httpPort`
  member; no V6 or fixture-support type errors remain. Targeted Biome passes,
  and the two oracle unit cases pass (2/2; process case filtered).
