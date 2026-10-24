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

### WorkEpisode blocked disposition

Only a Work-bound `ExecutionEpisodeBinding` may use the accepted `wait`
control with explicit `Blocked` disposition or the Work-only
`resolve_work_blocker` control. Before settlement, every same-Episode
executable `TerminalRejected` action paired with `ToolResult.status=Denied`
must be explicitly linked either to a later successful recovery action or to
the Blocked evidence set. Missing disposition returns the typed
`UndispositionedActionFailure` correction in the same loop. A Blocked result
requires the exact P9 action evidence and typed terminal-denial category; a
Plan status or arbitrary interruption text is not evidence. No automatic
retry follows a terminal denial.

The Runtime resolves each `failedActionRef` through the pinned ProviderTurn
manifest and computes `failureFingerprint` from the exact action-definition
stableId/version/hash, route/action kind, input hash, `ToolResult.status=Denied`
and closed `TerminalActionDenial`. It computes each
`blockerId = SHA256(projectId, workId, targetWorkRevision,
failureFingerprint)`, sorts refs by step/repair/index, and rejects foreign,
non-Denied or identity-mismatched evidence. For every same-Episode Denied
executable call the Agent must supply either a later exact successful result
as its recovery disposition or include the failure ref; missing disposition
returns `UndispositionedActionFailure` in the same loop.

The only Agent-side blocker-clear control is
`resolve_work_blocker({ resolutions })`, where each resolution names one exact
`blockerId` and non-empty later `successfulActionRefs`. The Runtime binds the
current Work, revision and Execution; the Application clears each still-Open
matching blocker and appends `WorkBlockerResolved` plus the sourced action
result atomically. It is WorkEpisode-only and cannot mutate Work or any
Verification/Acceptance state.

## 2. Control loop

```text
load Execution + AgentExecutionState
↓
promote safe-boundary Steer/Queue input once into Session
↓
capture AgentStepContext
↓
prepareTurn()  ── NeedsCompaction ─→ compaction ProviderTurn
              │                       → atomic checkpoint/epoch advance
              │                       → same-step re-prepareTurn
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
typed ToolResult/ControlResult appended per action with callRef
  → successor or persisted settlement proposal
↓
ContextProjector builds latest checkpoint + recent typed frontier
↓
continue while a meaningful runnable action exists, else settle
```

`OutcomeGap` (expected outcome − established evidence) drives action selection;
the Agent does not mechanically replay an original plan (DID §8.15).

`NeedsCompaction` is never mapped directly to an Execution settlement. A
successful compaction keeps `(logicalStepNo, repairAttempt)` unchanged and must
not repeat an already settled Provider inference/action. Provider overflow can
trigger one physical compact/retry only before durable output/effect.

### AH19 bounded Work context and Conversation checkpoint continuity (DID v1.50)

For Work before its first typed checkpoint, the driver uses P2's latest-64
persisted Session-row selection and P3's existing projector without refilling
filtered rows; hard pinned C0/C1 facts and current input remain independent.
`inputFrontier` records considered rows, while context refs and
`retainedFrontier` identify only actually represented content. After a typed
checkpoint, every unsummarized typed entry after that exact checkpoint remains
in the active frontier; budget pressure runs the existing explicit compaction.

For ConversationResponseEpisode, compaction reads the separate
RootWorkspaceId-owned Conversation checkpoint and HumanMessage frontier,
including the exact claimed current message once. It cannot read or advance the
Workspace Work Session frontier. A checkpoint/binding fallback resumes the
same ResponseJob/Attempt and response episode; it does not create a retry or
repeat any settled ProviderTurn/action. ProviderNative continuation is reused
only for the exact complete binding; otherwise the owner frontier is rebuilt
portably from retained HumanMessage sources.

Under accepted S4-CONTEXT-DG-01
(`ACCEPT_S4_CONTEXT_DG_01_ASSISTANT_MESSAGE_PROJECTION_OPTION_A`), a successful
WorkspaceWork output with `finishReason=Stop`, non-empty text and no
ToolInvocations does not itself settle or complete the Work. If the existing
loop continues the same Execution to another ProviderTurn, that request must
receive the exact accepted AssistantMessage from the same
Responsibility-bound Workspace Session through the §2 DataOnly C3 projection
(or its exact active checkpoint representation). This adds no retry authority
or new loop branch; the existing finite `MAX_TURNS`, RuntimeSafetyObservation
generation, RuntimeSafety policy/counters, settlement, rate limits, and
stop/fencing rules are unchanged. Assistant text is not canonical progress, a
CompletionClaim, or settlement evidence. Context may naturally change
subsequent model-selected activity; this contract does not adjudicate
P12-DG-01 or alter its D2/D4 observation/counter semantics.

The rule is same-Session only. ConversationResponseEpisode continues to use
its separate P14/P17 RootWorkspaceId-owned Conversation history/checkpoint and
must not consume Work Session AssistantMessages.

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
- P3 supplies activity identity and observation signals; P2 owns the counters
  and the execution-wide envelope.
