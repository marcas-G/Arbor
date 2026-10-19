# Sandbox Policy Candidate Read Model V5 — Fixed Implementation Plan v2

**Status:** Planning only. V5 implementation is not authorized. This fixed
package supersedes
`planning/tasks/sandbox-policy-candidate-readmodel-v5-implementation-plan.md`
(v1 SHA-256 `782B2299E7C7E6EECA94BB64903D21F3D9F448FB9E50003C13BF824B34C10C17`).
Do not integrate the isolated foundation or begin remaining implementation
until owner landing, independent post-landing review, and a separate
implementation token are complete.

**Accepted proposal:**
`planning/proposals/sandbox-policy-candidate-readmodel-governance-v5.md`

**Accepted proposal SHA-256:**
`26B4BDAA4F79DCF2A0EA7C601A1037372A9C5308AB761663A921235076CE8D13`

**Suggested authorization token:**
`AUTHORIZE_SANDBOX_POLICY_CANDIDATE_READMODEL_V5_IMPLEMENTATION`

**Isolated foundation:** `2a8fbcac`, based on unified candidate `46a4ec3d`.
It is planning evidence only and MUST remain isolated before authorization.

## Goal and invariants

P10 returns one coherent Workspace Detail candidate read only when the exact
active Execution/Episode has a verified policy-bearing Pending P3 Executable
Action. P4 supplies proof through a read-only requirement port; P5 supplies one
validated immutable V2 authority-bundle snapshot and exact current-host
Supported tuples. P10 filters Workspace applicability and returns common
preconditions once plus candidates. A human explicitly chooses one candidate
and P13 maps it to the existing P1 `DecideSandboxPolicy` payload. Candidate IDs
are presentation identities, never CAS or authority.

Both OsEnforced and TrustedLocal compare the existing full V2 authority-bundle
revision/digest and `SandboxEnvironmentBasisDigestV1`. Any V2 child change,
including registry-only drift, stales either variant. The registry branch
precondition remains OS-only. Stale policy leaves the same invocation
NotAdmitted and P3 action Pending; existing P4/P2 handling parks the same
Execution, and P10 derives `NeedsDecision`. No default, auto-submit, fallback,
new Attention fact, or provider execution is introduced.

## Isolated V5-A foundation

`2a8fbcac` contains the ports contract and SQLite read-only P4
`SandboxPolicyRequirementReadPort`, strict RecoveryBinding/P3/NotAdmitted
validation and tests; a closed candidate DTO/`spc2_` byte identity codec and
golden vector; and additive API/projection Workspace Detail candidate-read
mirrors with mutual exclusion against singular preconditions. It does not
contain P10 production query/composition, P2 full-bundle stale gating, P1/P13
selection, production `sandboxProcessPolicy` injection, or two-daemon
qualification. Its focused tests, affected package builds, Biome and diff check
were reported green; do not expand that evidence claim.

## Remaining slices and ownership

