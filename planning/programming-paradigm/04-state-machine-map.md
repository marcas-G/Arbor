# Agent Decision State-Machine Map

Scope: `packages/agent-runtime/src/model-decision.ts` (`runModelDecision`).
This is an implementation map, not a new semantic contract.

## Current responsibilities

| Region | Current responsibility | Desired owner |
|---|---|---|
| startup/replay scan | load Session, ProviderTurn, AgentLoopStep state | Recovery interpreter |
| frontier repair | synthesize interrupted ToolResult for dangling calls | Session frontier repair |
| projection | convert timeline into model input items | Model Context projector |
| compaction | decide Summary/Native compaction and successor binding | Compaction coordinator |
| context assembly | Work/Conversation instructions and input items | Context assembler |
| provider preparation | compile manifest/request and validate budget | Model Context |
| provider execution | run ProviderTurn and persist observations | Provider Runtime |
| action progression | decode, apply, persist action effects and cursor | AgentLoopStep transition |
| repair | OutputRejected / DecisionStale successor | Recovery interpreter |
| settlement | propose Failed/Interrupted/OutcomeUnknown/Completed | Application settlement |

## Required extraction seams

The first extraction should preserve existing behavior and signatures while
moving pure decisions out of the driver:

1. `readDurableDecisionSnapshot(input)` — reads only; no repair or writes.
2. `decideSessionFrontier(snapshot)` — pure projection/blocked decision.
3. `decideLoopStepRecovery(snapshot)` — pure predecessor/successor decision.
4. `assembleTurnContext(snapshot)` — pure model-context input.
5. `interpretProviderOutcome(outcome)` — pure step transition.
6. `commitSettlement(proposal)` — one Application transaction boundary.

## Invariants for the split

- A recovery decision cannot invoke a Provider.
- A projector cannot append a Session item.
- A provider adapter cannot change Work lifecycle.
- A transition interpreter cannot read ambient time or environment.
- A settlement proposal is not a settlement commit.
- Existing ProviderTurn identity is never regenerated during recovery.

## Acceptance evidence

The map is accepted as a refactoring baseline when each extracted seam has a
focused test and the public process tests still cover the same lifecycle.
