# AH14 Legacy Adoption Evidence Attention — Fixed Implementation Plan

Status: **planning only; implementation authorization requested**

Planning baseline: `58aae35b08738019749ba5bba17a26f564f0cd57`

Accepted design: DID v1.49; proposal SHA-256 `71F81F8B61375B9828FAB208D517FBF2CE0092C0B71ECCD124353262E23FCFB1`

Requested token: `AUTHORIZE_AH14_LEGACY_ADOPTION_EVIDENCE_ATTENTION_IMPLEMENTATION`

## Authorization and boundaries

This plan requests separate implementation authorization. Scope is migration `0047` (`requiresUserVersion: 46`), P9 immutable failure/resolution facts and events, P10 marker/source/query/rebuild/resolution consumption, offline CLI support to schema 47, and the qualification below. It depends on 0045 and 0046. Until accepted, do not implement any item in this plan.

Use only fresh and explicitly disposable fixtures/copies. Upgrade only offline through ordered prefix 44→45→46→47. Do not open, upgrade or mutate the preserved/dogfood database; do not deploy, release, publish, or claim AH14/release closure beyond the tested boundary. Do not modify `docs/design/**`, P4 contract, AH14 positive adoption, other legacy decoder/identity failures, or P10's existing source semantics beyond the accepted source registration. There is no human dismiss, timeout clear, external-absence proof, P4 uncertainty bypass, partial resolution, or new Provider/action replay authority.

## Fixed implementation decisions

- Migration `0047`, exact predecessor 46, name `ah14_legacy_adoption_evidence_attention`. Append without changing earlier migrations. Raise the offline/runtime schema target to 47 only as part of this authorized implementation and qualification.
- P9 owns two permanent immutable relations: `legacy_adoption_attention_facts` and `legacy_adoption_attention_resolution_facts`. Use the exact accepted v1 evidence and resolution tuple/hash/canonicalization formulas in P9 `07` (DID v1.49), including explicit Missing markers, stable action identities, fixed failure and resolution codes, deterministic IDs, immutable first-detected/resolved timestamps, and one resolution per failure. Do not store Provider text, raw arguments, host paths, or error strings.
- Failure path applies only to a legacy successful Provider result whose Execution, ProviderTurn, AgentLoopStep and decoded action set are uniquely bound but at least one action disposition is unproven. Persist one failure fact/event atomically under current unexpired lease after the final fence check. Leave Step/action/session/settlement unchanged, return typed blocked disposition, release lease through existing path; no Provider/action/Command/output replay.
- P10 registers exactly `LegacyAdoptionEvidenceInsufficient`, severity `ActionRequired`, exact `executions.workspace_id` captured by P9, `dedupKey=attentionFactId`, fixed safe summary, and source Execution binding for authorization/freshness. The marker references the exact P9 fact tuple; validate every event envelope and exact payload field/key against immutable facts before marker mutation or offset advancement.
- Resolution is evidence-only and requires the complete non-empty original decoded action set in order. Applied requires exact same-action P4 Action/ToolInvocation terminal settlement, result and Observation; NotAdmitted requires the exact closed terminal Denied settlement. Recompute tuple digest, bounded summary hash and derived code; commit Step progression plus immutable resolution fact/event atomically. P10 clears only the matching marker after full validation; both P9 facts remain permanently retained.
- Do not reuse source-fact/event journal retention for rebuild. Full P10 rebuild clears/recreates this marker source from retained P9 failure and resolution facts and rewinds the existing owned offset under current rebuild rules.

### Migration 0047 relation inventory

The migration creates the exact accepted shapes below; DDL constraints/indexes must encode the accepted identity and uniqueness rules and the P1 composite marker FK. The named fields and constraints are not permission to alter the canonical serialization/hash contracts.

| Relation | Required immutable columns / key constraints |
|---|---|
| `legacy_adoption_attention_facts` | `attention_fact_id` PK; unique `event_id`; `project_id`, exact `execution_id`, `workspace_id`, `provider_turn_id`, `logical_step_no`, `repair_attempt`, fixed `failure_code='LegacyActionDispositionUnproven'`, `evidence_sha256`, `first_detected_at`; unique `(execution_id,evidence_sha256)` and composite unique `(attention_fact_id,project_id,workspace_id)` for P10 FK |
| `legacy_adoption_attention_resolution_facts` | `resolution_fact_id` PK; unique `attention_fact_id` FK (one resolution); unique `event_id`; project/Execution/Workspace/ProviderTurn; `original_evidence_sha256`, `resolution_evidence_sha256`, canonical bounded summary JSON and SHA, closed derived `resolution_code`, `resolved_at`; exact original fact binding |
| `legacy_adoption_attention_rows` | `(project_id,attention_fact_id)` PK; exact `workspace_id`; composite FK `(attention_fact_id,project_id,workspace_id)` to failure fact |

