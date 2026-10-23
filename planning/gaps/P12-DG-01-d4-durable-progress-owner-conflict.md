# P12-DG-01 — D4 durable-progress source conflict

Status: **OPEN — P12 owner clarification required; independent of S4-CONTEXT-DG-01**

## Conflicting contracts

P12 `08-runtime-safety-completion.md` §5 defines D4 durable progress as any
committed canonical mutation, journaled ToolInvocation settlement, **or a
monotone fenced AgentLoopStep transition / idempotent sourced Session or
Observation commit** observed at a ProviderTurn boundary. It states that a
true driver signal resets the D4 counter.

The same contract's §7 D4 row defines the driver's `durableProgress=true`
condition more narrowly: **only** a committed canonical mutation or journaled
ToolInvocation settlement since the preceding boundary. DID v1.20's AgentLoopStep
adoption note says monotone AgentLoopStep progression counts as D4 progress
evidence, aligning with §5 but leaving §7's observation rule inconsistent.

## Question for P12 governance

P12 owners must reconcile which evidence may set the observation's D4 boolean,
including whether an accepted AssistantMessage/ModelOutput append, a sourced
Session append, or a no-effect `StepEffectsCommitted → NextStepReady` transition
counts. The resolution must state how P3 reports that evidence, how P2 counts
it, and whether a plain-text/no-action turn resets or increments the counter.
This record does not choose an interpretation or propose a counter/default
change.

## Scope boundary

This gap is a separate P12/P3/P2 safety-observation clarification. It is not a
prerequisite for S4-CONTEXT-DG-01's context-only AssistantMessage projection:
that package must preserve current RuntimeSafetyObservation generation,
D2/D4 counter behavior, `MAX_TURNS`, and settlement exactly. The context
projection may change future model choices but does not itself resolve or
reinterpret the D4 signal. Resolve this gap independently before any work that
changes durable-progress observation semantics.
