# Tool Observation Review

## Observation pipeline

```text
executor result
→ ToolRuntime canonical settlement/observation
→ SliceDirectiveHandlersLive.toOutcome
→ bounded DirectiveOutcome observation
→ session Observation entry
→ next model turn context
```

The core runtime bounds observations at 2000 characters (`packages/tool-runtime/src/runtime.ts:263`; `apps/single-workspace/src/directives.ts:50-69`). Large raw outputs are intended to use artifact references, but current builtin executors usually return `resultRef: null`.

## Observation shape by tool

| Tool | Executor output | Model-visible observation | Evidence |
|---|---|---|---|
| `read` | JSON text/truncation/byte size, bounded | same bounded observation | `tools/read.ts` |
| `list` | entries/truncated, max 500 entries, bounded | same bounded observation | `tools/list.ts` |
| `patch` | applied/hunks, bounded | same bounded observation | `tools/patch.ts` |
| `shell` | schema says refs; executor emits empty `stdoutRef`/`stderrRef` and discards captured stdout/stderr | exit-code JSON with empty refs | `tools/shell.ts` |
| denied | canonical `Denied(reason)` | `tool denied: …` | `directives.ts:80-82` |
| interrupted | canonical `Interrupted` | `tool invocation interrupted` | `directives.ts:83-84` |
| outcome unknown | canonical reconciliation refs | `tool outcome unknown` without refs | `directives.ts:85-86` |
| runtime failure | canonical cause | `tool runtime failure: …` | `directives.ts:87-88` |

## Findings

### F-TS-10 — failure distinctions are compressed at the model boundary

- **Severity:** MEDIUM.
- **Category:** observation fidelity.
- **Evidence:** `toOutcome` maps `OutcomeUnknown` to a text without reconciliation refs and maps distinct statuses to plain strings (`directives.ts:71-89`).
- **Status:** `DESIGNED canonical distinctions yes / IMPLEMENTED lossy model observation yes / TESTED unit/runtime paths partial / BEHAVIORALLY VERIFIED no`.
- **Risk:** a model may not know whether to retry, wait, reconcile, or stop when several runtime outcomes become similar text.

### F-TS-11 — shell output contract/implementation mismatch

- **Severity:** HIGH.
- **Category:** observation/result schema mismatch.
- **Evidence:** `SHELL_RESULT_SCHEMA` requires `stdoutRef`/`stderrRef`; `shellExecutor` captures stdout but returns empty refs and `resultRef:null` (`catalog.ts:59-71`, `tools/shell.ts`).
- **Status:** `DESIGNED refs yes / IMPLEMENTED empty refs yes / TESTED schema/projection yes, end-to-end artifact evidence absent / BEHAVIORALLY VERIFIED no`.
- **Risk:** the model-facing description suggests inspectable output references that are not actually produced.

### F-TS-12 — bounded observations exist, but artifact handoff is not demonstrated

- **Severity:** MEDIUM.
- **Category:** capability/evidence gap.
- **Evidence:** bounded helper is present and executors return null refs; no dedicated real-model artifact-observation evidence found in the audit corpus.
- **Status:** `IMPLEMENTED bounding yes / TESTED unit-level yes / BEHAVIORALLY VERIFIED no`.
