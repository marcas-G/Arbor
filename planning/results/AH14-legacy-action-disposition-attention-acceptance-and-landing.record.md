# AH14 legacy action-disposition Attention — acceptance and landing

Status: **Accepted design package landed; implementation and migration not authorized.**

- Acceptance token: `ACCEPT_AH14_LEGACY_ADOPTION_EVIDENCE_ATTENTION_GOVERNANCE`.
- Accepted proposal: `planning/proposals/AH14-legacy-action-disposition-attention-fixed-package.md`.
- Accepted proposal raw SHA-256: `71F81F8B61375B9828FAB208D517FBF2CE0092C0B71ECCD124353262E23FCFB1`.
- Acceptance and landing date: 2026-10-17.
- Landing baseline: `ccb34630b3d392695b6b43bdf843d2ca89541fbb` (DID v1.48).
- Implementation authorization: **not granted**. Migration ID assignment,
  DDL, object-store work, production code, qualification, preserved-database
  access, CLI/schema activation, deployment and publication remain outside
  this acceptance.

The accepted failure scope is limited to a uniquely bound legacy successful
Provider result and decoded action set with at least one unprovable action
disposition. P9 leaves canonical Step/action/Session/settlement untouched,
does no Provider/action/output replay, and records the canonical evidence
fingerprint with one immutable `LegacyAdoptionEvidenceEscalated(v1)` fact/event
under the current lease. Positive adoption remains unchanged.

P10 exposes exactly `LegacyAdoptionEvidenceInsufficient`,
`ActionRequired`, on the exact Workspace stored from `executions.workspace_id`,
using the fixed safe summary and `attentionFactId` dedup key. P10 validates
failure and resolution events field-by-field against immutable P9 facts before
marker/offset mutation. Rebuild seeds only unresolved failure facts from
permanent P9 facts, independent of event pruning. Resolution is evidence-only,
requires the complete original non-empty decoded action set and exact P4
same-action terminal evidence, and removes only the corresponding marker;
there is no manual dismissal or timeout.

## Landing scope

- P1: `docs/design/implementation/P1/03-transaction-model.md`,
  `docs/design/implementation/P1/04-sqlite-schema.md`.
- P9: `docs/design/implementation/P9/02-fault-injection-matrix.md`,
  `docs/design/implementation/P9/07-agent-loop-step-recovery.md`.
- P10: `docs/design/implementation/P10/02-attention-readmodel.md`,
  `docs/design/implementation/P10/04-rebuild-atscale.md`,
  `docs/design/implementation/P10/07-acceptance.md`.
- P4 `06-invocation-persistence-reconciliation.md` is reference-only and was
  not changed.
- DID v1.49 records the accepted package and links this record and review.

Migration ID remains unassigned and unreserved. The later implementation
authorization must identify the actual then-current activated predecessor and
approve its migration ID, exact SQL, ordered upgrade prefix, runtime target
and fixture baseline. No migration was registered or activated here.

Independent post-landing consistency review:
`planning/results/AH14-legacy-action-disposition-attention-landing.review.md`.
