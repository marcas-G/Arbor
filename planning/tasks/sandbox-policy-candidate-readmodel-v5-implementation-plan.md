# Sandbox Policy Candidate Read Model V5 — Fixed Implementation Plan

**Status:** Planning only. V5 implementation is not authorized. Do not
integrate the isolated foundation or begin remaining implementation until the
owner landing, independent post-landing review, and separate implementation
token are complete.

**Accepted proposal:** `planning/proposals/sandbox-policy-candidate-readmodel-governance-v5.md`

**Accepted proposal SHA-256:** `26B4BDAA4F79DCF2A0EA7C601A1037372A9C5308AB761663A921235076CE8D13`

**Suggested authorization token:**
`AUTHORIZE_SANDBOX_POLICY_CANDIDATE_READMODEL_V5_IMPLEMENTATION`

**Isolated foundation:** `2a8fbcac`, based on unified candidate `46a4ec3d`.
This commit is planning evidence only and MUST remain isolated: do not merge,
cherry-pick, or claim it as authorized production implementation before the
token is granted.

## Goal and invariants

P10 returns one coherent Workspace Detail candidate read only when the exact
active Execution/Episode has a verified policy-bearing Pending P3 Executable
Action. P4 supplies proof by a read-only requirement port; P5 supplies only a
validated immutable V2 authority-bundle snapshot and exact current-host
Supported tuples. P10 filters Workspace applicability and returns common
preconditions once, followed by exact candidates. A human deliberately selects
one candidate and P13 maps it to the existing P1 `DecideSandboxPolicy`
payload. Candidate IDs are display identities, never CAS or authority.

Both OsEnforced and TrustedLocal compare the existing full V2 authority-bundle
revision/digest and `SandboxEnvironmentBasisDigestV1`. Any V2 child change,
including registry-only drift, stales either variant. The registry branch
precondition remains OS-only. P4 keeps the same action Pending/NotAdmitted and
uses existing `SandboxPolicyRequiredInterruption`; P10 derives
`NeedsDecision`; a human must choose again. No defaults, automatic submit,
fallback, widened authority/ResourceBoundary, new Attention fact, or provider
execution is introduced.

## Isolated V5-A foundation already present

Commit `2a8fbcac` contains:

- `packages/ports/src/sandbox-policy-requirement.ts` and ports barrel: closed
  requirement result and read-only port contract.
- `adapters/persistence-sqlite/src/sandbox-policy-requirement-read-port.ts`
  and adapter barrel: same-transaction strict SQLite derivation from active
  Execution, P3 Step/Action, NotAdmitted P4 invocation and immutable P39
  RecoveryBinding; no writes.
- `adapters/persistence-sqlite/test/sandbox-policy-requirement-read-port.test.ts`:
  valid shell/profile proof, absence, read-only, corruption, duplicate action,
  cursor and profile-field checks.
- `packages/domain/src/sandbox-policy-candidate.ts` and domain barrel: closed
  candidate DTO, exact `spc2_` raw-byte identity and canonical codec;
  `packages/domain/test/sandbox-policy-candidate.test.ts` has the accepted
  TrustedLocal golden vector and order/closure cases.
- `packages/api-contracts/src/views.ts` and
  `packages/projection-runtime/src/views/workspace-detail.ts`: mutually
  exclusive candidate-read/singular-preconditions response mirrors and
  candidate passthrough guard.
- `tests/p10-views-detail.test.ts` and synchronized existing Attention-source
  assertion in `tests/p10-api-contracts.test.ts`.

Reported evidence on the isolated commit: focused Domain/SQLite/P10 tests and
builds pass, as do affected-file Biome and `git diff --check`. This does not
qualify P10 production query/composition, P1/P13 selection, production
`sandboxProcessPolicy` injection, or two-daemon recovery.

## Remaining implementation slices

