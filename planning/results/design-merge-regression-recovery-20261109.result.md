# Design Merge Regression Recovery

**Date:** 2026-11-09  
**Scope:** restore already accepted design contracts after an incorrect merge resolution  
**Semantic authority:** none added; this record does not accept or invent new product semantics

## Result

The frozen design chain is restored to:

- Problem & Goals v1.3
- Scenarios v1.10
- System Design v1.25
- Detailed Implementation Design v1.65

The recovery preserves the already accepted P36–P41 governance additions while
restoring later accepted owner-document revisions that were lost during branch
integration.

## Failure

Merge commit `1e2d94fa` combined:

- base `f80ee913`;
- mainline parent `5fd53089`, which already contained the latest accepted
  design chain through System Design v1.25 and DID v1.65;
- governance parent `52ea8a8e`, which carried accepted P36–P41 additions on an
  older System Design v1.16 / DID v1.42 document baseline.

For the content-conflicted design files, the merge result selected the older
governance-parent file bodies. That preserved P36–P41 text but discarded later
accepted design history and owner contracts. The resulting top-level versions
were inconsistent with Scenarios v1.10, the implementation and the governance
records already present in the repository.

## Recovery method

1. Use `5fd53089` as the current accepted mainline design baseline.
2. Replay the accepted governance commits in their original order:
   `51d30e06`, `46526d5e`, `357a345a`, `25cec337`, `ffd1b703`,
   `0f5b52b8`, `a8b4c071`, `5e5b1296`, `4ea41873`, `bb85d113`.
3. Retain the mainline side for overlapping clauses that already contained the
   same or later accepted semantics.
4. Retain additive P36–P41 clauses that were absent from the mainline file.
5. Compare the complete recovered `docs/design/**` tree against the replay
   candidate and require an exact match.

No historical proposal, acceptance record or result file was rewritten.

## Restored files

The incorrect merge had overwritten 23 files:

- `docs/design/02-system-design.md`
- `docs/design/03-detailed-implementation-design.md`
- `docs/design/implementation/P1/01-command-contracts.md`
- `docs/design/implementation/P1/04-sqlite-schema.md`
- `docs/design/implementation/P1/05-event-journal.md`
- `docs/design/implementation/P10/02-attention-readmodel.md`
- `docs/design/implementation/P10/05-surface-actions-transport.md`
- `docs/design/implementation/P12/02-authority-resolver.md`
- `docs/design/implementation/P12/10-transport-shells.md`
- `docs/design/implementation/P2/03-lease-fencing-model.md`
- `docs/design/implementation/P2/06-recovery-skeleton.md`
- `docs/design/implementation/P3/00-contract-index.md`
- `docs/design/implementation/P3/08-agent-loop-step-handoff.md`
- `docs/design/implementation/P4/01-tool-contracts.md`
- `docs/design/implementation/P4/02-tool-runtime-pipeline.md`
- `docs/design/implementation/P4/03-authority-permission-approval.md`
- `docs/design/implementation/P4/06-invocation-persistence-reconciliation.md`
- `docs/design/implementation/P4/08-minimal-tools.md`
- `docs/design/implementation/P6/02-communication-protocol.md`
- `docs/design/implementation/P6/06-acceptance.md`
- `docs/design/implementation/P9/00-contract-index.md`
- `docs/design/implementation/P9/02-fault-injection-matrix.md`
- `docs/design/implementation/P9/07-agent-loop-step-recovery.md`

## Frozen owner-document hashes after recovery

SHA-256 over the current LF file bytes:

- `docs/design/00-problem-goals.md`:
  `4726e775e9701102330191ad77222d405211cbc1e7f08b0e4b3dec3312f90c15`
- `docs/design/01-scenarios.md`:
  `c5818ed51996d249642a4a7246d9016dbbf4db3132506a60b8f301e94c77d53c`
- `docs/design/02-system-design.md`:
  `6b77f8ad0f77db1f0a45cf2b94557de4d213928dadc058954cef48724bf4f7a3`
- `docs/design/03-detailed-implementation-design.md`:
  `413f0d3aaf9e3f4762281bbd98b82a30309b6da1def2b004ff8cce4188f09cf5`

## Validation

- recovered `docs/design/**` exactly matched the independent replay candidate;
- no merge-conflict markers remained;
- `git diff --check -- docs/design` passed;
- `pnpm test:manifest` passed with 69 functional Vitest files and 6 functional
  UI files;
- `pnpm architecture` passed: 38 files / 197 tests;
- targeted schema-upgrade operator qualification passed: 19 tests, 6 skipped;
- full `pnpm check` completed with exit 0: Biome 1453 files, TypeScript,
  architecture 197 tests, all 479 core test files, Web production build and
  Web 34 files / 278 tests.

The Web build retained the existing non-blocking chunk-size warning; it is
tracked in `docs/KNOWN_PROBLEMS.md` as KP-008.
