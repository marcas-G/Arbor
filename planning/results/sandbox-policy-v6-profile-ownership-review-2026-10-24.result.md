# V6 Fresh Profile Ownership Review — 2026-10-24

Status: **E50 PROFILE FIX REVIEWED; FRESH POST-INTENT CANDIDATEREAD PATH CORRECTED; FULL PROCESS REQUALIFICATION NOT RUN**

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
  full file was not rerun under the one-run limit.
- Focused typecheck after this correction reports only the unrelated
  `organization.functional.test.ts:740` missing `ProductionFixture.httpPort`
  member; no V6 or fixture-support type errors remain. Targeted Biome passes,
  and the two oracle unit cases pass (2/2; process case filtered).
