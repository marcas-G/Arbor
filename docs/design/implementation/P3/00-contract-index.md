# P3 — Contract Index

> **MAC successor (DID v1.31):** the common Agent Loop, typed timeline and
> Provider recovery remain. `LocalPlan`, one model ActionCall facade, typed
> consumer errors and active legacy isolation are governed by
> `docs/design/implementation/MAC/**`; conflicting new-write clauses here are
> superseded.

**Authority:** DID v1.28, with P3 phase contracts frozen under prior DID
versions except where this index records later supersessions.
These documents are **not** a fifth design layer; they are P3-owned
implementation contracts authorized by DID §13.

## Accepted owner amendment — AH7-DG-03 (2026-10-10)

Decision: `ACCEPT_TOOL_APPROVAL_SETTLEMENT_ATOMICITY`. Accepted proposal SHA-256:
`E818CC208F6A3B233FEF213E54E02AA30A1E96D6147313870C75FDE38DC94CBE`;
source and delegated decision record are
`planning/proposals/AH7-approval-settlement-fixed-decision-draft.md` and
`planning/results/AH7-DG-03-governance-acceptance-and-landing.review.md`.

P3 `08` now specifies how P4 no-effect Denied and stop/quiescence Interrupted
results converge to the action ledger, sourced ToolResult, remaining-action
disposition, cursor and Execution settlement proposal. Denied resolves only
the current action; `ExecutionStopping` closes the action batch as
`Interrupted(StopRequested)`. This amendment does not change the AgentLoopStep
identity or provider-result authority.

## Accepted owner amendment — EA-DG-01 (2026-10-11)

Decision `ACCEPT_EXECUTABLE_APPROVAL_ISSUANCE_DECISION_RESUME`, fixed proposal
SHA-256 `E4F1B2935E0397292049BB3FDB1AB5847B02443CCE1B55A9827F823C63F145EB`.
P3 `08` freezes the Executable `ApprovalRequired` pause: same active
Execution/AgentLoopStep/LogicalAction remains Pending, cursor does not advance,
lease is released, and the pinned Provider result is replayed locally after
Approve/Reject/Expire/Cancel. It does not create a new ProviderTurn. Acceptance
and landing audit are
`planning/results/EA-DG-01-governance-acceptance.md` and
`planning/results/EA-DG-01-contract-landing.result.md`.

## Accepted owner amendment — AH7-DG-02 (DID v1.40)

Accepted logical proposal SHA-256:
`D0A43BCDF3F95424BE7167B49D2170917B7605EE1E498A2601F2FFFB3DD6940B`;
accepted P39 physical supplement SHA-256:
`D2FF13087BB7A1BC5C9D422B4D5CEDE56689F83E765F96615FE13561CE5D446C`.
P3 `08` owns Runtime production and forwarding of
ProviderTurn/AgentLoopStep/LogicalAction/actionIndex/callRef source binding,
and the exact P4 `ReconciledNoEffect`/StillUnknown → ToolResult/Observation/
Action/cursor mapping. P4 remains owner of approval facts, external reality
proof, attempts, facts and settlement; P3 identity and cursor ownership do not
move. Implementation and crash qualification remain separately gated.

## Accepted owner amendment — AH7-DG-01 / P39-P40 terminal RNO replay (DID v1.41)

Accepted hashes: DG01 logical `19EFED54E037D3E2EC6F4D273D917F5249195650E5E41B3DCFF8DEB9784F29CD`;
P40 physical `5B61E0FF922A10D225FD5DAEA00176BD16C5C0B39484D626B7FEF6340516373A`;
P39/P40 compatibility addendum `8B8E5D3C5729CF5619605DA8D8DF34BA00E1F817E80A743555029F331690E830`;
matrix `AD9AB72D0AA51AB84F4194EC2BF4BB90EC957BD062788C480BCBDD39B8E8DD35`.
P3 `08` owns unchanged ProviderTurn/AgentLoopStep/action/callRef source
identity and atomic ToolResult/Observation/Action/cursor convergence. P4's
P40 envelope is the only replay authority for P39 `ReconciledNoEffect`;
`ReconciliationFactRef`, P4 ArtifactRef and P3 content hash/source ref remain
distinct. P39 selected-fact identity does not move. Missing valid-fence RNO
evidence blocks P3 projection; stale generations remain ownership loss only.

