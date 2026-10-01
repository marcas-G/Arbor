# SCRC-005 — AgentStepContext / ContextProjector / Manifest Result

## Status

**COMPLETE / VERIFIED — 2026-10-01.**

## Delivered

- Moved durable Session projection into `model-context` as a deterministic,
  data-only ContextProjector.
- Added immutable per-sampling AgentStepContext fingerprint over logical step,
  repair attempt, real Session epoch, ControlBasis, binding and input frontier.
- Production no longer hardcodes ContextEpoch zero.
- Extended Manifest with step/repair, operation, frontier, typed refs/callRefs,
  StepContext/binding fingerprints and budget evidence.
- Session-derived permission claims remain data-only and emit zero instruction
  fragments; effect admission still re-reads current ControlBasis.

## Evidence

```text
Focused: 4 files / 24 tests passed
Architecture: 20 files / 121 tests passed
Root: 259 files / 1516 passed / 1 skipped
Web: 31 files / 211 tests passed
pnpm check: PASS
```

T16–T18 pass through projector determinism, StepContext fingerprint revision
sensitivity and existing DecisionStale plus data-only trust assertions.

Next task: **SCRC-006 — Summary Compaction Coordinator**.
