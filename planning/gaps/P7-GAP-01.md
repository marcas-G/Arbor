# P7-GAP-01 — Vacant-workspace dependency has no attention channel (OPEN)

**Raised:** 2026-09-21, P7 contract targeted review (round 2, B-2 zero-candidate branch).
**Status:** OPEN — requires manual governance; P7 proceeds with the honest limitation recorded.

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

## Options for governance (do not implement without a ruling)

1. `DeclareDependency` rejects structurally-dead producer targets (retired ws /
   Cancelled work) — closes the adjacent hole at admission time.
2. Vacant-target declaration requires either an existing producer or an explicit
   `Manual` escalation marker (attention at declare time).
3. A deterministic derived attention ("WaitingOnVacantProducer") alongside
   DeadlockAttentionRequested — smallest semantic addition, mirrors No.55.

## P7 contract stance

`05` §1 zero-candidate branch documents the limitation and cites this gap; no
runtime behavior invented. Implementations must not add channel 1–3 on their own.
