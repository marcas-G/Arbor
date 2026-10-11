# P37 L3 DeliverMessage Gateway Route — Implementation Result

Date: 2026-10-11
Status: **L3 scoped implementation and targeted qualification PASS; P37 remains open**

## Scope and boundary

- Base: `9d45463b0c2b2296628fa80d33aa2a79a570da89` (integrated P36).
- L3 worktree: `C:\Users\ThinkPad\.codex\worktrees\p37-gateway-l3\Arbor`.
- Added the strict `DeliverMessage/1` typed payload and Committed-result codec,
  including the 1..4096 bodyRef bound and closed payload fields.
- Added the DeliverMessage Gateway handler and production command registry
  registration. It derives the direct-parent recipient, checks deliverable
  ownership, and commits the exact Message, MessageSent(v1), Inbox admission
  and receipt through the existing Gateway transaction. Ordinary SendMessage
  remains on its existing route and result codec.
- Routed the production Deliver AgentAction through the registered Gateway
  handler using a stable MessageId and generation-scoped CommandId. The former
  direct `deliverHandler` remains only for the pending historical bypass
  reproduction; production registers `deliverMessageGatewayHandler`.
- P9 fact/outbox and P10 projection APIs are not consumed by L3. No storage
  schema, migration, port, or `docs/design/**` file was changed.

## RED → GREEN evidence

- RED: temporarily omitted the Deliver AgentAction registration from
  `makeSingleWorkspaceControlActionHandlers`; the production-route test failed
  with `production control action registry omitted Deliver`.
- GREEN: restored the registration; the route test now exercises the production
  AgentAction registry and asserts DeliverMessage submission, stable MessageId
  across generations, and distinct CommandIds.
- Gateway RED/GREEN assertions cover generation-0 `FencingRejected` receipt
  identity/resolution with zero Message/Event/Inbox effects, then generation-1
  commit for the same MessageId with one exact handover. The strict codec tests
  reject unknown fields and over-bound bodyRef. Registry parity preserves all
  26 prior commands and adds the one internal DeliverMessage v1 descriptor.

## Verification

- `pnpm build` — PASS (`tsc -b`).
- Targeted Vitest — PASS, 5 files / 27 tests:
  - `tests/application/command-result-codec.test.ts`
  - `tests/p7-deliver-primitive.test.ts`
  - `tests/p7-deliver-control-route.test.ts`
  - `tests/p7-acceptance.test.ts`
  - `apps/single-workspace/test/external-command-codec-registry.test.ts`
- `pnpm typecheck` — PASS (`tsc -b` and `tsc -p tsconfig.test.json`).
- Targeted Biome over the 12 changed source/test files — PASS.
- `git diff --check` — PASS.
- The pending direct-handler functional case is excluded by the default Vitest
  config (`tests/functional/**`); it was not run or edited. Static call-site
  inspection confirms only that pending case references the legacy direct
  handler, while production registration uses the Gateway handler.
- No full `pnpm check`, functional suite, L4 receipt-first recovery, L5 Attention
  projection/wake qualification, or L6 two-daemon process matrix was run.

## Non-claims

This qualifies the scoped L3 codec, Gateway and production AgentAction route.
It does not close P37/AH10: the P37 storage/attention integration and L4–L6
remain outstanding. No daemon takeover, receipt-first recovery, public
Attention, or P9/P10 outbox qualification is inferred from these results.
