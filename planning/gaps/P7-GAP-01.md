# P7-GAP-01 — Vacant-workspace dependency attention channel (DEFERRED to P10)

**Raised:** 2026-09-21, P7 contract targeted review (round 2, B-2 zero-candidate branch).
**Disposition:** 2026-09-21, DEFERRED to P10 → **CLOSED 2026-09-22 at P10 completion**: implemented as the `WaitingOnVacantProducer` canonical-state-derived Attention view (`packages/projection-runtime/src/attention.ts`; join with the ¬Retired predicate; positive+negative fixtures in p10-attention-readmodel / p10-acceptance Story B; zero runtime mutation — canonical snapshots asserted). See `planning/results/P10.result.md`.

## Fact pattern

A `WorkspaceBound(WS)` Dependency whose target workspace is **vacant** (no Open
Work) and **not retired**:

- no eligible producer exists (hard-deadlock detection declines by contract `05` §1);
- `retireWorkspace` is blocked by this very unresolved incoming binding (P0
  `blocksRetire`, workspace.ts:341-355), so the producer-loss rule never fires;
- MarkedUnfulfillable/Withdraw only arrive via human/parent governance cognition
  (S3 step 12) — nothing surfaces the condition automatically.

Net effect: permanent silent waiting, which invariant No.55 exists to prevent.

## Adjacent same-genus hole (same ruling scope)

`DeclareDependency` rejection set has no explicit row for a **retired** target
workspace or a **Cancelled** target work as ProducerBinding (only "not found");
`01` §2 — the dependency would be declared against a dead producer.

## Governance disposition (2026-09-21)

**DEFERRED to P10 — non-blocking.** Rationale:

- Unlike deadlock (which needs cross-Work cycle detection, hence the P7-owned
  `DeadlockAttentionRequested` fact event), the vacant condition is a **simple
  projection join**: `dependencies(state=Unsatisfied ∧ binding=WorkspaceBound(ws))
  × works(ws has no Open Work)` over canonical state. L6 can derive it without
  any new runtime event or P7-layer algorithm.
- Attention presentation/routing is P10's frozen scope (DID §11 P10: Attention;
  §6.2 L6 = "Deadlock、Attention… 可推导事实"). Realizing option 3 as a **P10
  derived Attention view** ("WaitingOnVacantProducer") keeps the semantic
  addition minimal and lands it in the phase that owns presentation.
- Invariant No.55 is satisfied through the same path as No.42: the derived view
  surfaces the silent wait to human/parent cognition; disposition remains a
  governance command (Withdraw/MarkUnfulfillable, S3 step 12), never automatic.

**Non-blocking declaration:** this deferral blocks nothing — P7 is FORMALLY
CLOSED with the limitation recorded in its wait-graph contract (`05` §1
zero-candidate branch cites this gap); P8/P9 are unaffected (no verification or
recovery semantics involved); P10 must implement the derived view and may not
descope it silently.

**P10 acceptance hook (advisory):** the P10 phase contract should include an
Attention view item for `WorkspaceBound` dependencies whose target workspace is
vacant-and-active, citing this gap as its requirement source.

The adjacent admission-time hole (declaring against a retired workspace or a
cancelled work as `ProducerBinding` target) remains covered by the P7
`DeclareDependency` rejection set's "target not found / cross-project" rows for
not-found targets; a structurally-dead-but-existing target (retired ws) is
rejected via the Workspace-lifecycle precondition already enforced in the
handler (TerminalLifecycleMutation). No residual action required.

## P7 contract stance (historical)

`05` §1 zero-candidate branch documents the limitation and cites this gap; no
runtime behavior invented during P7. Channel realization is deferred to P10 as
above.
