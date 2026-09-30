# P3 — Runtime Decomposition

## Status

**PHASE 1 COMPLETE — behavior-preserving foundation.**

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

AgentDriver still owns DecisionTurn and action orchestration in phase 1. Future extraction must follow durable AgentLoopStep state ownership and preserve the current exhaustive recovery suites; line-count-only splitting is not a goal.

