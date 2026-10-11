# AH7-DG-01 / P39 `ReconciledNoEffect` Replay Compatibility Addendum

Status: **DRAFT — new physical/replay compatibility semantics; awaiting independent review and manual acceptance**
Date: 2026-10-11
Baseline: unified governance tree `d4de2d31f653a5d9a936066f4611c3b0235ec87b`

This addendum is a separate acceptance package. It does not amend accepted D0A,
the accepted P39 physical supplement, or the accepted AH7-DG-01 logical/P40
physical files in place. It proposes only the missing compatibility needed
before P40 owner-contract landing. No production, migration or test change is
authorized.

## 1. Fixed accepted inputs and review evidence

| Package | Fixed LF SHA-256 |
|---|---|
| AH7-DG-02 logical / D0A | `D0A43BCDF3F95424BE7167B49D2170917B7605EE1E498A2601F2FFFB3DD6940B` |
| AH7-DG-02 P39 physical / D2FF | `D2FF13087BB7A1BC5C9D422B4D5CEDE56689F83E765F96615FE13561CE5D446C` |
| AH7-DG-01 logical / 19EF | `19EFED54E037D3E2EC6F4D273D917F5249195650E5E41B3DCFF8DEB9784F29CD` |
| AH7-DG-01 P40 physical / 5B61 | `5B61E0FF922A10D225FD5DAEA00176BD16C5C0B39484D626B7FEF6340516373A` |

The P39 post-landing review was reported as Blocking=0 / 25 owner files
matched. The independent P39/P40 bridge review separately confirmed that
P39 `ReconciledNoEffect` lacks durable bounded-observation bytes and recommended
compatibility Option B. The bridge-review artifact itself was not present in
this worktree; this addendum cites the coordinator-reported finding and the
local stop evidence
`planning/results/AH7-DG-01-P39-ReconciledNoEffect-compatibility-blocker.report.md`
without inventing a review filename/hash. Independent review of this new
addendum remains outstanding.

## 2. Compatibility decision proposed for acceptance

Extend the accepted P40 v1 bounded inline Observation envelope with exactly the
P39-owned `ReconciledNoEffect` canonical union branch. It uses the same
`p4-canonical-tool-observation-v1`, UTF-8 canonical JSON, 16,384-byte maximum,
version+LF+body SHA-256, P4 first-settlement transaction, and immutable replay
rules as the five AH7-DG-01 evidence-bearing tags. It is a P39 compatibility
branch, not a new sixth P39 field set and not a new side-effect outcome.

P40 adds no observation column or alternate encoding to P39 tables. It only
binds the complete P39 terminal/proof identity to the already accepted P40
`tool_invocations` observation fields. P39 `selected_fact_id`, selected
attempt, RecoveryBinding, effect admission, settlement, proof facts and P39
Artifact contract remain unchanged and immutable.

This is a new additive accepted semantic constraint: **P39 owner contracts may
land, but a P39-only database at `user_version=39` must not start Agent/P4
Runtime or be released. The cumulative migration and startup chain must apply
P40 and reach `user_version=40` before serving.** A P40 failure after P39
commit leaves the database in maintenance-only state; recovery retries the
same serialized cumulative migration, never starts service at 39. Existing
P36→P37→P38→P39 migration ordering, P39 preflight/sidecar, and Windows/local
filesystem qualification remain gates; this addendum asserts none have passed.
The P40-enabled binary's closed v1 Observation decoder includes the accepted
P39 RNO branch; a P39-only/older binary must refuse `user_version=40` before
opening service runtime, rather than trying to decode RNO with a five-tag-only
decoder.

## 3. P39/P40 invariant for `ReconciledNoEffect`

A new P40 `ReconciledNoEffect` terminal row is eligible only if all accepted
P39 invariants already hold and the same terminal transaction additionally
commits the exact P4 Observation envelope:

- `settlement_kind='ReconciledNoEffect'`,
  `settlement_provenance='Reconciliation'`,
  `effect_admission_state='MayHaveStarted'`, and
  `recovery_binding_state='Bound'`;
- `selected_attempt_no` and `selected_fact_id` are both non-NULL and the
  existing deferred composite FK binds that exact
  `(invocation_id, selected_attempt_no, selected_fact_id)` to the immutable
  P39 fact;
