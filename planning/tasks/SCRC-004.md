# SCRC-004 — Tool / Control Timeline Closure

## Source

- SD v1.4 §6.5–§6.6, invariants 62/68; DID v1.22 §7.6; P4 `02` §7; T03/T13–T15

## Depends On

- SCRC-002

## Objective

Persist typed ToolCall and sourced ToolResult/ControlResult with stable callRef,
bounded output, ObservationRef/ArtifactRef and explicit terminal status. Close
settled-invocation/missing-Session and dangling-call recovery without effect replay.

## Outputs

- AgentLoop decode/journal/writeback integration;
- replacement of plain Session Observation tool-message path;
- legacy-safe replay lowering;
- `scrc-tool-timeline` suite.

## Must Hold

- ToolRuntime remains authority/effect/settlement owner and never writes Session;
- result status includes Success/Failure/Denied/Interrupted/OutcomeUnknown;
- unresolved side effect gate remains authoritative;
- large outputs preserve complete artifact and epistemic/truncation metadata.

## Must Not Decide

- No new tool taxonomy, authority rule, control action or Provider event.

## Acceptance

- T03/T13–T15 pass; no new unpaired tool result reaches any adapter.

## Verification

```bash
pnpm test scrc-tool-timeline
pnpm test p4-reconciliation
pnpm architecture
```
