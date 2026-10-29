# SCRC-004 — Tool / Control Timeline Closure Result

## Status

**COMPLETE / VERIFIED — 2026-10-01.**

## Delivered

- Durable Provider acceptance writes typed AssistantMessage and one ToolCall
  per model invocation before action execution.
- Tool and control observations write callRef-paired ToolResult/ControlResult
  in the same transaction as action-ledger progression.
- Executable outcomes preserve explicit Succeeded/Failed/Denied/Interrupted/
  OutcomeUnknown status.
- Bounded observations retain truncation state and full result/Artifact refs.
- Session continuation lowers typed calls/results to provider input items;
  legacy Observation remains read-only compatibility for pre-0019 history.
- Existing P5 acceptance/restart tests now assert the typed Timeline shape.

## Evidence

```text
Focused: 4 files / 26 tests passed
Architecture: 20 files / 121 tests passed
Root: 257 files / 1512 passed / 1 skipped
Web: 31 files / 211 tests passed
pnpm check: PASS
git diff --check: PASS
```

T13–T15 are covered by the durable action transaction, typed call/result
integration test and executable outcome taxonomy/artifact test. No
CanonicalProviderEvent, authority, ToolRuntime ownership or package edge changed.

Next task: **SCRC-005 — AgentStepContext + ContextProjector + Manifest**.
