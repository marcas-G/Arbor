# Runtime Decomposition Phase 3 — Result

## Status

**COMPLETE / VERIFIED — 2026-09-30.**

## Delivered

- Reduced `control.ts` from approximately 1,260 lines to 145 lines.
- Preserved `control.ts` as the stable public export and registry composition
  surface.
- Moved the `AgentAction`, handler, executable-handler and registry contracts
  into `control-types.ts`.
- Moved model-facing tool definitions and schema hashes into
  `control-catalog.ts`.
- Reduced the central decoder to closed tool-name dispatch and shared JSON
  object admission.
- Split argument decoding into wait, coordination, work and delegation action
  families.

## Behavioral invariants preserved

- Unknown or unregistered tools remain unavailable to the model and fail
  closed at decode time.
- JSON schemas, tool names, versions, capabilities and definition hashes are
  unchanged.
- All decoded values still enter the provider-neutral `AgentAction` ADT.
- Decoder modules perform validation only; execution remains behind registered
  `AgentActionHandler` instances.
- The built-in Wait handler and handler replacement rule are unchanged.
- Existing imports through `@arbor/agent-runtime` and `control.ts` remain
  compatible.

## Evidence

- focused control/driver/provider-disconnect suite: PASS (62/62)
- lint: PASS (768 files)
- typecheck: PASS
- architecture: PASS (115/115)
- core tests: PASS (1475 passed, 1 skipped)
- web typecheck/build: PASS
- web tests: PASS (211/211)
- git diff check: PASS

## Remaining backend structure

The two largest Agent Runtime implementation modules are now
`model-decision.ts` and `agent-loop-actions.ts`. Their sizes follow durable state
ownership rather than mixed concerns, so further splitting is not currently
justified by line count alone. The next architectural review should move to
Application command-family composition and persistence adapter boundaries.
