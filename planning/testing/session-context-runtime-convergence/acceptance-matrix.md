# SCRC Acceptance / Fault Matrix

## Status

**FROZEN PLANNING EVIDENCE — implementation NOT AUTHORIZED.**

Every row must be implemented as a failing test before the production change.
`Given/When/Then` describes observable contract evidence, not implementation
structure.

| ID | Given / When | Required result | Owner / suite |
|---|---|---|---|
| T01 | Message/ToolCall/ToolResult round-trip | kind, callRef, status and refs preserved | 001 / `scrc-item-protocol` |
| T02 | adapter lacks an item kind | typed incompatibility; no text fallback | 001 / `scrc-item-protocol` |
| T03 | multiple/parallel calls finish out of order | every result pairs to its originating callRef | 001,004 / `scrc-tool-timeline` |
| T04 | migrate v18 DB | v19; all legacy rows retained and marked legacy | 002 / `scrc-session-migration` |
| T05 | migration 0019 run twice | identical schema/data; no duplicate items | 002 / `scrc-session-migration` |
| T06 | legacy Observation has suggestive text IDs | no inferred callRef/strict ToolResult | 002 / `scrc-session-migration` |
| T07 | append sourced item twice, same hash | same sequence returned | 002 / `scrc-input-promotion` |
| T08 | append same source, different hash | invariant conflict | 002 / `scrc-input-promotion` |
| T09 | crash before/after Session append ↔ Inbox consumed | exactly one Session Input; Inbox converges consumed | 002 / `scrc-input-promotion` |
| T10 | Steer arrives during active model/tool continuation | delivered at next safe sampling boundary | 003 / `scrc-input-promotion` |
| T11 | Queue entries arrive during drain | FIFO; one promotion then continuation re-evaluation | 003 / `scrc-input-promotion` |
| T12 | Provider repair/retry | promoted Inbox entry is not injected again | 003 / `scrc-input-promotion` |
| T13 | Tool settled, Session result missing | local idempotent result append; no re-execute | 004 / `scrc-tool-timeline` |
| T14 | dangling pending/running ToolCall on restart | reconcile or explicit Interrupted/OutcomeUnknown result | 004 / `scrc-tool-timeline` |
| T15 | large Tool result | bounded model output + full ArtifactRef + truncation status | 004 / `scrc-tool-timeline` |
| T16 | same StepContext/frontier twice | identical item order and Manifest/request hash | 005 / `scrc-context-projector` |
| T17 | canonical revision changes before effect | DecisionStale/Denied by fresh check; snapshot grants nothing | 005 / `scrc-context-projector` |
| T18 | compacted summary claims new permission | no authority elevation | 005,006 / `scrc-context-projector` |
| T19 | budget pressure before inference | Summary compact, atomic epoch advance, same step resumes | 006 / `scrc-summary-compaction` |
| T20 | crash before/after checkpoint ↔ epoch CAS | old epoch before commit; new epoch after; no split state | 006 / `scrc-summary-compaction` |
| T21 | compaction after settled tool action | action not replayed | 006 / `scrc-summary-compaction` |
| T22 | fixed mandatory context exceeds all allowed models | ContextUnsatisfiable; no compaction loop | 006 / `scrc-summary-compaction` |
| T23 | native checkpoint binding matches | opaque item reused with exact fingerprint | 007 / `scrc-native-budget` |
| T24 | provider/model/deployment/protocol fingerprint differs | opaque item rejected; portable rebuild | 007 / `scrc-native-budget` |
| T25 | provider supplies usage/tokenizer | higher-grade evidence wins over fallback | 007 / `scrc-native-budget` |
| T26 | first overflow, no durable output/effect | one compact + physical retry of same logical step | 007 / `scrc-native-budget` |
| T27 | second overflow or no-gain repeated compaction | typed terminal failure/Attention; no loop | 007 / `scrc-native-budget` |
| T28 | overflow after durable output/effect | no full-step replay | 007 / `scrc-native-budget` |
| T29 | AH15–AH19 kill both sides | stable identities; no duplicate delivery/effect/checkpoint/request | 008 / `scrc-recovery-qualification` |
| T30 | full upgrade + restart + real compatible provider | work continues through typed timeline and compaction | 008 / `scrc-acceptance` |

## Negative architecture assertions

- `model-context !-> agent-runtime/tool-runtime`;
- ToolRuntime does not write Session;
- ProviderRuntime does not decide Work/permission;
- no new CanonicalProviderEvent variant;
- no new package edge;
- no migration edits to 0001–0018;
- no raw secret in Session/checkpoint/manifest/log/artifact;
- four G-V2 gaps remain scoped and unchanged.

## Completion evidence

SCRC-008 must record test file, assertion count, command output and commit for
T01–T30. A green `pnpm check` without this row mapping is insufficient.