## Accepted owner amendment — AH10 Submitted DecisionEpisode binding failure (DID v1.42)

Fixed proposal SHA-256:
`10D5A2532810B65DFBD3E397B141F6C0765AD32F4992BDDD0FE17F468975339A`;
acceptance/landing audit:
`planning/results/AH10-submitted-decision-binding-P41-governance-acceptance-and-landing.md`.
P3 `08` classifies only the exact submitted DecisionRequest Workspace and
settled Provider-result Manifest mismatches before any new Provider, action,
Command, Observation or ordinary transition. For an authorized Stop it returns
only the pure close plan expressed with existing `TerminalRejected`,
`SkippedEarlySettlement`, and `SettlementProposed(Interrupted(StopRequested))`
states. P3 never reads/writes the P9 fact store; Recovery/Application
composition owns the cross-store transaction. No new P3 state, event,
settlement variant, package edge, or implementation authorization is added.

```text
Detailed Implementation Design v1.22 (frozen)
        ↓ delegates phase-scoped closure
docs/design/implementation/P3/**   (these contracts)
```

**DID v1.18 ACR supersession:** P3 `01-provider-contracts.md` §3,
`02-model-context-contracts.md` §6, `03-agent-loop-driver.md` §§2–4, and
`06-provider-failure-repair.md` §4 are retained as historical AgentDirective
contract records. Their statements that `decodeTurn` produces/validates a
universal `AgentDirective`, that the union is the model-facing Output Contract,
or that `decisionBasisManifestId` is a model/action payload field are
superseded by DID v1.18 ACR-1–ACR-5. Provider-neutral event semantics, the P3
loop, P2 safety gate, Application boundary, settlement, freshness rules, and
bounded-repair semantics remain authoritative where they do not depend on that
superseded representation.

**DID v1.22 SCRC supersession:** `PortableMessage` is no longer the universal
request carrier; `01` uses `PortableInputItem`. `02` §1's plain `role:tool`
Observation and every-turn unconsumed Inbox injection are superseded by typed
callRef-paired results and source-key atomic Session promotion. `03` §2's plain
Observation continuation is superseded by the typed Session frontier.
DataOnly trust, explicit Compaction ProviderTurn, AgentLoopStep durability,
authority and settlement contracts remain in force.

**DID v1.28 EGP supersession:** Agent Runtime has one loop and no Coordination
mode. TurnProfile/Context/settlement are derived from exact EpisodeBinding.
`WorkspaceCoordination`, `workspace-coordination-context-v1`, and any branch
that infers conversation or tools from missing WorkId are historical. Plan is
optional tool-maintained progress state and never an output/authority contract.
P41 does not change EGP DecisionEpisode creation or settlement; it only adds
the downstream exact binding-integrity recovery disposition owned by P3 `08`,
P9 `07`, and P2 `06`.

## Documents

| Doc | Owns |
|---|---|
| `01-provider-contracts.md` | `ProviderPort`/`ProviderRuntime`, `CanonicalProviderEvent` ADT, `ModelCapabilityPort`, provider failure model, `provider_turns`/`provider_attempts` semantics |
| `02-model-context-contracts.md` | `prepareTurn`, six surfaces, `InstructionFragment` + resolver, C0–C6 layers, retention/budget, Skills surface, Compaction ProviderTurn protocol, `ModelContextManifest` |
| `03-agent-loop-driver.md` | historical universal AgentDirective decode/output bridge; retained P3 control-loop, safety, repair, and settlement requirements as limited by DID v1.18 |
| `04-sqlite-schema.md` | `provider_turns`, `provider_attempts`, `model_context_manifests`, Session entry content types |
| `05-prompt-context-contracts.md` | versioned Prompt Program artifacts, provenance, model-family compiler |
| `06-provider-failure-repair.md` | failure translation, bounded repair, `ContextUnsatisfiable`, `DecisionStale`, `GovernanceBlocked` |
| `07-behavioral-eval-harness.md` | shared Prompt/Context behavioral-eval harness; per-phase ownership of programs/eval cases/acceptance |
| `08-agent-loop-step-handoff.md` | DID v1.20 durable AgentLoopStep identity/state machine、Provider success replay、idempotent Session/action progression、successor/settlement handoff |
| `09-runtime-decomposition.md` | explicit epoch/monotonic RuntimeClock and behavior-preserving Agent Driver decomposition |
| `00-contract-index.md` | this index |

