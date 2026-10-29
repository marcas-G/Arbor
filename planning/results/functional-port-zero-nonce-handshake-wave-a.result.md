# Functional port-zero nonce handshake — Wave A

Date: 2026-10-10

Base: `f896451e714a3d180825f14d4eef5640cd9b45bf`.

## Read-only audit

`tests/functional/support/production-fixture.ts` selected an OS port with
`freePort()` (`listen(0)`, read `address().port`, then close), then started the
daemon on that now-unreserved port. Its readiness check retried `GET /` and
accepted any `response.ok`; it did not bind the response to the spawned child,
and restart reused the same port. This left both a reserve/close/bind race and
the possibility of mistaking an unrelated responder for the new daemon.

The daemon already accepts `webTransport.port = 0`: `startWebTransport`
returns `WebTransportHandle.port` after the successful `listen` callback.
`runProductionDaemon` previously consumed that handle without exposing its
actual port. No HTTP nonce echo or public test route is necessary: the new
process-local observer reports only after its own server has bound, and the
parent checks the report's PID against the exact spawned `ChildProcess` and
requires that process to remain alive before probing the reported port.

## Change

- Added optional, production-neutral `onWebTransportListening(port)` lifecycle
  observation to `ProductionDaemonRunConfig`. It receives the actual bound
  port, including for requested port zero; observer exceptions do not affect
  daemon startup. No nonce, test flag, or route was added to production wire or
  environment semantics.
- Added `tests/functional/support/nonce-daemon-child.mjs`. The child generates
  its own UUID nonce and PID, reports `FUNCTIONAL_DAEMON_STARTED`, then reports
  `FUNCTIONAL_DAEMON_LISTENING` with the same nonce/PID and actual port from the
  listen observer.
- Added opt-in `isolatedPortHandshake` to the functional fixture. It starts the
  first ordinary daemon on port zero; the parent accepts only a valid child
  UUID, matching nonce across both reports, exact spawned PID, valid actual
  port, and live child. It then probes that actual port and requires an OK
  response while the child remains alive. A restart reuses that fixture's
  random first port to preserve existing clients, but must perform a fresh
  nonce/PID handshake. An opted-in additional daemon uses port zero and the
  same handshake only for the ordinary production entry; custom entries fail
  closed until migrated.
- Migrated only the first F23 malformed-`MessageId` process case in
  `tests/functional/process/command-input-validation.functional.test.ts`; it
  asserts the two reports share nonce/PID and that reported port equals the
  fixture URL.

## Verification

- `pnpm typecheck`: PASS.
- Biome on the four changed source/test files: PASS.
- `pnpm --filter @arbor/web build`: PASS (existing bundle-size warning only).
- Focused functional case under `vitest.functional.config.ts`: PASS, 1/1.
- Three independent Vitest processes ran that same single case concurrently:
  PASS, 1/1 each. The explicit assertion checked each process's nonce/PID bind
  report and actual fixture port. Two other cases in that file were skipped by
  the name filter.
- No complete functional suite or `pnpm check` was run.

This proves only the opt-in ordinary-daemon startup path. It does **not** prove
that the functional catalog is safe to shard or that all crash/restart and
additional-daemon entries use nonce-bound readiness.

## Remaining fixture entrypoints and migration order

The fixture-wide legacy port/readiness path remains the default. There are 36
functional files calling `startProductionFixture`; only one case in command
input validation opts in. Remaining call sites are:

