# S4-CONTEXT-DG-01 AssistantMessage projection implementation

**Status:** deterministic implementation and focused verification PASS.
**Implementation authorization:** conditional token was exercised after the
independent landing review reported Blocking = 0.
**Real Provider/daemon qualification:** NOT RUN / NOT AUTHORIZED.
**Schema/migration changes:** none.

## Governance basis

- Accepted Option A token: `ACCEPT_S4_CONTEXT_DG_01_ASSISTANT_MESSAGE_PROJECTION_OPTION_A`.
- Conditional implementation token:
  `AUTHORIZE_S4_CONTEXT_DG_01_ASSISTANT_MESSAGE_PROJECTION_IMPLEMENTATION_AFTER_LANDING_REVIEW`.
- Owner landing and acceptance record:
  `planning/results/S4-CONTEXT-DG-01-governance-acceptance-and-landing.md`.
- Independent landing review: PASS, commit `9d18219e5735c9e9c113be42a482b69e3cd5a59f`.
- Implementation base: `9d18219e5735c9e9c113be42a482b69e3cd5a59f`.

## Change summary

`packages/model-context/src/projector.ts` now emits exactly one
`Message(role="assistant")` for a selected typed AssistantMessage only when
the whole source/content binding is valid: `entryKind=ModelOutput`, a
schema-valid exact ProviderTurnId, exact `contentRef`, exact
`ProviderTurn` source kind/ref, string text/finish reason, and source
`contentHash=SHA-256(JSON.stringify({text,finishReason}))`. Invalid or
unsupported rows are omitted; there is no legacy/free-text fallback. The
existing `projectCompressibleHistory` path classifies the resulting assistant
history as `AuthenticatedAgent`, C3, `DataOnly`, Compressible.

The diagnostic now asserts that accepted assistant output changes the projected
provider-neutral request/hash and is present in the next input; its same-
Execution text-only Stop/finite `MAX_TURNS` assertions remain. New tests cover
strict source/hash rejection, actual SQLite SessionRepository frontier to
`ModelContext.prepareTurn`, same-source idempotent append replay, the real
latest-64 frontier, exact Summary checkpoint plus post-checkpoint suffix, and
ConversationResponse exclusion of an unrelated Work-sourced assistant row.

Only these implementation/test files changed:

- `packages/model-context/src/projector.ts`
- `packages/model-context/test/s4-assistant-message-projection.test.ts`
- `packages/agent-runtime/test/diagnostic-work-assistant-message-context.test.ts`
- `tests/p3-driver.test.ts`

No production orchestration, domain semantics, ports, schema, migration,
Provider wire contract, `RuntimeSafetyObservation`, P12 D2/D4 rules,
`MAX_TURNS`, settlement, rate limits, or stop/fencing behavior changed. P14/P17
Conversation history remains separately owned; no Work Session message is
merged into it. Existing pinned ProviderTurn replay rules remain unchanged.

## TDD and verification evidence

Before the projector implementation, the enabled diagnostic failed at the
assertion requiring the accepted AssistantMessage in `inputItems` (the
projector returned only the prior user message). After implementation:

- `pnpm build` — PASS (`tsc -b`).
- `pnpm exec vitest run packages/model-context/test/s4-assistant-message-projection.test.ts packages/agent-runtime/test/diagnostic-work-assistant-message-context.test.ts` — PASS, 16/16.
- `pnpm exec vitest run tests/p3-driver.test.ts -t "projects a real typed Session frontier|honors the real 64-row Work frontier"` — PASS, 2 passed; other tests in file skipped by name filter.
- `pnpm exec vitest run tests/p3-driver.test.ts -t "carries a conversation-safe control result"` — PASS, 1 passed; other tests in file skipped by name filter.
- `pnpm exec tsc -p tsconfig.test.json` — PASS.
- `pnpm exec biome check packages/model-context/src/projector.ts packages/model-context/test/s4-assistant-message-projection.test.ts packages/agent-runtime/test/diagnostic-work-assistant-message-context.test.ts tests/p3-driver.test.ts` — PASS, no fixes required after formatting.
- `git diff --check` — PASS.

The focused evidence is local deterministic/model-light coverage only. The
complete `pnpm check`, real S4-B Provider journey, daemon, and deployment were
not run. This result does not claim real Provider qualification or OS/provider
support. Any real S4-B qualification remains a separate authorization gate.
