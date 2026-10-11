# AH7-DG-01 / P39 ReconciledNoEffect Compatibility — Landing Stop Report

Date: 2026-10-11  
Status: **P40 owner landing stopped; new P39/P40 observation-evidence design gap requires governance**

## Fixed inputs and baseline

- Unified governance tree baseline before this report:
  `5e5b1296f17cfa10ab90815f24d2d0f1afebcd9d` (Phase 2 P39 owner landing).
- P39 accepted logical proposal SHA-256:
  `D0A43BCDF3F95424BE7167B49D2170917B7605EE1E498A2601F2FFFB3DD6940B`.
- P39 accepted physical supplement SHA-256:
  `D2FF13087BB7A1BC5C9D422B4D5CEDE56689F83E765F96615FE13561CE5D446C`.
- P39 post-landing review was reported by the coordinating Governor as
  **Blocking = 0 / 25 owner files matched**. The review artifact was not present
  in this worktree; this report does not invent its file/hash.
- AH7-DG-01 accepted logical proposal SHA-256:
  `19EFED54E037D3E2EC6F4D273D917F5249195650E5E41B3DCFF8DEB9784F29CD`.
- AH7-DG-01 accepted P40 physical supplement SHA-256:
  `5B61E0FF922A10D225FD5DAEA00176BD16C5C0B39484D626B7FEF6340516373A`.
- Selected planning-package transfer commits in this tree are `8bf7f23` (logical
  fixed proposal), `6f163ed` (logical acceptance), `e45dd67` (physical proposal
  and pre-review record), `2ac8acc` (DG03 Denied physical compatibility), and
  `3dbd195` (physical supplement acceptance). No `f80` baseline was merged.

## Blocking compatibility evidence

P39 added a sixth terminal `CanonicalToolObservation` variant:

```ts
{
  _tag: "ReconciledNoEffect";
  reasonCode: ReconciledNoEffectCode;
  reconciliationFactRef: ReconciliationFactId;
  observation: BoundedObservation; // text + truncated
  resultRef: ArtifactRef;
}
```

The exact P39 contract is in `planning/proposals/AH7-DG-02-reconcilable-tool-reality-fixed-decision-draft.md`
§“终结结果与 Attention 映射” and P4 `01-tool-contracts.md` §4. Its P3
mapping consumes this exact canonical union variant and converges the sourced
ToolResult/Observation/Action/cursor. P39 `tool_invocations` makes this a
terminal `ReconciledNoEffect`, requires `MayHaveStarted`, a non-null Artifact
`result_ref`, and same-invocation/same-attempt `selected_fact_id` via immutable
fact/FK provenance (`P4/06` §P39 Durable rows; accepted P39 physical supplement
§schema/selected-fact checks).

However, accepted P39 durable columns store only settlement JSON (reason code
and reconciliation fact ref), `result_ref`, and selected attempt/fact IDs.
`tool_reconciliation_facts` stores proof outcome/reason, evidence/result
Artifact refs/hashes, but no canonical bounded Observation text, `truncated`
bit, Observation format version, canonical Observation bytes, or its digest.
P39 does not pin a deterministic `reasonCode/fact → BoundedObservation`
encoding, and an Artifact FK alone does not define those bytes or truncation
semantics. Therefore current accepted contracts cannot establish exact
first-returned `ReconciledNoEffect` observation replay across the terminal-settle
/ P3-handoff crash boundary.

The accepted P40 SQL candidate makes the incompatibility concrete: its terminal
trigger admits the five DG01 evidence-bearing tags (`Success`,
`ExpectedFailure`, `Interrupted`, `OutcomeUnknown`, `RuntimeFailure`) and the
separate DG03 `Denied/NotAdmitted` NULL-evidence exception. Its closed
`ELSE 0` branch rejects `ReconciledNoEffect` terminal writes. Simply allowing
that tag without new evidence would avoid the SQL rejection but leave P3's
exact `BoundedObservation`/`truncated` replay unproven; adding it as a sixth
DG01 envelope tag would exceed the accepted P40 physical package. It must not
be translated into `Denied` or `ExpectedFailure`, and P40 must not discard or
change P39's `selected_fact_id`, proof reason, or `result_ref`.

## Disposition

This is a new P39/P40 compatibility gap, not an implementation detail that can
be inferred during owner landing. No P40 owner-document edits were retained.
P40 design landing is blocked until a separately fixed and accepted addendum
defines how P39 `ReconciledNoEffect` durably binds/reconstructs the exact
bounded observation while preserving its proof/ref/selected-fact contracts,
including terminal SQL transition checks and P3 replay/source behavior. The
P36 Denied branch and P39 sidecar/preflight remain untouched.

Only already accepted planning artifacts were transplanted. This report adds no
semantics to `docs/design/**`; no P40 DDL/code, migration, tests, daemon, or
release qualification was performed. The P39/P40 migration prefix and
cross-process migration-runner prerequisite remain unqualified.
