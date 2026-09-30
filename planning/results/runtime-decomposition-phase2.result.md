# Runtime Decomposition Phase 2 — Result

## Status

**COMPLETE / VERIFIED — 2026-09-30.**

## Delivered

- Reduced `driver.ts` from 1,662 lines at the Phase 1 baseline to 355 lines.
- Extracted model-decision preparation, provider execution, decoding and bounded
  repair into `model-decision.ts` (current name).
- Extracted model-output journal acceptance and the
  `ProviderResultAvailable -> OutputAccepted -> ActionsInProgress` transition
  into `model-output-journal.ts` (current name).
- Extracted executable/control tool routing, durable action records,
  freshness rejection and early settlement into `agent-loop-actions.ts`.
- Extracted observation commit, step-effects commit, successor creation and
  conversation settlement into `agent-loop-step-completion.ts`.
- Kept all new modules internal to `agent-runtime`; no Domain, Port, SQL,
  transport or public contract changed.

## Behavioral invariants preserved

- A decoded provider result is durably accepted before any action executes.
- Executable and control actions share one ordered, idempotent action ledger.
- A stale control basis skips the stale action and all later actions, then
  creates the durable successor step.
- Early settlement records remaining actions as skipped before proposing the
  settlement.
- Conversation execution still settles on the first text-only response.
- Lease fencing, session idempotency and runtime safety admission remain on the
  same transactional boundaries.

## Evidence

- focused Agent Driver/control/provider-disconnect suite: PASS (33/33)
- lint: PASS (760 files)
- typecheck: PASS
- architecture: PASS (115/115)
- core tests: PASS (1475 passed, 1 skipped)
- web typecheck/build: PASS
- web tests: PASS (211/211)
- git diff check: PASS

## Next backend boundary

`control.ts` remains the largest mixed-responsibility Agent Runtime module. Its
next safe decomposition boundary is by action family (work lifecycle,
coordination, execution control, verification), while retaining one registry
composition surface and the existing typed `AgentAction` policy boundary.