| Slice | Fixed work and exact owners | Tests / exit evidence | Prerequisite |
|---|---|---|---|
| P5 authority input | `apps/single-workspace/src/sandbox-authority-bundle.ts`: use one validated immutable V2 bundle and exact host-qualified tuple snapshot. Missing/unverifiable snapshot is typed failure, not empty candidates. P5 never chooses policy or gates dispatch. | Existing V2 loader tests plus child-drift and exact-host tuple fixtures. | Accepted V3 loader/currentness rules. |
| P4 currentness | P4 `05`: compare existing environment-basis digest and full bundle revision/digest for both variants; remove only the accepted V21 TrustedLocal registry-drift exclusion. Keep TrustedLocal unconfined and OS registry checks OS-only. | P4 pipeline/runtime tests for registry-, issuer-, and operator-child drift; exact NotAdmitted interruption and zero effect/Observation/provider call. | Validated P5 snapshot. |
| P10 candidate query | P10 `03`/`05`, implemented at `apps/single-workspace/src/projection-query.ts`: combine active Execution/Episode, exact P1 decision/result, P5 snapshot/tuples and only the P4 read port in one authorized Workspace Detail transaction/barrier. No P10 direct reads of P3/P4 private tables. | `tests/p10-api-contracts.test.ts`, `tests/p10-views-detail.test.ts`, candidate query/barrier tests. Check initial/stale reasons, coherent common fields, OS-only registry fields, candidate filtering/sort/dedup/TL-last, ambiguity and no partial return on typed failure. | V5-A + P5 + exact P1 result join. |
| P1 CAS | Reuse `packages/application/src/commands/decide-sandbox-policy.ts` and existing `/commands` transport. Map common preconditions exactly to current payload fields for both variants; map registry pair only for OsEnforced. Never send candidateId as CAS. | `packages/application/test/decide-sandbox-policy.test.ts`; `apps/single-workspace/test/sandbox-policy-decision-gateway.atomic.test.ts` and crash child: old candidate rejected stale; explicit refreshed choice commits once. | P5 snapshot and common fields. |
| P13/API/Web choice | Existing Workspace Detail and command routes only. Add candidate display/explicit choice in `apps/web/src/pages/workspace/WorkspacePage.tsx`, `apps/web/src/views/WorkspaceDetailView.tsx`, command catalog/schema and a deliberate selection form. Human supplies existing OS network destinations. TrustedLocal is identified as unconfined. No default, auto-submit, fallback, new route/command/ViewId/Problem. | `apps/web/test/workspace-page.test.tsx`, `apps/web/test/command-forms.test.tsx`, external-command/transport tests. Stale response must require new read and deliberate choice. | Candidate DTO + P1 CAS. |
| Production policy injection | After P5/P1 exact join, pass the current verified policy through `apps/single-workspace/src/executable-tool-handler.ts` and `apps/single-workspace/src/composition.ts` into existing `ToolExecutionContext.sandboxProcessPolicy`; preserve exact episode/action/lease/RecoveryBinding. `packages/tool-runtime/src/runtime.ts` continues to block absent/stale policy before effect admission. | P4 pipeline and production-composition tests: missing/stale policy preserves same Pending/NotAdmitted action and makes zero settlement/Observation/effect/provider calls; current variants follow existing branch checks. | P4 currentness + P5 snapshot + P1 result join. |
| Real SQLite dual-daemon qualification | Add `tests/functional/process/sandbox-policy-candidate-readmodel-restart.functional.test.ts` (and a child only if needed), using disposable registered schema through 0050. Daemon A reads/submits under bundle N; registry-only V2 update stales TrustedLocal too; kill/restart before reapproval; reject old CAS; human re-reads/selects; commit existing P1 command; restart after commit and recover exact single current decision. | Assert same P3 action/RecoveryBinding stays Pending/NotAdmitted until reapproval; updated common revision/digest; no duplicate decision/command/event, new Execution/Step, automatic selection/provider call, P4/P9 fact, or schema mutation. | All prior slices; last in DAG. |

## TDD / DAG after authorization

1. Verify proposal SHA, owner revisions, independent owner post-review
   Blocking=0, and the implementation token. Keep `2a8fbcac` isolated before
   this gate.
2. Run V5-A port/codec tests; add any approved proof/KAT negatives first.
3. Qualify P5 V2 bundle/high-water/current-host tuples and all child revisions.
4. Add failing P4/P1 tests for full-bundle currentness and stale CAS on both
   variants; then implement while preserving the same-action interruption.
5. Add failing P10 query/barrier tests, then derive candidates only through the
   P4 port and P5 snapshot. Verify no partial response and no private evidence
   leakage.
6. Add P13 explicit Web selection over existing DTO/command; prove stale
   choice cannot submit and no automatic/default/fallback behavior exists.
7. Wire production `sandboxProcessPolicy` only after the exact P1/P5 join is
   available; prove no effect admission while missing/stale.
8. Finish with the real two-daemon SQLite restart matrix on a fresh disposable
   database, then candidate-specific builds, tests, architecture and review.

## Non-goals and safety boundaries

- No schema version, migration, table, index, trigger, persisted candidate,
  requirement marker, new event/queue/fact, or durable P4 requirement state.
- No new command, route, ViewId, Problem category, payload field, permission,
  profile, provider support status, or ResourceBoundary widening.
- No candidateId in CAS, authority, recovery identity, or dispatch admission.
- No P10 direct P3/P4 private-store reads; P4 port is read-only in the caller's
  TransactionScope.
- No editing `docs/design/**`; unresolved semantics stop for owner governance.
- Do not merge/cherry-pick isolated `2a8fbcac` until authorization and review.

## Self-review

- [x] Proposal SHA matches the parent-supplied accepted package.
- [x] Plan records implementation as unauthorized pending owner landing,
  independent review, and separate token.
- [x] Existing V5-A foundation is distinguished from remaining production
  qualification.
- [x] Ownership and dependencies are separated across P4/P5/P1/P10/P13/P2/P9.
- [x] TDD and final two-daemon SQLite restart are explicit.
- [x] No schema, migration, permission widening, or design-document change is
  included.