The migration also installs required immutability protections and P10 source registration through the existing source catalog. It does not backfill arbitrary existing legacy rows at migration time: detection occurs only at the accepted recovery boundary with validated evidence. If the current registration architecture requires any additional public source fields, indexes or state transitions beyond the accepted contract, stop for governance rather than extend semantics.

## Implementation work sequence

1. Reproduce `tests/functional/pending/ah14-ambiguous-legacy-attention.functional.test.ts` against an equivalent disposable baseline. Retain the existing positive process test `tests/functional/process/agent-loop-ah14-legacy-adoption-crash.functional.test.ts` as a regression.
2. Add migration 0047 and migration/offline-CLI qualification over exact disposable 46→47 prefix; verify exact keys/FKs/immutability, rollback/re-entry and absence of mutations to earlier migrations.
3. Implement canonical v1 source fingerprinting, identity validation, exact P9 fact/event transaction, lease recheck, deterministic retry and fail-closed mismatch handling. Keep all three failure states (before commit, after commit, storage/fence failure) distinct.
4. Implement P10 source DTO, authorization, event-to-fact validators, atomic marker/offset insertion/deletion, exact rebuild from retained P9 facts and evidence-only resolution consumption.
5. Implement full P9 resolution verification and atomic progression/fact/event path, retaining original failure fact and exact no-clear behavior absent complete proof.
6. Extend offline CLI to 47 after 45 and 46; run the focused negative/positive and crash/rebuild matrix against disposable fixtures only.

## Required qualification matrix

| Surface | Required cases |
|---|---|
| Negative trigger | Current ambiguous-action RED becomes blocked with one P9 fact/event and one public ActionRequired row; no Provider request, action/Command, Step transition, Session output or settlement; preserve exact pre-fact canonical state |
| P9 identity | Canonical v1 bytes, SHA, `att_` ID, field-level source bindings, explicit Missing, action order; exact retry returns same pair/time; conflicting tuple corrupt; failure fact and event atomic before/after commit crash; stale/expired lease denied |
| P10 projection | Event validates against fact field-by-field; one marker/offset atomic commit; exact target Workspace/auth; safe DTO only; malformed/missing/extra/mismatched event field leaves marker and offset unchanged; replay deduplicates |
| Rebuild | Prune P1 event while retain P9 facts; rebuild restores exactly unresolved marker, not resolved marker; source facts remain immutable and retained; offset reset and marker rebuild atomic |
| Resolution positives | Complete non-empty all-NotAdmitted→`DispositionProvenNotAdmitted`; mixed/all-Applied→`DispositionProvenSettled`; exact Applied P4 settlement/result/Observation and exact closed NotAdmitted denial evidence; exact tuple/hash/summary/code/ID; exact retry stable |
| Resolution negatives | Empty/partial/duplicate/reordered/mismatched action set; unknown/OutcomeUnknown/RuntimeFailure; human assertion; wrong P4 invocation/hash; historical ApprovalRequired; supplied code/hash/summary mismatch; conflicting second resolution—all reject before Step progression/fact/event/marker removal |
| Resolution recovery | Before/after atomic P9 transaction kill; before/after P10 marker/offset commit kill; repeated restart; original failure and resolution facts remain, only matching marker clears; no extra Provider/action/output |
| Positive adoption regression | Existing equivalent-fixture two-sided process test remains green, one sourced output and one Provider call, no AH14 Attention |
| Migration/CLI | Fresh 47; exact 46→47 and ordered 44→47 disposable prefix; rollback/re-entry; FK/unique/immutability checks; offline CLI target 47; no preserved DB invocation |

The accepted contract's complete field mutation list and canonical resolution rules in P9 `07`/P10 `02` are mandatory test vectors; this table is a coverage index, not a replacement for them.

## Stop conditions and exclusions

Stop on ambiguous identity that falls outside the accepted action-disposition failure class, any attempt to adopt before resolution proof, inability to validate exact P4 evidence, inability to bind P10 marker to the captured Workspace, or any proposed human/timeout clearing path. Do not widen into other legacy decode failures or AH14 positive semantics. No preserved DB, deployment, release, implementation before authorization, or closure claim based on targeted tests alone.
