# P38 Executable Approval Module Closure Plan

**Baseline:** `ed5fba00ee60e169cadf0df12395179862abd1e8` (v19/P37 checkpoint)
**Scope:** complete qualification and any in-contract implementation repair for
the P38 executable approval route. This is a module closure plan, not a new
phase contract or a change to frozen design semantics.

## Semantic ownership

- Exact intent, fenced consumption, no-effect denial, and effect admission:
  `docs/design/implementation/P4/03-authority-permission-approval.md`.
- Human/direct-parent approval decision authority and exact active Execution:
  the accepted P12 `ResolveExecutableApproval` route.
- Inbox/Attention projection and consumption: P10's existing projection and
  event contracts.
- Schema sequence: existing 0036 → 0037 → 0038 migration registrations. Do not
  change migration semantics from this plan.
- Recovery handoff: P39 owns persistence and replay of the exact
  `ExecutableApprovalConsumptionReceipt`; P38 supplies the existing receipt
  and must not invent a replacement receipt contract.

## Closure outcomes

1. A first gated invocation atomically admits one exact Pending approval, its
   revision-0 `eap:` Inbox entry, event, and wake fact against the active
   Execution/AgentLoopStep/action and current Worker fence. Before the human
   decision there is no ToolInvocation intent or effect admission.
2. Only an authorized, exact-revision human or accepted direct-parent decision
   can resolve the request. Approve, Reject, expiry, and Stop compete by exact
   state/revision compare-and-set; one winner owns the single terminal
   resolution and corresponding Inbox/event effects.
3. Pending approval remains a P2 pre-dispatch gate. Resolution resumes the
   same Execution, AgentLoopStep, provider action, logical action, and
   ToolInvocation identity. Reject and expiry terminate the same action with
   typed no-effect denial; Stop interrupts it without converting Stop into a
   denial.
4. P4 claims only the exact approved binding, revision, invocation, and live
   lease in the same transaction as ToolInvocation intent admission. A losing
   invocation has no intent/effect. A committed consumed approval is never
   released or consumed again on replay.
5. P39 persists and validates the exact P38 consumption receipt in the same
   claim transaction. Receipt/binding persistence failure rolls back the
   approval consume and claim; recovery of an already committed exact binding
   reuses its receipt without re-authorizing or consuming again.
6. 0036 → 0037 → 0038 upgrades preserve provable historical rows and indexes,
   retain the ActionApproval foreign-key target, fail closed for ambiguous
   legacy evidence, leave `foreign_key_check` clean, and are idempotent on
   re-entry.

## Qualification matrix

| Layer | Required evidence | Owner / dependency |
|---|---|---|
| P4/store units | Exact binding/revision, replay, rejection/expiry typed denials, terminal historical Reject, same-invocation replay after consume, authority loss after consume | P38 |
| SQLite state machine | Request/Inbox/event atomicity, TTL CAS for Pending and Approved, human-vs-TTL and Stop-vs-TTL single-winner races, exact wake recovery, cancellation retry | P38; coordinate store changes |
| Upgrade/fixture | Positive 0036→0038 equivalent legacy fixture, negative unbound Control evidence, schema/FK/index checks, repeat migration | Historical DB upgrade owner; shared `migrations.ts` coordination |
| Two-daemon process | Same-Step claim competition; kill before/after approval consume commit; effect boundary/replay and uniqueness assertions; no new Provider/action/ToolInvocation identity | P38 + P39 receipt persistence; root schedules heavy runs |
| Public API | Approve, Reject, TTL, unauthorized/stale decision, no effect while Pending, original Step resumes after decision | P38; root schedules daemon runs |
| Browser | Queue approve/reject/expiry rendering, no argument/canary leak, original execution resumes; browser restart if covered by accepted journey | P38; root schedules Playwright |
| P39 handoff | Exact `ExecutableApprovalConsumptionReceipt` persisted/validated with RecoveryBinding in P4 claim transaction; rollback/replay cases | P39 owner, P38/P39 integration |

## Execution order and constraints

1. Read accepted design ownership and the existing P38 runtime/expiry
   checkpoints; map each acceptance row to source and test evidence.
2. Add only layered test source and implementation fixes justified by a failing
   accepted-contract case. Keep `docs/design/**` untouched. Do not alter
   migration descriptors, `migrations.ts`, or shared approval-store code
   without explicit coordination with root and the historical-upgrade owner.
3. Implement and review the P39 receipt handoff only in coordination with the
   P39 owner; do not create new receipt fields or recovery semantics.
4. Run static checks/lightweight checks while the root-owned full-gate window is
   active. Run Vitest, daemon, Playwright, and migration qualification only in
   a root-scheduled window.
5. Record every layer as PASS, FAIL, BLOCKED, or NOT RUN with exact command,
   commit SHA, and limits. P38 closes only after every P38-owned row is
   evidenced and the P38 → P39 receipt seam is either implemented under its
   separate accepted authorization or explicitly dispositioned by the owner;
   five pre-existing public/browser cases alone do not close the module.
   P39 implementation remains separately gated. Until the RecoveryBinding V1
   receipt field/rule and authorization are confirmed, do not implement that
   handoff and keep its recovery-binding assertions BLOCKED. See
   `planning/proposals/P38-P39-executable-approval-receipt-handoff-dependency.md`.

## Known open boundary at plan creation

The current public process journey's two-daemon case restarts after the human
decision; it does not isolate the P4 approval-consume transaction boundary or
the external effect boundary. The Stop test currently exercises command
composition with fakes, while the SQLite suite separately exercises expiry
CAS. A durable P39 RecoveryBinding handoff is not yet retained by the P4
runtime caller at this baseline. These are open qualification/integration
items, not evidence that frozen semantics should be changed.

Static migration audit also found an implementation defect awaiting fixture
confirmation: the 0038 source `action_approvals` table from 0032 has no
`cancelled_at`, `cancelled_by`, or `cancellation_reason` columns, while the
0038 rebuild currently selects all three from that old table. The P38 target
table owns those fields, but historical source evidence cannot populate them;
after the positive 0037→0038 fixture confirms the failing SQL, map these
destination fields to SQL `NULL` and make the legacy consumed-Control negative
fixture assert its intended constraint failure rather than any migration
failure.