- **P12-DG-01 shared D2/D4 producer.** The P3 producer reports the existing
  `RuntimeSafetyObservation.durableProgress` boolean only after a newly
  committed successful terminal sourced AgentAction outcome or an attributable
  authoritative application/canonical mutation. Typed Failed/Denied/Rejected,
  Interrupted and OutcomeUnknown results remain model-visible where the
  existing path requires them but do not set progress. ProviderResult/ModelOutput,
  Session text, AgentLoopStep/cursor progression and P9 recovery/handoff records
  do not count by themselves. P2 consumes this same boolean to clear D2
  fingerprint history and reset D4 at the next new ProviderTurn boundary; the
  existing port shape and P2 counter algorithms are unchanged.
- **P12-DG-01 ProviderTurn D2 identity.** Each new ProviderTurn's exact
  PortableModelRequest and operation-specific manifest identity are compiled
  before the RuntimeSafetyGate admission and before any ProviderRuntime call.
  D2 uses an `operationKind`-namespaced form of the existing stable opaque hash
  for that path: Inference uses `compiledRequestHash`; Summary/Native compaction
  and Conversation checkpoint/overflow paths retain their existing request
  hash. The fingerprint is neither a ProviderTurnId/loop ordinal nor an
  authority fingerprint. ProviderAttempt retries remain within the admitted
  ProviderTurn and update only their existing D1/D5 observation; they do not
  create another D2/D4 admission.
- **P12-DG-01 AgentAction D2 identity.** ToolInvocation fingerprints bind the
  resolved route kind, tool/action name and canonical semantic arguments, not
  callRef or other per-invocation identity. The canonical-argument helper is
  internal to P3; its qualification requires reordered object keys to compare
  equal and materially different arguments/route/name to remain distinct. It
  does not alter P4 input hashes, RecoveryBinding, or any persisted codec.
- A P9 settled-result replay is not a new ProviderTurn boundary: it consumes
  the exact pinned result without another safety admission or Provider request.
  Old ProviderResult/Step/cursor/handoff evidence is not progress. A new
  qualifying action/effect commit made while consuming the replay may
  accumulate for the next new ProviderTurn; an unresolved effect still follows
  the existing P9 reconciliation gate.
- Every durable AgentLoopStep/action transition is a short fenced transaction.
  Long Provider/event/action loops must yield scheduling so TTL/3 renewal can
  commit; write-before-renew is only a mitigation, never a recovery mechanism.

## 6. Settlement

Before the driver returns, it persists `SettlementProposed` containing exactly
one of the DID `ExecutionSettlement` forms:

- `Completed(CompletionClaimed(...))` on a `CompletionClaim` directive;
- `Completed(Yielded(reason, waitSpec))` on a `Yield` directive;
- exact binding-specific episode result for the bound Work,
  ConversationResponse, Inbox, or Decision Episode; legacy
  `CoordinationCompleted` / `QueryCompleted` are not emitted on new writes;
- `Completed(Blocked(...))` only for an exact WorkEpisode with validated
  denied-action evidence and its explicit WorkWait request;
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

## Accepted V21 sandbox interruption handling

P3 receives P4's internal SandboxPolicyRequiredInterruption only after the
ToolInvocation intent and VerifiedRecoveryBindingV1 are durable. It preserves
the exact invocation as NotAdmitted/unsettled, Action Pending, and current
AgentLoopStep ActionsInProgress; it writes no ToolResult/Observation, cursor
advance or Provider call. Existing HumanIntervention release/wake resumes that
same action/invocation after current policy and original-target checks pass.
Repeated scans with missing/stale policy or invalid binding do not issue a
provider decision, lease or P4 dispatch. Actual provider-unavailable is
consumed only from its durable P4 ExpectedFailure, never by re-probe/re-spawn.

## Accepted pre-intent sandbox CandidateRead source (2026-10-21)

Under `ACCEPT_P10_P1_PREINTENT_CANDIDATE_READ_BOOTSTRAP_V1`, the exact
currently Pending P3 Executable Action may be the source for P4's
read-only pre-intent sandbox-policy requirement only after P4 has returned its
existing nonterminal `ApprovalRequired` result and the owning Application has
admitted the exact Pending Executable approval. The Action remains Pending at
the same `nextActionIndex`; the AgentLoopStep remains ActionsInProgress. The
P3 source is its pinned ProviderTurn, Step identity, LogicalActionId,
actionIndex, callRef, exact Action revision/input hash and exact tool identity.
P3 does not store a new candidate/requirement row or advance the cursor.

The candidate read and P1 decision do not consume, create, widen or resolve
Executable approval. P1 runs first; the human may then ResolveExecutableApproval
through its existing P1 command. The normal P4 approval claim remains the
single point that atomically persists ToolInvocation intent and consumes the
exact Approved revision. P3 supplies no source identity from Session text or
model-authored identifiers; P4/P10 re-read the pinned P3 records and exact P4
approval record. If source facts change before P1's final CAS, the exact stale
receipt binding in P1/01 applies. This source adds no P3 state, schema or
settlement variant and does not alter the P9 terminal provider-unavailable
path.
- No lease acquisition/settlement mechanics (P2).
