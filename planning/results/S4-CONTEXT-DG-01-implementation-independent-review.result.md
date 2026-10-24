# S4-CONTEXT-DG-01 implementation — independent review

**Disposition: PASS — Blocking = 0.** This is an independent focused code
review; it does not qualify a real Provider, daemon, deployment, or release.

## Reviewed change

- Implementation commit: `7f9602e9c08c2fbae75e829f7c1e90d04aa48a51`.
- Accepted Option A token:
  `ACCEPT_S4_CONTEXT_DG_01_ASSISTANT_MESSAGE_PROJECTION_OPTION_A`.
- Conditional implementation token:
  `AUTHORIZE_S4_CONTEXT_DG_01_ASSISTANT_MESSAGE_PROJECTION_IMPLEMENTATION_AFTER_LANDING_REVIEW`.
- Owner landing review: PASS, Blocking = 0 at
  `9d18219e5735c9e9c113be42a482b69e3cd5a59f`.

## Findings

- `projectSessionTimeline` projects an `AssistantMessage` only when the row is
  `ModelOutput`, its `ProviderTurnId` parses, `contentRef` and source kind/ref
  exactly match that ID, text and finish reason are strings, and the source
  content hash equals the accepted writer's SHA-256 of the exact
  `{ text, finishReason }` payload. Invalid, malformed, legacy or mismatched
  rows are omitted without reconstruction or fallback; the Session's exact
  source reference is retained.
- The accepted-output writer uses the same hash construction. The projected
  item enters the existing compressible-history path as `AuthenticatedAgent`,
  C3, `DataOnly`; it creates no instruction fragment or authority. No change
  was made to output persistence, provider orchestration, ports, schema,
  migration, P12 safety behavior, settlement or loop bounds.
- New regression coverage includes strict binding negatives and DataOnly
  provenance. The driver-level tests append through `SessionRepository`, read
  `listWorkActiveFrontier`, project that actual repository frontier, and pass
  it through `ModelContext.prepareTurn`; they also assert idempotent same-source
  append replay, manifest source refs, the real 64-row bound, and the exact
  checkpoint plus post-checkpoint suffix.
- ConversationResponse coverage injects a Work-sourced assistant row and
  asserts it does not enter the Conversation request. The existing
  same-Execution text-only Stop assertions remain, while assistant text is
  never treated as canonical progress or completion.

## Verification performed

- Focused Vitest selection across the projector, diagnostic, and P3 driver
  files: **3 files passed; 19 tests passed, 47 skipped by name filter**.
- `pnpm exec tsc -p tsconfig.test.json` — PASS.
- Biome check on the four changed implementation/test files — PASS.
- `git diff --check` — PASS.

No real Provider, daemon, full suite, or browser journey was run. The result
does not claim real S4-B qualification or provider/OS support.
