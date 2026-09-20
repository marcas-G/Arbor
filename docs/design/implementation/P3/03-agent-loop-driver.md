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
persist ProviderTurn intent + Manifest   (04 §3)
↓
ProviderPort.runTurn → CanonicalProviderEvent stream
↓
decodeTurn() → ModelOutput + validated AgentDirective
↓
execute AgentDirective (via its owning boundary)
↓
Observation → append Session entry
↓
continue while a meaningful runnable action exists, else settle
```

`OutcomeGap` (expected outcome − established evidence) drives action selection;
the Agent does not mechanically replay an original plan (DID §8.15).

## 3. `decodeTurn` and `AgentDirective`

```ts
type AgentDirective =
  | { readonly _tag: "InvokeTool"; readonly intent: ToolIntent }
  | { readonly _tag: "Communicate"; readonly message: OutboundMessage }
  | { readonly _tag: "DeclareDependency"; readonly spec: DependencySpec }
  | { readonly _tag: "RequestGovernance"; readonly request: GovernanceRequest }
  | { readonly _tag: "SpawnSpecialist"; readonly spec: SpecialistSpec }
  | { readonly _tag: "ProposeChildWorkspace"; readonly spec: ChildWorkspaceProposal }
  | { readonly _tag: "LoadSkill"; readonly skillId: string; readonly tier: "Summary" | "Body" }
  | { readonly _tag: "ChangeMode"; readonly mode: string }
  | { readonly _tag: "CompletionClaim"; readonly claim: CompletionClaim }
  | { readonly _tag: "Yield"; readonly reason: string; readonly waitSpec: WaitSpec };
```

- `decodeTurn` maps `CanonicalProviderEvent` (`01` §3) + the Output Contract
  into a validated directive. A `ToolCallProposed` event is **not** itself a
  directive; it must decode into `InvokeTool` (and pass tool-surface +
  Output Contract validation) or be rejected.
- Every directive carries `decisionBasisManifestId` (DID §8.19).
- A directive that changes canonical Domain truth goes through
  `CommandGateway`/Application, never a raw repository write (DID §7.6).

## 4. Output Contract

- Each `ProviderTurn` is bound to one `OutputContractRef` in the Manifest
  (`02` §6); the Output Contract enumerates the structured results the turn may
  produce (directive kinds + required fields).
- Output that violates the contract is a `ModelOutputContractViolation`
  (`06` §3), handled by bounded repair — **not** a provider transport failure.

## 5. Runtime Safety / control gating

- At every new ProviderTurn / ToolInvocation / Specialist action boundary the
  driver **must** call `RuntimeSafetyGate.admitActivity` (P2-owned, DID v1.7
  G4) and obtain `Continue`/`Stop`.
- `Stop` → the driver returns
  `Interrupted(RuntimeSafetyStop(reason))`; the P2 runtime settles; Work stays
  Open; Attention is emitted. Safety never auto-cancels Work.
- P3 supplies only activity observations (fingerprints, kind); P2 owns the
  counters and the execution-wide envelope.

## 6. Settlement

The driver returns exactly one of the DID `ExecutionSettlement` forms:

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

## 7. Must Not Decide

- No provider transport/streaming (`01`).
- No context selection/instruction resolution (`02`).
- No tool authorization/execution (P4).
- No verification verdict or acceptance (P8).
- No canonical writes outside `CommandGateway`.
- No lease acquisition/settlement mechanics (P2).
