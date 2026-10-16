# AH19 Work pre-checkpoint bounded frontier — acceptance and landing

Status: **Accepted design package landed; implementation and qualification not authorized.**

- Acceptance token: `ACCEPT_AH19_WORK_PRECHECKPOINT_BOUNDED_FRONTIER_V1`.
- Accepted proposal: `planning/proposals/AH19-work-precheckpoint-bounded-frontier-v1-fixed-package.md`.
- Accepted proposal raw SHA-256: `4692895A2C9CF92DB1308507F29ED288FD3149F944AAC4F3D8BAE23635F5D663`.
- Selected fixed policy token is mutually exclusive with
  `ACCEPT_AH19_WORK_PRECHECKPOINT_COMPLETE_COVERAGE_V1`; the complete-coverage
  alternative was not accepted.
- Acceptance and landing date: 2026-10-17.
- Landing baseline: `4eea9e363c6ee9cf86b257e53f3cf8aa90a8aeaa` (DID v1.49; SD v1.17).
- Implementation authorization: **not granted**. The fixed 64-row policy is
  design-only; any change to bound, eligible types, frontier calculation,
  projector behavior or checkpoint coverage requires a separate implementation
  package and authorization. No migration is required or reserved by this
  package.

The Session Timeline remains complete and append-only. Before the first typed
Work `CompactionCheckpoint`, P2 selects the latest 64 persisted Session rows by
Session-local sequence. Current input and canonical Work/C0/C1 facts are
independent of the cap. P3 applies the existing projector branches and filters
without refilling skipped rows from older entries. `inputFrontier` records the
considered row range, not actual representation or checkpoint coverage;
skipped rows have no emitted context ref and remain durable but uncovered.
After a typed checkpoint, the active frontier is its exact sequence followed
by every unsummarized typed entry, without the pre-checkpoint cap. A checkpoint
may claim only content actually represented by the existing projector.

## Landing scope

- `docs/design/02-system-design.md` (v1.18; §3.6, §5.5–5.6).
- `docs/design/03-detailed-implementation-design.md` (v1.50; §8.8, §8.9,
  §8.13 and §8.19).
- `docs/design/implementation/P2/02-port-contracts.md` and
  `04-sqlite-schema.md` (selection contract and append-only boundary only).
- `docs/design/implementation/P3/02-model-context-contracts.md` (exact existing
  typed projector eligibility/filter semantics and pinned facts).
- `docs/design/implementation/P9/02-fault-injection-matrix.md` and
  `07-agent-loop-step-recovery.md` (restart and committed checkpoint coverage
  distinctions).

The independent Work package review is
`planning/results/AH19-work-precheckpoint-bounded-frontier-landing.review.md`.
The Conversation package is separately accepted and separately reviewed; this
record does not represent its acceptance.
