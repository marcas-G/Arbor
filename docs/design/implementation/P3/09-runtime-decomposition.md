# P3 — Runtime Decomposition

## Status

**PHASE 2 COMPLETE — runtime turn pipeline decomposed without semantic change.**

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

These are internal Agent Runtime modules, not new Ports or wire contracts.
Durable `AgentLoopStep` transitions and transaction/fencing boundaries are
unchanged. Further decomposition should target `control.ts` by control-action
family, not split the orchestration loop by line count.

