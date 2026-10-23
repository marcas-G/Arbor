# S4 WorkspaceWork AssistantMessage Context Diagnostic — Independent Review

**Disposition: PASS — Blocking = 0 for the diagnostic commit.** This review
does not qualify S4-B, authorize a real Provider/daemon run, or authorize a
production or frozen-design change.

## Reviewed identity and validation

- Candidate: `7eba743040de8c5e3f64e1a447d7320e50178ee0`.
- Reviewed test: `packages/agent-runtime/test/diagnostic-work-assistant-message-context.test.ts`.
- Light command: `pnpm exec vitest run packages/agent-runtime/test/diagnostic-work-assistant-message-context.test.ts --maxWorkers=1 --retry=0`.
- Result: **3 passed, 1 intentionally skipped**. No real Provider, daemon, or persistent database was used.

## Findings

- The model-light test genuinely exercises the production
  `projectSessionTimeline` and `compileTurn` functions. Given the same
  `SessionEntryRecord` frontier plus a typed, sourced `AssistantMessage`, the
  projected `inputItems`/`contextRefs` and full provider-neutral request stay
  equal, while the manifest frontier and ProviderTurn identity advance. This
  correctly isolates request-content equality from per-turn metadata.
- It does **not** exercise Session storage/frontier selection. It supplies
  hand-built `SessionEntryRecord[]` arrays directly to the projector; it never
  calls `SessionRepository.listWorkActiveFrontier` (or the driver’s normal
  `readExecutionTimeline`) and does not run `ModelContext.prepareTurn`. Treat it
  as evidence for projector→compiler behavior on a supplied frontier, not a
  full Session-repository→runtime integration test. This scope limit is
  non-blocking for the stated model-light diagnostic.
- The ControlResult/ToolResult controls are valid as comparisons of complete
  sourced action sequences: each adds a ToolCall and corresponding result, and
  each asserts the projected result item is present. Because the ToolCall is
  also added, these cases do not isolate the result item as the sole cause of
  the request change. The record describes them as action/result additions,
  not as a result-only causal test; no false claim is made.
- `MAX_TURNS` conclusion is accurate. The test directly checks
  `completeAgentLoopStep` for a WorkspaceWork text-only `Stop`: it commits
  `StepEffectsCommitted → NextStepReady` and creates a same-Execution
  successor below the bound; at `MAX_TURNS - 1`, it creates no successor. The
  `AgentLoopDriver`’s `turn < MAX_TURNS` loop then exits to its existing
  `Failed("max turns reached")` return. The test does not instantiate the
  outer driver, so that final settlement is source-verified rather than
  directly asserted by this unit test. This is bounded advancement, not an
  unbounded scheduler loop. Provider `finishReason="Stop"` alone does not
  settle a WorkEpisode; only the exact ConversationResponse and Inbox text-only
  branches settle there.
- The observed projection omission is real: the Session output writer stores
  `_tag: "AssistantMessage"`, but `projectSessionTimeline` has no matching
  branch. Freshly reading a frontier therefore does not make that assistant
  text a projected Work input. This is a plausible mechanism for the repeated
  fingerprint, but it does not prove that the omission alone caused the
  Provider not to select shell in the S4-B run.
- Keeping `S4-CONTEXT-DG-01` open for manual owner clarification is justified.
  The top-level SCRC/DID contracts make Session an append-only timeline and
  explicitly allow a lossy active projection. The accepted AH19/P3 owner text
  lists `AssistantMessage` in the selected SessionItem union and P3 accepts an
  assistant-role DataOnly message, but also preserves existing projector
  filters and says rows without an existing branch remain unprojected. The
  required Work-specific projection rule is therefore not unambiguous enough
  for an implementation-only semantic choice. P5/EGP common-loop semantics
  and P9 Provider recovery do not resolve that projection question. The
  diagnostic correctly leaves the candidate projection assertion skipped and
  proposes no production or design edit.

## Conclusion

The diagnostic commit is suitable as narrow evidence for the current
projector/compiler behavior and the bounded no-action continuation path. Its
remaining scope limitations are accurately bounded and non-blocking. The
manual owner decision in `S4-CONTEXT-DG-01` should precede any new
AssistantMessage projection or replacement no-action policy. No S4-B
qualification or real-run authorization is implied.
