# V6 Fresh Profile Ownership Review — 2026-10-24

Status: **E50 PROFILE FIX REVIEWED; SCHEMA-51 SQL MICROTEST PASS; FINAL SYNTHETIC PROCESS QUALIFICATION FAILED AT FRESH P4 RESUMPTION; P4 ROOT CAUSE NOT DIAGNOSABLE FROM RETAINED ARTIFACTS**

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
- The one authorized post-review full-file run followed successful root and Web
  builds. It used retry 0 / one worker and ended **3 passed, 1 failed**: both
  P9 oracle tests and the schema-51 query microtest passed; the process case
  failed while waiting for fresh P4 settlement. Its last captured exact
  invocation probe was `SandboxPolicyRequiredInterruption`; the adjacent
  SQLite source snapshot showed the same invocation `NotAdmitted` / `Bound`,
  unsettled, with no observation, its Action `Pending`, and its Step
  `ActionsInProgress`. The public fresh `DecideSandboxPolicy` receipt had
  already matched `Committed`; the fresh payload was built from the post-restart
  public CandidateRead. This is not an `ExpectedFailure`, P9 terminal result,
  or OS-supported-provider qualification.
- The run's failure-evidence archive also failed: the direct Vitest invocation
  supplied `.test-results/2026-10-24-v6-schema51-final` before creating that
  directory. `archiveProductionFixtureFailure` requires a real existing direct
  `.test-results` child and threw `ENOENT` at its `lstat`; suite teardown then
  removed the temporary fixture root. The retained
  `.test-results/2026-10-24-v6-schema51-final/vitest.json` records the terminal
  probe/source and both errors (SHA-256
  `a141514fa05f9dc32d6f52362af6feff23470e51331d326f2445eb79ad074310`), but no
  database/WAL/workspace for this run remains. The unrelated 2026-10-23
  temporary fixture was not substituted. The Vitest process and matching
  daemon process tree are terminal; no matching process remains.
- The archive-hook cause is diagnosed and fixed in test infrastructure:
  `validateResultDirectory` now creates a missing, lexically validated direct
  child after validating the real `.test-results` root; a test-local regression
  archives a disposable fixture into a missing destination and checks the
  archive contents. However, the missing DB means the fresh persisted P1 row,
  episode binding, effective summary/digest, and current CandidateRead cannot
  be compared after commit. Therefore why P4 remained parked is **NOT
  DIAGNOSABLE** from this run. The evidence does not distinguish a failure to
  rematerialize the committed policy from failure to reschedule the exact
  pending action; the captured P4 probe may also predate the fresh P1 commit
  because the test selects the first exact-invocation probe. No production
  defect or test-only cause is asserted for that P4 gap.
- The earlier wrong-column failure and obsolete EAP-oracle failure remain
  separately classified harness/oracle issues, not evidence of a production
  defect. No further process run was performed.
- Post-fix lightweight verification: the V6 P9 exact-Step oracles, the missing
  archive-directory regression, and the current-schema SQL microtest pass
  together (**4 passed, 1 process case skipped**); the microtest creates schema
  51 through the current-schema test helper, prepares all 44 static queries,
  and does not start a daemon. Targeted Biome and `git diff --check` pass.
  `pnpm exec tsc -p tsconfig.test.json --noEmit` reports only the
  pre-existing unrelated `organization.functional.test.ts:740` missing
  `ProductionFixture.httpPort` member; no V6 or helper errors are reported.
- Focused typecheck after this correction reports only the unrelated
  `organization.functional.test.ts:740` missing `ProductionFixture.httpPort`
  member; no V6 or fixture-support type errors remain. Targeted Biome passes,
  and the two oracle unit cases pass (2/2; process case filtered).