## P3 scope (DID §11 P3)

`ProviderPort / ProviderRuntime`, `ModelCapabilityPort`, Model Context v1,
Base Agent Protocol, Responsibility-bound Protocol, Work Execution Program,
Output Contract, Prompt provenance, real model multi-turn continuity.

## Phase-ownership decisions (C1–C4 + correction)

| # | Decision |
|---|---|
| C1 | **P3** owns the Skill surface / loading / provenance / progressive-disclosure contract; concrete Skill content and behavior belong to their feature phase (P6/P8/…). |
| C2 | **P3** owns the explicit Compaction ProviderTurn semantic protocol (request/result/output validation); **P2** keeps the Session/Epoch/Checkpoint durable persistence seam; numeric thresholds are empirical. |
| C3 | **P3** establishes the shared Prompt/Context behavioral-eval harness; each phase owns its own Prompt Program text, eval cases and acceptance criteria. |
| C4 | `CanonicalProviderEvent` remains provider-neutral transport/runtime vocabulary. It does not directly express an authorized `AgentAction`; `decodeTurn` extracts `ModelOutput` and generic typed `ToolInvocation` values, while ControlToolRegistry owns control semantics (DID v1.18 ACR-4). |
| C5 | Prompt Program **actual text** is **not** implementation choice. The Programs P3 uses (Base Agent Protocol, Responsibility-bound Protocol, Work Execution Program, Compaction, …) are versioned phase-scoped **contract artifacts** with regression eval. Only wording iteration that does not change the contract, and numeric defaults, are empirical. |
| C6 | DID v1.20 `AgentLoopStep` is the durable handoff state. It persists no process-local `AgentAction`; pinned Provider events + decoder reconstruct invocations and the action ledger verifies identity/hash (`08`). |
| C7 | DID v1.22 freezes typed Session Timeline, safe-boundary promotion, AgentStepContext/ContextProjector, Summary/ProviderNative compaction and provider-aware budget evidence. Migration 0019 and implementation remain unauthorized. |

## Inherited from P2

- `ExecutionDriverPort` seam + `AgentExecutionState` + `RuntimeSafetyGate` (DID v1.7 G4).
- `session_entries` storage (P2) with P3-owned entry content types.
- `WorkWait` / `WaitSpec` / `WakeCondition` / `WakeReason` (P2 `05`).
- Admission binding, lease/fencing, `Settlement`, `RecoveryController`.
- `ReconciliationSource` stub → P3/P4 provide Provider/Tool reconciliation content.
- DID v1.20 idempotent Session source write + fenced `AgentLoopStepStore` are P2
  persistence seams; P3 owns their orchestration (`08`).

## Contract review (round 1)

| # | Finding | Classification | Resolution |
|---|---|---|---|
| F1 | `SecretRef` / `CancellationRef` / `CacheHint` ownership ambiguous | P3 phase-scoped | `SecretRef` is a P3 `ports` type; `ProviderTurnId` is a domain ID; `CancellationRef`/`CacheHint` are P3 port types (`01` §2) |
| F2 | `SkillRegistry.available` used an undefined `ResponsibilityId` | P3 phase-scoped | keyed by `AgentBinding + WorkspaceId` (`02` §7) |
| F3 | `PromptProgramFamily` referenced but undefined | P3 phase-scoped | defined as the DID §8.4 P1–P14 family union (`05` §1) |
| F4 | `SkillRegistry` service tag vs type naming | implementation choice | Context.Service tag `SkillRegistry`; `R` lists tags (`02` §1) |

**Blocking = 0.** No open P3 Design Gap. The four findings are phase-scoped or
implementation choices, all resolved in-contract.

## Status

FROZEN (contracts) — independent review round 1 complete, **Blocking = 0**.
No P3 planning is generated until the phase plan + tasks are derived from these
contracts.

The v1.20 `08` successor is design-frozen; DID v1.21 ALS-I1 authorizes its
implementation without reopening the historical P3 completion record.

The v1.22 SCRC successor is design-frozen but implementation is **not
authorized**. It supersedes only the representations and delivery/compaction
mechanisms named above; historical P3 completion remains an audit fact, not
SCRC implementation evidence.
