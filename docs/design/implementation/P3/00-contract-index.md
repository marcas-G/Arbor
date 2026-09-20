# P3 — Contract Index

**Authority:** DID v1.7 (phase-scoped closure). These documents are **not** a
fifth design layer; they are the P3-owned implementation contracts authorized
by DID §13. No DID bump: the decisions below assign phase ownership under
existing DID semantics.

```text
Detailed Implementation Design v1.7 (frozen)
        ↓ delegates phase-scoped closure
docs/design/implementation/P3/**   (these contracts)
```

## Documents

| Doc | Owns |
|---|---|
| `01-provider-contracts.md` | `ProviderPort`/`ProviderRuntime`, `CanonicalProviderEvent` ADT, `ModelCapabilityPort`, provider failure model, `provider_turns`/`provider_attempts` semantics |
| `02-model-context-contracts.md` | `prepareTurn`, six surfaces, `InstructionFragment` + resolver, C0–C6 layers, retention/budget, Skills surface, Compaction ProviderTurn protocol, `ModelContextManifest` |
| `03-agent-loop-driver.md` | real `ExecutionDriverPort`, control loop, `AgentDirective` decode/validation, Output Contract, safety gating |
| `04-sqlite-schema.md` | `provider_turns`, `provider_attempts`, `model_context_manifests`, Session entry content types |
| `05-prompt-context-contracts.md` | versioned Prompt Program artifacts, provenance, model-family compiler |
| `06-provider-failure-repair.md` | failure translation, bounded repair, `ContextUnsatisfiable`, `DecisionStale`, `GovernanceBlocked` |
| `07-behavioral-eval-harness.md` | shared Prompt/Context behavioral-eval harness; per-phase ownership of programs/eval cases/acceptance |
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
| C4 | `CanonicalProviderEvent` is **not** elevated to the DID; P3 freezes its exact ADT. Provider events are normalized transport/runtime vocabulary and **must not** directly express an `AgentDirective`. |
| C5 | Prompt Program **actual text** is **not** implementation choice. The Programs P3 uses (Base Agent Protocol, Responsibility-bound Protocol, Work Execution Program, Compaction, …) are versioned phase-scoped **contract artifacts** with regression eval. Only wording iteration that does not change the contract, and numeric defaults, are empirical. |

## Inherited from P2

- `ExecutionDriverPort` seam + `AgentExecutionState` + `RuntimeSafetyGate` (DID v1.7 G4).
- `session_entries` storage (P2) with P3-owned entry content types.
- `WorkWait` / `WaitSpec` / `WakeCondition` / `WakeReason` (P2 `05`).
- Admission binding, lease/fencing, `Settlement`, `RecoveryController`.
- `ReconciliationSource` stub → P3/P4 provide Provider/Tool reconciliation content.

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
