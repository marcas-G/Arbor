# V6 Fresh Profile Ownership Review — 2026-10-24

Status: **E50 PROFILE FIX REVIEWED; FULL PROCESS REQUALIFICATION NOT RUN**

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
- Full V6 process test after the Profile-root correction: **NOT RUN** (the
  single full-file run allocated for this review was already consumed by the
  preceding diagnostic run).
