# Sandbox Policy Candidate Profile Binding Digest V6 — Slices A–C

Status: **V6 implementation slices A–C complete**. This is not V5/V6 feature
closure. The authorization, exact accepted addendum SHA, owner landing, and
independent post-landing review are recorded in
`planning/results/sandbox-policy-candidate-profile-binding-digest-v6-authorization.record.md`.

## Implemented

- Moved `sandboxHandleBindingDigest` from candidate common preconditions to
  each closed OsEnforced and TrustedLocal candidate. The domain codec requires
  the V6 shape and canonical key order, rejects legacy/malformed placements,
  and retains the `spc2_` candidate-ID preimage and accepted TrustedLocal ID
  golden unchanged.
- Updated Workspace Detail API/projection fixtures for the V6 shape and kept
  the candidate-read/singular-preconditions XOR guard.
- Added a read-only P11 `SandboxPolicyCandidateBoundaryReadPort`. One
  `TransactionScope` pins current Workspace/responsibility/boundary revisions,
  complete ownership rows including released claims, all Worktree rows, and
  one resolver observation over all boundary addresses. It requires exactly
  one exact active primary Worktree binding and proves its canonical key is
  present in the resolved set. When P11 alias collapse returns a same-path
  FileTree representative, the primary's GitWorktree kind is taken from the
  exact durable WorktreeStore binding, not inferred from that representative.
- Added trusted process host facts (`osFamily` from `process.platform` and
  `osBuild` from `os.release()`) to each effectful P5 current-bundle result.
  P10 filters only exact-host, Supported V2 registry tuples and exact broker
  rule-set digests; the read never calls `SandboxProcessPort.capabilities()` or
  probes a provider. The pure P10 projector calls the existing
  `produceSandboxBoundaryV1` independently for each offered profile using the
  same pinned P11 snapshot, derives one digest per candidate, collapses exact
  duplicates, fails conflicting mappings, sorts deterministically, and
  returns no partial candidate list on a producer/proof failure.
- Wired P10 production `ProjectionQueryPort` to load one effectful current V2
  bundle and trusted current-host facts for an exact pending P4 requirement, then
  re-read and join the requirement, current Execution/Episode/revision, P1
  decision/result and full P11 snapshot in one read transaction. Missing or
  changed proof, P5 failure, P11 failure, or producer failure is a typed read
  failure. No P3/P4 private-table reads, selection, P1 wire changes, schema, or
  migration were added.

## Verification

- Builds: `@arbor/domain`, `@arbor/ports`, `@arbor/persistence-sqlite`,
  `@arbor/projection-runtime`, `@arbor/api-contracts`,
  `@arbor/execution-runtime`, and
  `@arbor/single-workspace` — PASS.
- Targeted Domain, P11 boundary port, candidate projector, P10 API contract,
  P10 Workspace Detail and current-host tests — PASS, 52/52.
- P2 current-authority regressions — PASS, 13/13.
- Targeted Biome on all changed TypeScript files — PASS, no fixes required.
- `git diff --check` — PASS.
- No `docs/design/**` files changed.

## Remaining authorized DAG slices

V6-D P13/Web selected-candidate mapping and stale-reselection behavior,
V6-E updates to real SQLite dual-daemon restart qualification, and V6-F
broader V5/V6 focused/full gates and scope review remain. This result does not
claim P1 CAS qualification, Web behavior, dual-daemon evidence, provider
qualification, or overall V5/V6 closure.
