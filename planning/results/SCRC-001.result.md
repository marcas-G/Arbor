# SCRC-001 — Typed Session / Provider Item Protocol Result

## Status

**COMPLETE / VERIFIED — 2026-10-01.**

## Delivered

- Added provider-neutral `PortableInputItem` ADT for Message, ToolCall,
  ToolResult, ControlResult, ContextUpdate, CompactionCheckpoint and
  AttachmentRef.
- Added v2 request envelope with `operationKind` + `inputItems`; the Model
  Context compiler now emits only v2 requests.
- Preserved explicit read compatibility for persisted v1 `messages` requests;
  compatibility normalization is bounded to the provider boundary.
- Added typed request compatibility and ToolCall/Result pairing validation.
- OpenAI-compatible lowering preserves callRef on assistant tool calls and tool
  results, including out-of-order parallel completion.
- Unsupported typed items fail before any provider request bytes are sent.
- Updated testecho and recovery/capability harnesses to consume normalized
  input items.
- Added optional ModelCapability request-surface metadata and binding
  fingerprint seam for later SCRC tasks.

## TDD evidence

Initial `scrc-item-protocol` run: 3/3 failed because the new validators/types
did not exist. After implementation:

```text
SCRC item protocol: 3 passed
Focused regression: 7 files / 81 tests passed
Architecture: 20 files / 121 tests passed
Full root tests: 252 files / 1498 passed / 1 skipped
Web tests: 31 files / 211 tests passed
Web build: PASS (existing chunk-size warning only)
pnpm check: PASS
git diff --check: PASS
```

## Acceptance mapping

| Row | Evidence |
|---|---|
| T01 | tagged item ADT + compiler v2 assertions + OpenAI body lowering |
| T02 | typed compatibility result + zero-network-send adapter test |
| T03 | pure parallel pairing validation + out-of-order OpenAI call/result test |

## Scope guards

- No CanonicalProviderEvent variant added.
- No package/dependency edge added.
- No DB/migration/Session persistence change.
- No authority/Work/Verification/settlement semantic change.
- Legacy tool-message production remains isolated for SCRC-004; new provider
  request compilation uses typed v2 items.

Next task: **SCRC-002 — migration 0019 + Session store + durable input
promotion**.