- `tests/functional/pending/ah10-submitted-decision-binding-integrity.functional.test.ts`
- `tests/functional/pending/ah14-ambiguous-legacy-attention.functional.test.ts`
- `tests/functional/pending/f21-create-project-profile-process.functional.test.ts`
- `tests/functional/pending/f23-exact-tuple-receipt-integrity.functional.test.ts`
- `tests/functional/pending/resource-admission.functional.test.ts`
- `tests/functional/process/agent-action-ah7-pending-intent.functional.test.ts`
- `tests/functional/process/agent-action-ah7-reconcilable.functional.test.ts`
- `tests/functional/process/agent-loop-ah7-b-effect-before-settlement.functional.test.ts`
- `tests/functional/process/agent-loop-ah7-b-intent-before-effect.functional.test.ts`
- `tests/functional/process/agent-loop-ah7-two-action-interleaving.functional.test.ts`
- `tests/functional/process/agent-loop-ah8-action-b-stale-after-restart.functional.test.ts`
- `tests/functional/process/agent-loop-ah9-terminal-action-recovery.functional.test.ts`
- `tests/functional/process/agent-loop-ah10-assign-work-takeover.functional.test.ts`
- `tests/functional/process/agent-loop-ah10-direct-child-assign-work-receipt-binding.functional.test.ts`
- `tests/functional/process/agent-loop-ah10-direct-child-assign-work-takeover.functional.test.ts`
- `tests/functional/process/agent-loop-ah10-generation-takeover.functional.test.ts`
- `tests/functional/process/agent-loop-ah10-select-current-work-takeover.functional.test.ts`
- `tests/functional/process/agent-loop-ah10-send-message-takeover.functional.test.ts`
- `tests/functional/process/agent-loop-ah11-step-effects-crash.functional.test.ts`
- `tests/functional/process/agent-loop-ah12-settlement-command-crash.functional.test.ts`
- `tests/functional/process/agent-loop-ah13-conversation-convergence-crash.functional.test.ts`
- `tests/functional/process/agent-loop-ah14-legacy-adoption-crash.functional.test.ts`
- `tests/functional/process/ah15-inbox-input-promotion-crash.functional.test.ts`
- `tests/functional/process/ah17-checkpoint-epoch-crash.functional.test.ts`
- `tests/functional/process/ah18-overflow-linked-compaction-resume.functional.test.ts`
- `tests/functional/process/ah19-provider-native-binding-recovery.functional.test.ts`
- `tests/functional/process/command-input-validation.functional.test.ts` (the
  `acp_` and historical-receipt cases remain on legacy startup)
- `tests/functional/process/cross-work-delivery.functional.test.ts`
- `tests/functional/process/cross-work-wake.functional.test.ts`
- `tests/functional/process/f23-receipt-tuple-ordering.functional.test.ts`
- `tests/functional/process/human-steer.functional.test.ts`
- `tests/functional/process/model-output-ah5-ah6.functional.test.ts`
- `tests/functional/process/organization.functional.test.ts`
- `tests/functional/process/provider-failure-ah4.functional.test.ts`
- `tests/functional/process/provider-success-ah1-ah3.functional.test.ts`
- `tests/functional/process/recovery-verdicts.functional.test.ts`

Custom fixture entries require explicit migration before those tests can opt
in:

1. The shared `tests/functional/support/ah-crash-child.mjs` is used by AH7 and
   AH8/AH9/AH11–AH15 plus Provider AH1–AH6 test cases; its consumers include
   `agent-action-ah7-pending-intent`, `agent-action-ah7-reconcilable`,
   `agent-loop-ah7-b-effect-before-settlement`,
   `agent-loop-ah7-b-intent-before-effect`,
   `agent-loop-ah7-two-action-interleaving`,
   `agent-loop-ah8-action-b-stale-after-restart`,
   `agent-loop-ah9-terminal-action-recovery`,
   `agent-loop-ah11-step-effects-crash`,
   `agent-loop-ah12-settlement-command-crash`,
   `agent-loop-ah13-conversation-convergence-crash`,
   `agent-loop-ah14-legacy-adoption-crash`,
   `ah15-inbox-input-promotion-crash`, `provider-success-ah1-ah3`,
   `provider-failure-ah4`, `model-output-ah5-ah6`, and pending
   `ah14-ambiguous-legacy-attention`.
2. `tests/functional/support/ah10-process-child.mjs` is used by the AH10
   takeover, SelectCurrentWork, SendMessage, direct-child and receipt-binding
   tests, including pending `ah10-submitted-decision-binding-integrity`.
   Their `restart` and `startAdditionalDaemon` paths must all report a fresh
   nonce/PID/actual port before those files can shard.
3. Other custom restart entries are
   `ah17-compaction-crash-child.mjs` in
   `ah17-checkpoint-epoch-crash`, `ah18-overflow-crash-child.mjs` in
   `ah18-overflow-linked-compaction-resume`, and
   `ah19-native-daemon-child.mjs` in
   `ah19-provider-native-binding-recovery`; migrate these after the shared AH
   children. `ah18` also restarts via `ah-crash-child`.
4. `ah10-p10-attention-materialization.functional.test.ts` launches
   `p10-attention-daemon-child.mjs` directly and waits on a private marker file;
   it does not use the HTTP fixture port, so it needs a separate child-lifecycle
   audit rather than pretending it is covered by this handshake.

Priority: migrate ordinary production-daemon fixture call sites first; then
the shared AH crash child; then AH10 restart/additional children; finally the
special AH17/AH18/AH19 entries and direct-spawn P10 lifecycle. Until all child
starts in a candidate shard have exact process-bound readiness, those tests
must remain serial. F20 clean-checkout and Playwright/browser journeys remain
serial regardless of this change.
