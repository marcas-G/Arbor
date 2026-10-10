# F23 Receipt Integrity — Wave 2

Status: implemented in this isolated candidate; not merged or pushed.

## Implementation

Receipt-first prior consumers now check the fetched row's exact prior
`CommandId` and expected `ProjectId` before JSON decoding. They select the
trusted `CommandType` and current `schemaVersion` from the Composition-owned
`CommandHandlerRegistry`, then reuse Wave1's strict result/rejection decoder.
The six control routes are pinned explicitly: AssignWork, AcceptWorkOutcome,
SendMessage, SelectCurrentWork, DeclareDependency, and ProduceDeliverable.
Missing command registry/handler or malformed prior JSON/result/rejection
fails as a non-retryable operational error; it cannot be interpreted as a
model-authored rejection or successful Observation.

For the direct-child AssignWork `assignWorkReplay` route only, a committed
receipt decode failure is routed through the existing P9 `ReceiptMismatch`
fact/event transaction and ends as `AgentActionRecoveryBlocked`. This includes
both raw syntax failure (A1) and JSON-valid wrong result shape (A2). The
helper does not expose the raw result or decoder cause. Exact proof-valid
results continue to binding verification; existing specific B binding/effect
failure codes are unchanged. Ordinary prior consumers do not create the P9
AssignWork fact.

The production Composition supplies `CommandHandlerRegistry` to the control
action handlers. Unit fixtures for those routes now provide trusted schema-v1
handler descriptors and complete current result DTOs; these are fixture
corrections, not relaxed decoder rules. No design, Gateway tuple-order,
CommandStore, transport, P10 source, or diagnostic-sink change was made.

## Qualification

### RED evidence before implementation

- The pending ordinary AH10 wrong-shape Committed receipt case failed because
  the prior receipt was returned as a successful `Observation` rather than a
  failure.
- The pending direct-child A1 case failed with zero `ReceiptMismatch` fact
  writer calls when `result_json` contained malformed JSON.
- The new real-transaction failure test then proved the failure boundary: an
  aborted fact insert rolls back both the new fact and its event and leaves
  the corrupt old receipt unchanged.

- `pnpm typecheck` — PASS.
- Biome on all Wave2 code/test files — PASS.
- `tests/application/command-result-codec.test.ts` — 4/4 PASS (Wave1
  regression).
- P1 tuple-first raw JSON ordering — 1/1 PASS.
- Pending exact-tuple HTTP wrong-shape tests remain 2/2 PASS from Wave1.
- Pending ordinary AH10 wrong-shape prior receipt asserts operational failure,
  not successful Observation — PASS.
- Pending direct-child A1 unit route observes `ReceiptMismatch` and
  `AgentActionRecoveryBlocked` without raw sentinel or Gateway invocation —
  PASS.
- Real SQLite P9 fact-store failure injection (trigger abort at fact insert)
  — PASS: the fact/event transaction rolls back both rows, the old malformed
  receipt remains byte-for-byte unchanged, no Gateway submission occurs, and
  the handler fails closed as an operational failure.
- Real two-daemon direct-child A1 process cases — before-fact-commit kill /
  restart 1/1 PASS; after-fact-commit kill / restart 1/1 PASS. Each converges
  to one immutable `ReceiptMismatch` fact and one matching event; pre-commit
  kill leaves neither fact nor event before restart. The action remains
  Pending without Observation/Applied, the original committed receipt row is
  not repaired, no second action Command/WorkAssigned effect is created, and
  the corruption marker is absent from the fact/event.
- Real two-daemon direct-child A2 JSON-valid wrong-shape receipt — 1/1 PASS,
  same P9 `ReceiptMismatch` durable disposition.
- AH10 receipt-first unit suite + legacy raw-ID replay — 27/27 PASS.
- I0 SendMessage, MAC-P2 AcceptResult, MAC-P3 dependency delivery, and
  verification-control action tests — 14/14 PASS.
- Full `pnpm check` was not run.

The existing AH10 `corrupt-sibling` scenario remains the B binding-mismatch
qualification with its existing specific P9 failure code; it was not rerun in
this Wave2 turn. This Wave2 run does not claim a new B qualification.

## Explicit boundaries / follow-up

- P10 generic corruption Attention and an operator-visible diagnostic sink
  remain OPEN. This work adds neither a generic source nor a logging/diagnostic
  port.
- P9 A1 handling preserves the internal `PersistenceCorruption` category only
  as the decoder failure routed into the existing P9 fact path. The fact
  stores the fixed failure code and identity, never raw JSON/parser text. If
  writing the fact transaction fails, the transaction leaves neither fact
  nor event and the handler fails closed; no committed fact is implied.
- The concurrent F21 candidate adds `ProjectResourceUnavailable{commandId}`
  and CreateProject handler schema v2. This tree intentionally does not add
  those unmerged contracts; integration must extend the rejection decoder and
  add the CreateProject v2 result decoder/example before claiming that version
  supported.
