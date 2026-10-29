# S4 WorkspaceWork AssistantMessage context — model-light diagnostic

Date: 2026-10-24
Candidate: `4de305bb6e81f98688f40d98e817d5b4d7da19b4`
Test: `packages/agent-runtime/test/diagnostic-work-assistant-message-context.test.ts`
Disposition: **context-refresh gap reproduced; AssistantMessage projection remains pending owner clarification**

## Run boundary

No real Provider, daemon, browser journey, or database was started. The only
test executed was the focused Vitest file (one worker, retry zero). Local
workspace package references were built first with `pnpm exec tsc -b
packages/agent-runtime` because the new worktree had no compiled package
outputs.

Result:

```text
Test Files  1 passed (1)
Tests       3 passed | 1 skipped (4)
```

Biome and `git diff --check` passed. The skipped case is intentionally a
candidate behavior pending owner decision: include the persisted
AssistantMessage as an assistant-role DataOnly item on the next Work turn.
No implementation change was authorized.

## What the focused test proves

For a valid `ModelOutput` Session entry containing
`AssistantMessage(providerTurnId, contentRef, text, finishReason="Stop")`:

- the Session frontier advances from sequence 1 to 2;
- current `projectSessionTimeline` returns exactly the same `inputItems`,
  `contextRefs`, and diagnostic input-item SHA-256 as before the output was
  appended;
- `compileTurn` therefore emits an exactly equal provider-neutral
  `PortableModelRequest` and `compiledRequestHash` for the next logical step.
  The manifest still advances its `inputFrontier` from sequence 1 to 2 and uses
  a different ProviderTurnId, separating request-content equality from
  per-turn identity metadata;
- the AssistantMessage text is absent from provider-neutral projected input.

In contrast, adding a sourced ToolCall followed by a ControlResult or a
ToolResult changes projected input and its diagnostic input-item hash. Thus
the unchanged PortableModelRequest is specific to the AssistantMessage
projector omission, not a capture hash ignoring all Session-derived request
items. Both cases also produce a different `manifest.compiledRequestHash`.

The second half feeds the exact `Stop`/text/no-tool shape to the existing
`completeAgentLoopStep` function for a WorkspaceWork Execution. It returns
`Continue`, commits `StepEffectsCommitted → NextStepReady`, and ensures the
logical-step-1 successor with the same Execution identity. At `MAX_TURNS - 1`
the same function commits only `StepEffectsCommitted` and creates no
successor. The outer driver then exits its `turn < MAX_TURNS` loop with
`Failed("max turns reached")`; this is a bounded failure after unchanged
context, not unbounded step advancement.

## Contract comparison and remaining gap

DID §9.8 / v1.50 AH19 lists `AssistantMessage` in the SessionItem set selected
for Work history. P3 `02` accepts `PortableInputItem` and its history layer
classifies assistant-role messages as `AuthenticatedAgent`, C3, and DataOnly.
However, `packages/model-context/src/projector.ts::projectSessionTimeline`
has no AssistantMessage branch. The frozen owner text does not unambiguously
state whether omission is deliberate or whether a subsequent Work request
must include the previous output. The Diagnostic therefore records
`S4-CONTEXT-DG-01` and leaves the desired assistant projection skipped pending
manual P2/P3 owner clarification.

The earlier public S4-B diagnostic at this candidate independently observed
the same message-array fingerprint across logical Work steps 1–15 while
separate AssistantMessage rows were persisted. That capture hook stores the
parsed Provider request body; its shortened fingerprint specifically covers
`request.messages`, so it cannot speak for tool schemas or non-message
manifest fields. The model-light `compileTurn` comparison establishes that
the provider-neutral request itself is equal after the AssistantMessage, not
merely that a separate capture fingerprint omitted it.

Relevant owner/source code inspected: P3 output append in
`packages/agent-runtime/src/model-output-journal.ts`, Session projection in
`packages/model-context/src/projector.ts`, assistant-history provenance in
`packages/model-context/src/history-context.ts`, no-action continuation in
`packages/agent-runtime/src/agent-loop-step-completion.ts`, and the hard turn
bound in `packages/agent-runtime/src/agent-loop-policy.ts` and
`packages/agent-runtime/src/agent-loop-driver.ts`.

No production code or `docs/design/**` changed. No real Provider, daemon,
database, or qualification run occurred. See
[`planning/gaps/S4-CONTEXT-DG-01-assistant-message-work-context.md`](../gaps/S4-CONTEXT-DG-01-assistant-message-work-context.md)
for the precise manual decision requested.