- the selected fact is a `ProfileReconciliation` / `RecoveryInput` fact for
  the same invocation and attempt, has `outcome='NotOccurred'`, a non-NULL
  proof `evidence_ref` + valid `evidence_sha256`, NULL fact `reason_code`, and
  `result_ref IS NULL` (P39's NotOccurred fact rule);
- `settlement_json` is the exact P39 terminal union: `_tag=ReconciledNoEffect`,
  `reasonCode` from the accepted closed five-code set, and
  `reconciliationFactRef=selected_fact_id`;
- `observation_json` is the exact P4 union: `_tag=ReconciledNoEffect`, the same
  closed `reasonCode`, the same `reconciliationFactRef`, bounded `observation`
  `{text,truncated}`, and non-NULL `resultRef`;
- `tool_invocations.result_ref` is the exact same valid P4 `ArtifactRef` as
  `observation_json.resultRef`. It is the P4 terminal-result Artifact, **not**
  the selected P39 proof fact's `result_ref` (which is NULL for NotOccurred),
  not `evidence_ref`, not `selected_fact_id`, and not P3's content hash.

The P4 typed writer additionally verifies the selected fact's immutable
RecoveryBinding/profile/effect identity and proof hash, and that its
NotOccurred finality satisfies D0A, before settling. This does not permit P4
to re-probe/reconcile after terminal settlement or rewrite the selected fact.
The application codec enforces the accepted ≤2,000 UTF-16-code-unit text cap;
the SQLite JSON trigger checks text type/truncation boolean and the whole-body
16 KiB limit but does not approximate UTF-16 length with SQLite character count.

P40's shared envelope invariants still apply: deterministic object key/array
encoding, strict UTF-8, maximum 16,384 UTF-8 bytes, exact body hash, text at
most 2,000 UTF-16 code units, and exact stored `truncated`. The P39 reason
code/fact/ref fields are included in the same hashed bytes; they are never
reconstructed from current policy or free text. The exact closed SQL
validation branch and tag/source matrix are in the companion matrix.

## 4. Distinct identities — no ref aliasing

| Value | Owner/meaning | Required P39/P40/P3 relationship |
|---|---|---|
| P39 `tool_reconciliation_facts.fact_id` / P4 `reconciliationFactRef` | immutable selected NotOccurred proof identity | equals P39 `tool_invocations.selected_fact_id`, same invocation/attempt; settlement JSON and observation JSON carry this fact ref |
| P39 fact `evidence_ref` / `evidence_sha256` | external proof evidence | required and hash-verified by P4; never treated as a P4 result Artifact or Observation body |
| P39 NotOccurred fact `result_ref` | no external result occurred | must stay NULL; P40 must not fabricate or copy P4's terminal Artifact here |
| P4 `tool_invocations.result_ref` / P4 Observation `resultRef` | P39-required terminal P4 ArtifactRef | same exact ArtifactId, valid Artifact metadata; distinct from all P39 proof fields |
| P3 `ToolResult.resultRef` | existing bounded-payload content hash | computed from the exact P3 bounded ToolResult payload; not an ArtifactId or fact ID |
| P3 `observationRef` | stable P3 sourced Session/Action identity | existing formula over `(executionId, providerTurnId, callRef, P3 resultRef)`; Session `source_ref`, ToolResult `observationRef`, and AgentLoopStep `observation_source_ref` remain equal |

No identity is derived from raw shell output, current filesystem state, Session
text, or an Artifact read performed after settlement.

## 5. Legacy, lease, and Attention disposition

P40 migration remains strictly no-backfill. A P39-era terminal
`ReconciledNoEffect` row with missing/NULL P40 evidence retains every P39 field,
including `selected_fact_id`, proof fact, P4 `result_ref`, and settlement. It is
not re-executed or rewritten. For a still-Pending P3 action, a valid current
generation detects `Missing`, returns `RecoveryBlocked`, and writes exactly one
existing P9 replay-evidence fact/event plus one P10 source-specific Attention
marker. It writes no ToolResult, Action disposition, Observation source or
cursor advancement. Existing P3 exact-ToolResult/Applied natural convergence,
if already durably proven, follows the accepted AH7-DG-01 §4 rule and does not
append a duplicate result.

Every terminal evidence read first validates the complete current Worker lease
and expiry. A stale generation returns `LeaseFencingRejected` ownership-lost
without reading/projecting P39 proof/Observation, changing `selected_fact_id`,
writing P3 state, or producing replay-evidence Attention. Only a valid
generation then validates exact P3 invocation identity and P39 terminal,
RecoveryBinding and selected-fact/attempt proof consistency before decoding the
P40 envelope. A broken P39 binding/fact is `IntentMismatch` or
`SettlementMismatch`; a valid P39 RNO terminal whose P40 evidence fields are
NULL is `Missing`; a bad envelope/ref/hash uses its existing closed P40 failure
code. Only a valid generation may emit the deduplicated P9/P10 recovery signal.
P39 selected fact and P4 terminal result are never overwritten.

The P10 source remains only `ToolObservationReplayEvidenceFailure` for the
P9 missing/corrupt-evidence fact; it does not project ordinary valid
`ReconciledNoEffect`. Failure code is internal-only; the accepted fixed
path-free summary is the only public detail. P10 uses its accepted dedicated
marker, existing shared Attention offset and source reset/rebuild rules.

## 6. Migration, startup, concurrency, and crash boundaries

P39 may land as owner design and its migration may run only inside the ordered
cumulative maintenance chain. No P39-only Runtime startup/release is valid.
P40 `0040_tool_observation_evidence` follows P39 at `user_version=39`; P36–P40
must be a cumulative predecessor-complete chain. P39's operator sidecar and
preflight remain unchanged and run at their accepted boundary. P40 does not
reuse the sidecar. The cumulative runner must serialize cross-OS-process
startup so no two processes both apply the same version-39 suffix. Windows
sidecar/filesystem and the full P36–P40 prefix are still unqualified gates.

The companion matrix includes P40 migration before/during/uncertain/after
commit OS-process kill cases; RNO P4 terminal-evidence commit before/after
kill; P3 handoff before/after kill; same-invocation multi-process winner and
loser projection; stale-generation fence rejection; valid-generation missing
legacy evidence; and P10 marker/offset atomicity/rebuild. These are future
qualification requirements, not evidence run by this addendum.

## 7. Compatibility owners and acceptance boundary

After this addendum is separately accepted, owner landing may update only the
P40 P4 trigger/tag matrix and the P4/P3/P9/P10 clauses needed to preserve the
same `ReconciledNoEffect` exact outcome. It must preserve P36 Denied/approval,
P37 Deliver, P38 EA, P39 RecoveryBinding/selected-fact/sidecar, and all five
AH7-DG-01 tags exactly. The P40 physical slot remains P36→P37→P38→P39→P40;
no migration code or implementation qualification is authorized here.

**Review scope requested:** determine whether this same-envelope P39 RNO branch
is compatible with all four accepted packages above, especially exact
Observation/Artifact replay and P39 selected-fact immutability. Until accepted,
do not land P40 owner documents or claim AH7-DG-01 completion.
