# AH14 legacy action-disposition Attention fixed-package record

Date: 2026-10-16

Status: **planning-only fixed package prepared; not accepted and not
implemented**.

Candidate baseline: `367fd9a3d064409b77b03bcab4ba26703d0a32b8`.

Proposal:
`planning/proposals/AH14-legacy-action-disposition-attention-fixed-package.md`

Raw proposal SHA-256 (working-file bytes):
`71F81F8B61375B9828FAB208D517FBF2CE0092C0B71ECCD124353262E23FCFB1`.

The proposed acceptance token is
`ACCEPT_AH14_LEGACY_ADOPTION_EVIDENCE_ATTENTION_GOVERNANCE`. It accepts only
the fixed P9/P10 owner contract and landing scope. Implementation, migration
ID assignment, CLI/current-schema activation, preserved-database access,
deployment and publication each remain outside its authority and require the
stated separate implementation authorization where applicable.

## B self-review

- The package fixes one failure scope and failure code; other legacy
  identity/decoder failures are explicitly out of scope.
- It pins `LegacyAdoptionEvidenceEscalated` →
  `LegacyAdoptionEvidenceInsufficient`, `ActionRequired`, and exact
  `executions.workspace_id` targeting with Execution-bound P9 facts.
- Stable evidence tuple canonicalization, explicit Missing markers, fact ID,
  dedup key and first-writer timestamp are defined.
- Resolution evidence is a canonical full action set with exact ordinal and
  stable-identity matching, a fixed non-empty action-set-to-resolution-code
  mapping, an explicit `resolution_evidence_sha256` formula, and exact
  same-action P4 Action/ToolInvocation terminal settlement plus
  Observation proof for Applied or closed terminal no-effect Denied proof for
  NotAdmitted. Exact retries are idempotent; conflicting resolution tuples are
  typed corruption; the derived code is in the canonical tuple/hash and is a
  direct input to the deterministic resolution fact ID. P9 and P10 recompute
  the derived code from the complete,
  persisted non-empty disposition summary and reject a supplied/event code
  mismatch. No partial or human-declared resolution is allowed.
- The immutable original evidence tuple itself carries the same per-action
  ordinal, logical action ID, call reference, tool name/schema version, and
  canonical input hash used by the resolution matcher.
- P9 event/fact and P10 marker/offset crash sides, public safe DTO, rebuild
  source, permanent fact retention, evidence-only resolution lifecycle, and
  field-by-field immutable event-to-fact binding are specified. Failure and
  resolution payload schemas and envelopes are exact; any bad field/binding
  fails closed without marker mutation or offset advancement. P4 dependency is
  reference-only to the existing
  `docs/design/implementation/P4/06-invocation-persistence-reconciliation.md`
  contract; no P4 change is requested.
- The migration is ordered after the current activated prefix without
  reserving an unlanded numeric ID; tests cover P9/P10, migration, public
  projection, positive AH14 regression and crash/rebuild behavior.
- `git diff --check` passes. No tests were run. Only this proposal and result
  were created; no `docs/design/**`, code, migration or test file was changed.

Working-file SHA-256 was recomputed after the resolution-code and event-binding
clarifications. `git diff --check` was run; no tests were run, as requested.
The remaining gate is the manual acceptance token, followed by owner-document
landing and independent consistency review. This record does not assert
governance acceptance or implementation authorization.