| Slice | Fixed work | Required tests / exit evidence | Depends on |
|---|---|---|---|
| P5 snapshot | `apps/single-workspace/src/sandbox-authority-bundle.ts`: supply one validated immutable V2 bundle and exact current-host Supported tuple set. Missing/unverifiable tuples are typed failure, not empty candidates. P5 never chooses policy or gates dispatch. | V2 loader/high-water tests; each issuer/operator/registry child revision/digest; exact host tuple fixture. | Accepted V3 loader. |
| P4 currentness | P4 `05`: compare existing environment-basis digest and full bundle revision/digest for both variants. Supersede only TrustedLocal's V21 registry-drift exclusion. Keep TrustedLocal unconfined; provider-registry branch checks remain OS-only. | P4 pipeline/runtime: each V2 child drift stales both variants; exact same-action interruption retains Pending/NotAdmitted with zero effect/Observation/provider call. | P5 validated snapshot. |
| P1 CAS | Reuse `packages/application/src/commands/decide-sandbox-policy.ts` and existing `/commands` transport. Map common preconditions to existing payload fields; OS alone gets registry fields. CandidateId is never CAS. | `packages/application/test/decide-sandbox-policy.test.ts`; `apps/single-workspace/test/sandbox-policy-decision-gateway.atomic.test.ts` and crash child: stale old payload rejected without decision write; explicit refreshed selection commits once. | P5 snapshot/common fields. |
| P10 candidate read | P10 `03`/`05`, production `apps/single-workspace/src/projection-query.ts`: one authorized Workspace Detail read transaction/barrier combines active Execution/Episode, exact P1 decision/result, P5 snapshot/tuples, and only P4 requirement port. Return candidate DTO, omit singular preconditions iff candidate read is present. Always one TrustedLocal choice; include only exact applicable host-Supported OS tuples; exact duplicates collapse, conflicting mappings fail closed; UTF-8 tuple ordering with TrustedLocal last. | `tests/p10-api-contracts.test.ts`, `tests/p10-views-detail.test.ts`, focused candidate query/barrier tests: initial/stale reasons, coherent common fields, OS-only registry members, candidate sort/dedup/KAT/no leakage, no partial response on typed failure. | V5-A + P5 + exact P1 result join. |
| P2 pre-dispatch stale-full-bundle gate **(v2 addition)** | P2 owner `packages/execution-runtime/src/execution-runtime.ts`, adjacent to the current `listSandboxPolicyDecisionRequired` startup/pre-dispatch scan. Capture one validated immutable V2 bundle snapshot for this decision cycle. In the same read snapshot/`TransactionScope`, inspect the exact pending requirement and the current joined P1 `{decision,result}`; treat missing/expired policy **or full bundle revision/digest mismatch** as policy-required for both variants. Do not let an unexpired but bundle-stale TrustedLocal decision pass merely because its registry branch is OS-only. Park through the existing same-Execution policy-required/RecoveryBlocked path **before lease acquisition and worker dispatch**. No P2/P10 fact, marker, event, queue, new status, or schema is added. | Extend `tests/p2-driver.test.ts`: TrustedLocal with unexpired decision and registry-only bundle drift is blocked before lease/dispatch/drive; current matching full bundle is admitted; exact pending action remains Pending and invocation NotAdmitted; zero new durable policy/Attention state. Add OsEnforced counterpart and typed corruption/no-partial-dispatch case. | P5 immutable bundle snapshot + P1 joined result + exact P4/P3 requirement evidence. Must land before claiming safe P2 startup behavior. |
| P13/API/Web explicit choice | Existing Workspace Detail and command routes only. Add deliberate selection in `apps/web/src/pages/workspace/WorkspacePage.tsx`, `apps/web/src/views/WorkspaceDetailView.tsx`, command catalog/schema and a selection form. Map selected variant and exact common preconditions to existing P1 command; human supplies existing OS network destinations. Label TrustedLocal as unconfined. No default, auto-submit, fallback, new route/command/ViewId/Problem. | `apps/web/test/workspace-page.test.tsx`, `apps/web/test/command-forms.test.tsx`, external-command/transport tests. A stale response requires refetch and a new explicit choice. | Candidate DTO + P1 CAS. |
| Production policy injection | After P5/P1 full join, wire exact current policy through `apps/single-workspace/src/executable-tool-handler.ts` / `apps/single-workspace/src/composition.ts` into existing `ToolExecutionContext.sandboxProcessPolicy`. Preserve exact Execution/Episode/action/lease/RecoveryBinding. `packages/tool-runtime/src/runtime.ts` blocks absent/stale policy before effect admission. | P4 pipeline + production-composition tests: stale/missing policy preserves the same Pending/NotAdmitted action with zero settlement, Observation, effect admission or provider call; current variants use existing branch checks. | P4 currentness + P5 + P1 result join. |
| Real SQLite dual-daemon restart | Add `tests/functional/process/sandbox-policy-candidate-readmodel-restart.functional.test.ts`, using disposable registered schema through 0050 and existing real-process/lease patterns. After registry-only V2 drift, restart before reapproval, reject old CAS, explicitly refresh/select, commit existing P1 command, restart after commit, and recover one exact current decision. | **Before reapproval:** assert `execution_leases` count 0, WorkerDispatchPort calls 0, driver/provider calls 0, same P3 Action Pending, invocation NotAdmitted, RecoveryBinding unchanged, no fact/event/queue/marker. **After explicit reapproval:** current full-bundle pair is observed and execution resumes at most once; old decision/command/event is not duplicated; no automatic choice/provider retry on read/reapproval. Also test issuer/operator child drift and OsEnforced. | All prior slices; last in DAG. |

## TDD / DAG after authorization

1. Verify accepted proposal SHA, owner landing revisions, independent post-
   landing review Blocking=0, and the implementation token. Keep `2a8fbcac`
   isolated before the gate.
2. Run V5-A read-port/DTO/KAT suites; add approved negative proof vectors first.
3. Qualify P5 bundle/high-water/current-host tuple snapshot and all child
   changes.
4. Add failing P4 currentness, P1 stale-CAS, and P2 zero-lease/zero-dispatch
   tests for both variants. Implement P4/P1 and P2 using the same current V2
   snapshot and strict joined result; preserve the existing interruption.
5. Add failing P10 candidate/barrier tests and implement using only P4/P5/P1
   public ports; do not read P3/P4 private stores from P10.
6. Add P13/Web explicit choice over the existing DTO/command; prove stale
   choices cannot submit and no default/fallback exists.
7. Wire production `sandboxProcessPolicy` only after the exact full join is
   available; show zero effect admission while missing or stale.
8. Run real dual-daemon SQLite restart/crash matrix on a disposable migrated
   database; assert all pre-reapproval zero-side-effect facts above.
9. Run candidate-specific suites/builds/architecture/review and integrate only
   after authorization and post-review.

## Non-goals / safety boundary

- No schema version, migration, table, index, trigger, persisted candidate,
  requirement marker, event/queue/fact, or durable P4 requirement state.
- No new command, route, ViewId, Problem category, payload field, permission,
  provider support status, profile or ResourceBoundary widening.
- No candidateId in CAS, authority, recovery identity or dispatch admission.
- No P10 private P3/P4 table reads; P4 port stays read-only in caller's
  TransactionScope. P2 gate adds no fact/Attention state.
- No edits to `docs/design/**`; unresolved semantics stop for owner governance.
- Do not merge/cherry-pick `2a8fbcac` until implementation authorization.

## Independent self-review

- [x] V2 explicitly supersedes v1 and preserves its audit record.
- [x] The P2 stale-full-bundle gate is pre-lease/pre-dispatch and covers an
  unexpired but full-bundle-stale TrustedLocal decision.
- [x] Dual-daemon qualification asserts lease, worker dispatch and provider
  counts are all zero until explicit reapproval, then exact single convergence.
- [x] No new durable state, schema, migration, authority or design edit is
  introduced by this plan.
- [x] Implementation remains unauthorized pending owner landing/review and a
  separate token.
