# P10 → P1 Pre-Intent CandidateRead Bootstrap — Governance Decision

Decision: **ACCEPTED — Pre-Intent CandidateRead Bootstrap V1 + Option A stale binding**

Acceptance tokens:

- `ACCEPT_P10_P1_PREINTENT_CANDIDATE_READ_BOOTSTRAP_V1`
- `ACCEPT_P10_P1_PREINTENT_STALE_RECEIPT_BINDING_OPTION_A`

Accepted fixed sources:

1. `planning/proposals/P10-P1-candidate-read-preintent-bootstrap-gap-draft.md`
   - Git commit: `6c060ddf29d731f4208117ec1cc45ffc9bf7ddfb`
   - Canonical LF UTF-8 SHA-256:
     `009A965AE81F64E051625E8AC33DD499D0A6EEB35B3D3055941F96A207F00A6C`
2. `planning/proposals/P10-P1-preintent-stale-receipt-binding-addendum-draft.md`
   - Git commit: `66d3827dc10218c8b79f7c54398d6653b4b279dd`
   - Canonical LF UTF-8 SHA-256:
     `FDF4F4036385DC30722F0A21BFF8E20E1C6F1A136B2CF7DE32310FD1F141FEA4`

The selected owner semantics are the accepted Option A bootstrap plus the
accepted two-field P1 stale receipt binding:

- P4's existing `ApprovalRequired` path leaves the exact P3 Executable Action
  Pending and the exact P4 Executable approval Pending/unconsumed, without a
  ToolInvocation/RecoveryBinding, Observation, effect admission or provider
  call. P4's read-only `SandboxPolicyRequirementReadPort` may return the new
  exact pre-intent Action/approval proof under the caller's read transaction.
- P10 exposes the existing safe CandidateRead DTO from either this pre-intent
  source or the existing post-intent NotAdmitted invocation/RecoveryBinding
  source. DTO, route, CandidateId and P1 command payload are unchanged; no
  Action/approval/intent identity or source digest is exposed.
- P1 preparation resolves the exact Action/approval source outside the write
  transaction. Its existing receipt-first final `BEGIN IMMEDIATE` path
  re-reads the same proof using transaction-scoped sources, checks approval
  `expiresAt > trusted GatewayNow`, and writes the decision/event/receipt only
  if all existing CAS inputs remain current. No filesystem/provider I/O or
  nested transaction is introduced.
- `StaleSandboxPolicyInputs.safeDetails.field` adds exactly
  `ActionRevision` and `ExecutableApprovalRevision`. If both sources are
  stale, Action takes precedence. Approval state transitions are exact
  revision CAS; expiry is also checked independently against transaction time.
  No IDs, revisions, timestamps, paths, digests or diagnosis are exposed.
- P1 external payload, DecideSandboxPolicy handler schema 2, semantic request
  fingerprint, SQLite schema, decision result and existing receipt bytes do
  not change. The result decoder/view accepts the two additive safe field
  literals. P13 uses the existing generic stale/refetch message; no new route,
  command, auto-submit or auto-selection is added.
- P4 consumes approval only in its existing atomic ToolInvocation intent
  claim. P9's terminal provider-unavailable Action/Step and no-later-action
  semantics are unchanged. The bootstrap does not claim to close the separate
  second-ProviderTurn/drift qualification.

The exact owning document scope and canonical pre/post hashes are in the
companion `planning/results/P10-P1-preintent-candidate-read-bootstrap-landing-manifest.md`.
No top-level frozen owner document is changed. No production implementation,
database migration/upgrade, provider qualification, Supported-state change,
deployment or release is authorized by these decisions. A SHA-pinned fixed
implementation plan and independent review are the next permitted activity;
production code still requires separate explicit implementation
authorization.
