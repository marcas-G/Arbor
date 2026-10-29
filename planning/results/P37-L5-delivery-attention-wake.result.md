# P37 L5 — Deliver Attention and Parent wake implementation checkpoint

Date: 2026-10-11

Base: `80f10551cb11825cd207131fcd9f0ab665c38a62` (integrated P36 + P37 L2/L3)

Status: **implementation checkpoint; functional and process qualification pending**

## Implemented

- The P10 Attention poll now exposes an optional process-local qualification
  boundary after its data transaction commits. Each affected Deliver fact is
  reported once, after marker, outbox ACK, P1 offset and successful poll-claim
  settlement are durable. `SingleWorkspaceConfig` conditionally forwards the
  optional hook to `ProductionDaemonServiceLive`; ordinary production startup
  leaves it absent.
- The SQLite Deliver marker writer reuses the existing P10 pre-commit probe
  after validating and inserting/verifying the source-specific marker. This
  gives process qualification an exact marker-written-before-transaction-commit
  boundary.
- The Attention poll avoids writing/verifying a Deliver marker twice in one
  transaction when the same fact appears in both the event batch and P9
  pending outbox. It still ACKs only after the marker exists.
- Added test source for the real SQLite poll and P10 read model. It creates a
  P9 Deliver failure fact/event through `recordDeliverReplayFailure`, runs the
  production poll coordinator, checks the exact fact-id key, owning Execution
  Workspace, `ActionRequired`, typed failure code and fixed safe summary, and
  verifies the blocked handover creates no Message, Inbox entry or MessageSent
  event. It then removes the event and marker and checks full rebuild restores
  the row from the retained P9 fact.
- Added application test source asserting the post-commit qualification hook
  runs after marker, ACK, offset and poll-claim settlement.

Successful Deliver parent wake remains driven by the existing committed
`MessageSent(v1)` WorkflowSignalConsumer mapping to `ChildDelivered`; this
change adds no separate wake row or competing wake source.

The L6 process child supplies the optional config hook and pauses at the exact
post-commit callback:

```js
const attentionPollQualificationProbe = async (event) => {
  if (event.boundary === "P10AfterDeliverAttentionConsumerCommit") {
    emit(event);
    await holdConfiguredBoundary(event.boundary, event);
  }
};
```

That source is in `tests/functional/support/p37-deliver-process-child.mjs` in
the L6 worktree. Its child config passes `attentionPollQualificationProbe`;
the composition field now carries that callback into the running P10 poll.

## Static verification

- `pnpm typecheck` — PASS (`tsc -b` and `tsc -p tsconfig.test.json`).
- Targeted Biome check of the five changed TypeScript files — PASS.
- `git diff --check` — PASS.
- Per the staged-test strategy, no Vitest, daemon, functional suite or full
  repository gate was run. The new tests are source only at this checkpoint.

## Remaining qualification

P37 L6 still needs the two-daemon crash/restart matrix at the pre-commit marker
and post-commit poll boundaries, plus the recovery and stale-generation cases.
This checkpoint does not claim L5 runtime qualification or P37/AH10 closure.
