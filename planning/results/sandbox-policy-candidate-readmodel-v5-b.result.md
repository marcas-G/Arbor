# Sandbox Policy Candidate Read Model V5-B — P2 Gate

Status: P2 pre-dispatch stale-authority gate implemented; P10 candidate query
paused at a newly surfaced design gap. No `docs/design/**`, schema, migration,
or accepted candidate DTO changes were made.

## Implemented

- Added the neutral, effectful `CurrentSandboxAuthoritySnapshotPort` seam.
  `loadCurrentVerifiedV2()` re-reads and verifies the P5 protected source and
  high-water pair on each call; it does not capture a startup-only snapshot.
- Wired the production adapter and SQLite `SandboxPolicyRequirementReadPort`
  through single-workspace composition.
- Before lease acquisition or worker dispatch, P2 loads one current authority
  snapshot and, within one `TransactionScope`, checks the exact pending
  requirement and current joined P1 `{ decision, result }` pair. Missing,
  expired, mismatched, or full-bundle-stale policy returns the existing
  `RecoveryBlocked` outcome. Both policy variants compare full V2 bundle
  revision/digest; the registry-only drift case is not exempt for
  TrustedLocal. P4 remains the final effect-admission recheck.
- Added a regression with an unexpired TrustedLocal result whose bundle is
  stale after a registry-only bundle revision. It proves P2 parks before lease
  acquisition and before dispatch/driver invocation.
- Strengthened the P2 fixture with the strict production
  `SandboxPolicyDecisionCommittedInternalV1` encoder/decoder, exact
  `TrustedLocalUnconfinedV1` selection/provider/runtime literals, and the full
  episode-binding schema (`P38_MIGRATIONS`). The adjacent exact-bundle match
  case proves one dispatch/driver invocation; the registry-only drift case
  proves zero. A no-requirement case verifies P5 is not read/audited.

## Verification

- `pnpm --filter @arbor/ports build` — PASS
- `pnpm --filter @arbor/execution-runtime build` — PASS
- `pnpm --filter @arbor/single-workspace build` — PASS
- `pnpm exec vitest run tests/p2-driver.test.ts` — PASS, 11/11
- Targeted Biome check and `git diff --check` — PASS

## P10 design-gap counterexample

P10 candidate query implementation is intentionally not started. The accepted
`SandboxPolicyCandidateCommonPreconditionsV1` requires one
`sandboxHandleBindingDigest`, including for an initial decision with no
committed effective-policy snapshot. The only candidate-read P4 requirement
contains `recoveryBindingDigest`, which binds recovery evidence and is not a
sandbox handle-binding digest. The current Workspace Detail query has no
resolved P11 regions, ownership claims, or exact primary-worktree inputs with
which to call `produceSandboxBoundaryV1` and derive the latter.

Counterexample: an initial requirement must offer ReadOnly, WorkspaceWrite,
and TrustedLocal FullAccess choices, whose distinct access profiles produce
different handle-binding digests. The accepted DTO has one common digest and
no per-candidate digest, while no already-committed summary exists to supply a
value. Substituting the RecoveryBinding digest or choosing one candidate's
digest would be invented semantics and could make the common P1 CAS stale or
misrepresent the selected boundary. Governance must decide the digest source
or revise the DTO/contract before P10 can return an initial candidate read.
