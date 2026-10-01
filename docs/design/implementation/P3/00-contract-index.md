# P3 — Contract Index

**Authority:** DID v1.22, with P3 phase contracts frozen under prior DID
versions except where this index records v1.18, v1.20 and v1.22 supersessions.
These documents are **not** a fifth design layer; they are P3-owned
implementation contracts authorized by DID §13.

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
