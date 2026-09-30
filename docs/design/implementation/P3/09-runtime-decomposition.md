# P3 — Runtime Decomposition

## Status

**PHASE 3 COMPLETE — runtime turn and control-tool pipelines decomposed without semantic change.**

## RuntimeClock

Provider Runtime requires an explicit RuntimeClock capability:

- epochMillis: absolute persisted deadlines and restart comparison;
- monotonicMillis: in-process connect/first-event/idle elapsed phases.

Production uses Date.now and performance.now behind the adapter Layer. Runtime code reads neither global directly. Tests may inject a deterministic RuntimeClock.

The durable ISO Clock remains separate and owns recorded timestamps.

## Agent Driver boundary

Pure driver policy moved to driver-policy.ts:

- repair bounds;
- provider failure/timeout settlement mapping;
- session fence construction;
- conversation classification;
- canonical prompt fragments.

AgentDriver now owns only top-level execution-loop composition. The turn pipeline
is divided by durable state ownership:

- `decision-turn.ts`: prepare/provider/decode/repair progression;
- `turn-journal.ts`: provider-result acceptance and model-output journaling;
- `action-progressor.ts`: executable/control routing, action ledger,
  freshness and early settlement;
- `turn-finalizer.ts`: observation commit, step-effects commit, successor and
  conversation settlement;
- `driver-policy.ts`: pure bounds, classification and settlement policy.
- `session-context.ts`: bounded durable Observation → provider tool-message
  assembly;
- `control-basis-resolver.ts`: canonical revision snapshot and authorization
  digest assembly.

These are internal Agent Runtime modules, not new Ports or wire contracts.
Durable `AgentLoopStep` transitions and transaction/fencing boundaries are
unchanged.

## Control-tool boundary

`control.ts` remains the stable public composition surface. Its internal
responsibilities are divided as follows:

- `control-types.ts`: provider-neutral `AgentAction`, handler and registry
  contracts;
- `control-catalog.ts`: model-visible names, schemas, versions, capabilities
  and definition hashes;
- `control-decoder.ts`: closed tool-name dispatch only;
- `control-decode-shared.ts`: closed-object and identifier parsing primitives;
- `control-decode-wait.ts`: durable wait conditions;
- `control-decode-coordination.ts`: messaging and child-workspace proposals;
- `control-decode-work.ts`: completion claims and dependency declarations;
- `control-decode-delegation.ts`: temporary specialist delegation.

The public import path and registry semantics are unchanged. Model-facing JSON
is still decoded into the internal `AgentAction` ADT before policy or handlers
run. No family decoder can execute effects or bypass the shared registry.

