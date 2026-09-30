# P3 — 03 Agent Loop / Execution Driver

**Authority:** DID v1.7 §6A.9, §6A.10, §8.15, §8.16A, §10.6; DID v1.7 G4.
**Status:** DRAFT (first draft for contract review).

## 1. Real `ExecutionDriverPort`

P2 froze the seam (`ExecutionDriverPort`, DID v1.7 G4) and the
execution-wide `RuntimeSafetyGate`. P3 provides the real driver:

```ts
interface ExecutionDriverPortService {
  readonly drive: (input: {
    readonly execution: Execution;
    readonly agentExecutionState: AgentExecutionState;
    readonly wakeReason: WakeReason;
    readonly context: CommandSubmissionContext;   // ExecutionOrigin
    readonly safetyGate: RuntimeSafetyGateService;
  }) => Effect.Effect<ExecutionSettlement, ExecutionDriverError>;
}
```

- The driver returns a **settlement proposal**; it never writes canonical state.
- The P2 runtime persists the proposal via `SettleExecution` (ExecutionOrigin,
  fenced). The driver itself does not call the gateway.
- The driver runs as the `ExecutionOrigin` worker for the leased generation.

## 2. Control loop

```text
load Execution + AgentExecutionState
↓
prepareTurn()  ── NeedsCompaction ─→ compaction ProviderTurn → re-prepareTurn
              ├─ GovernanceBlocked ─→ settle Interrupted/GovernanceBlocked path
              └─ Ready(PreparedModelTurn)
↓
persist AgentLoopStep Prepared + ProviderTurn intent + Manifest   (04 §3; 08)
↓
ProviderPort.runTurn → CanonicalProviderEvent stream
↓
atomically settle Provider success → AgentLoopStep ProviderResultAvailable
↓
decodeTurn() → ModelOutput + provider-neutral typed invocations
↓
idempotent sourced ModelOutput append → AgentLoopStep OutputAccepted
↓
reconstruct/validate route → action ledger → owning boundary
↓
Observation appended per action → successor or persisted settlement proposal
↓
recent durable Observations assembled as DataOnly tool messages for next turn
↓
continue while a meaningful runnable action exists, else settle
```

`OutcomeGap` (expected outcome − established evidence) drives action selection;
the Agent does not mechanically replay an original plan (DID §8.15).

## 3. `decodeTurn` and invocation routing

```ts
decodeTurn(pinnedCanonicalEvents, pinnedDecoderVersion)
  → ModelOutput + ReadonlyArray<TypedToolInvocation>
```

- `decodeTurn` reconstructs provider-neutral invocations and preserves call
  correlation; it does not construct the superseded universal AgentDirective.
- Executable calls route to P4 ToolRuntime. Control calls pass registered
  codecs in `ControlToolRegistry`, which constructs process-local AgentAction.
- Trusted Execution/authority/revision/Manifest facts come from runtime context,
  never model payload.
- `AgentLoopStepActionRecord` persists identity/hash/disposition/result refs only;
  it never serializes AgentAction. See `08` §1/§7.
- Canonical Domain mutation still goes through CommandGateway/Application.

## 4. Output Contract

- Each `ProviderTurn` is bound to one `OutputContractRef` in the Manifest
  (`02` §6); the Output Contract enumerates the structured results the turn may
  produce (directive kinds + required fields).
- Output that violates the contract is a `ModelOutputContractViolation`
  (`06` §3), handled by bounded repair — **not** a provider transport failure.
- The repair decision and complete successor identity are persisted in
  `OutputRejected` before any successor is created (`08` §4/§8).

## 5. Runtime Safety / control gating

- At every new ProviderTurn / ToolInvocation / Specialist action boundary the
  driver **must** call `RuntimeSafetyGate.admitActivity` (P2-owned, DID v1.7
  G4) and obtain `Continue`/`Stop`.
- `Stop` → the driver returns
  `Interrupted(RuntimeSafetyStop(reason))`; the P2 runtime settles; Work stays
  Open; Attention is emitted. Safety never auto-cancels Work.
- P3 supplies only activity observations (fingerprints, kind); P2 owns the
  counters and the execution-wide envelope.
- Every durable AgentLoopStep/action transition is a short fenced transaction.
  Long Provider/event/action loops must yield scheduling so TTL/3 renewal can
  commit; write-before-renew is only a mitigation, never a recovery mechanism.

## 6. Settlement

Before the driver returns, it persists `SettlementProposed` containing exactly
one of the DID `ExecutionSettlement` forms:

- `Completed(CompletionClaimed(...))` on a `CompletionClaim` directive;
- `Completed(Yielded(reason, waitSpec))` on a `Yield` directive;
- `Completed(CoordinationCompleted | QueryCompleted)` for coordination/query
  executions;
- `Interrupted(...)` on stop / safety stop / controlled interruption;
- `Failed(...)` when the recovery strategy is exhausted;
- `OutcomeUnknown(ReconciliationRequired(...))` when an external side effect is
  ambiguous (P4/P9 reconciliation).

Work completion requires `Verification PASS + Acceptance + CompleteWork` (P8),
never a model claim alone.

On resume, the persisted proposal is authoritative. The driver does not repeat
the Provider request or action that produced it; Execution Runtime submits a
current-generation SettleExecution command under P1 `07`.

## 7. Must Not Decide

- No provider transport/streaming (`01`).
- No context selection/instruction resolution (`02`).
- No tool authorization/execution (P4).
- No verification verdict or acceptance (P8).
- No canonical writes outside `CommandGateway`.
- No lease acquisition/settlement mechanics (P2).
