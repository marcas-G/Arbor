# AH7-DG-03 L4 process qualification matrix

Scope: real process kill/restart qualification of the already accepted P4/P3/P9
contracts. This matrix is not phase-closure evidence until every row is run and
the final L4 result is recorded.

## Durable stage matrix

| Stage / commit boundary | Before-commit kill state | After-commit kill state | Restart invariant / primary evidence |
|---|---|---|---|
| P4 approval claim: intent + exact approval consume | Neither row nor consumer is durable. | Exact intent + `consumed_by = ToolInvocationId`, `NotAdmitted`. | Before branch may attempt a new claim; after branch reuses only the same invocation and never consumes a second time. |
| P4 no-effect Denied | No denial row/update; approval is unchanged. | One terminal Denied row with `NotAdmitted` and version-1 projection. | Replay same reason/identity; no Executor, no approval release/reassignment. |
| P4 NotAdmitted Interrupted | No interruption settlement. | One terminal Interrupted row; approval remains exactly as at claim. | Replay same Interrupted; no Executor; P3 proposes StopRequested once. |
| P4 effect admission | `NotAdmitted`. | `MayHaveStarted` is durable before Sandbox/Executor. | A pre-commit crash can attempt the gate again; post-commit recovery follows side-effect semantics and cannot rewrite Denied/Interrupted. |
| External effect | Depends on exact `SideEffectSemantics`; admission alone means may have started. | Effect may have completed without P4 settlement. | No blind replay after `MayHaveStarted`; query/replay only for ReadOnly/Idempotent, reconcile Reconcilable, fail closed NonIdempotent. |
| P4 settlement | Unsettled invocation. | One canonical settlement, fenced by the complete Worker lease tuple. | Replay stored terminal result; stale generation cannot settle or append Observation. |
| P3 ToolResult + Action + cursor transaction | No P3 sourced ToolResult/action/cursor delta. | One ToolResult/Observation source, terminal action state and cursor delta. | Before-commit crash rolls all three back; after-commit crash replays from the durable source without a duplicate ToolResult or handler/effect. |

Every applicable scenario checks the same `(ExecutionId, ProviderTurnId,
LogicalActionId, callRef, ToolInvocationId)`, exact approval `consumed_by`,
current/stale generation fence, effect count, ToolResult count/source, action
state and cursor from one coherent SQLite snapshot. Cases with no P4 row before
claim explicitly assert that absence.

## Reusable process harness

`tests/functional/support/production-fixture.ts` already provides the minimal
production harness faces: `crash`, `restart`, and `startAdditionalDaemon`. The
existing `agent-action-ah7-pending-intent.functional.test.ts` also exercises
the four AH7 action-intent/tool-intent/tool-settlement/action-result probes
with one real daemon restart. The settlement-fencing test demonstrates the
two-daemon pattern: hold/fence generation 0, expire its lease, start a second
daemon on the same DB, acquire generation 1, then release the old process and
assert its settlement is fenced.

The first P4 storage batch is prepared as a separately labelled
**store-process** runner over file-backed SQLite:
`tests/functional/process/agent-action-ah7-p4-store-process-crash.functional.test.ts`
starts `tests/functional/support/ah7-p4-store-crash-child.mjs`. The parent
seeds the fixture, an independent Node child uses production
`ToolInvocationStoreLive` + `TransactionPortLive`, and test-only probes park
inside a transaction just before COMMIT or directly after COMMIT. The parent
SIGKILLs the child, inspects from a separate read connection, then starts a
fresh child to retry/replay. This can prove real SQLite process crash atomicity
for claim/Denied/Interrupted; it must not be reported as a production daemon or
external-effect qualification. The six claim/Denied/Interrupted before/after-
COMMIT branches passed the hardened 1/1 targeted run with keepalive/alive
handshake and exact SIGKILL exit assertions. See
`planning/results/AH7-DG-03-L4-store-process.result.md`.

The exact `NotAdmitted → MayHaveStarted` boundaries are qualified using the
real public daemon fixture and a `requiresApproval=false` shell invocation.
The Reconcilable and NonIdempotent branches distinguish known pre-effect from
MayHaveStarted ambiguity. See
`planning/results/AH7-DG-03-L4-effect-admission-takeover.result.md`.

The following effect, settlement, Observation, Action and cursor rows are also
qualified; see
`planning/results/AH7-DG-03-L4-effect-settlement-observation.result.md`:

- Idempotent patch external effect followed by P4 settlement crash/restart;
  same-identity replay preserves each file marker exactly once.
- P4 settlement process crash before transaction, after the settlement write
  but before COMMIT, and after COMMIT.
- P3 Session ToolResult + Action + cursor crash after writes/before COMMIT and
  after COMMIT. The exact ToolResult `observationRef` equals the persisted
  Action `observation_source_ref` and Session source, exactly once.
- Actual NonIdempotent effect before settlement under two-daemon lease
  takeover: old generation is fenced, the marker is not replayed and the new
  generation converges to OutcomeUnknown without a success Observation.
- MayHaveStarted recovery is separately qualified for Reconcilable and
  NonIdempotent; neither starts a new Executor call.

These remain separate evidence categories: store-process, one-daemon
crash/restart, two-daemon takeover, and external effect count. AH7 remains open
for active Reconcilable reality reconciliation, further side-effect/action
permutations and approved Executable routing.

## Approval-flow qualification boundary

The production `ExecutableToolHandler` currently constructs
`ToolIntent.approvalId = null`; there is no existing public/daemon path that
binds a newly model-authored call to an `InvocationApproval`. This L4 batch
therefore exercises real atomic claim and consumer rows at the P4 store/process
boundary using the exact accepted API, while preserving the already existing
runtime unit proof of claim ordering. It does not claim end-to-end public
approval claim qualification or introduce an approval injection route. If the
manual reviewer requires an actual daemon-originated approved executable call,
that requires an explicit ownership/contract path and must be raised as a
separate design gap rather than added as a test bypass.
