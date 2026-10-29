# F23 receipt tuple-first runtime implementation

Date: 2026-10-10
Worktree: `C:\Users\ThinkPad\.codex\worktrees\f23-runtime-codec\Arbor`
Base: `28fa59db21c447beb8fda346a355d90198c3e590`

## Scope

The implementation follows the accepted tuple-first landing. Changed files are
limited to the P1 receipt Store/Gateway path, existing raw-receipt consumers
and their test doubles, focused P1/AH10 tests, and the external receipt
qualification below. No external codec, transport shell, AH19 test support,
SQL schema, or migration changed.

`CommandStore.findResolution` now returns `StoredCommandResolution` with tuple
metadata and raw result/error JSON text. The SQLite adapter no longer parses
those JSON columns. Inside the existing `CommandGateway.execute` transaction,
the Application compares fingerprint/schema/algorithm first. A mismatch
returns the existing `TerminalRejected(IdempotencyConflict)` receipt without
calling the receipt decoder; an exact tuple match enters the existing
Application JSON parse/cast path. No receipt pre-read was added outside
`BEGIN IMMEDIATE`, and no CommandId or stored row is rewritten.

Existing AH10 prior-receipt consumers now explicitly convert the raw Store
value through the same Application receipt decoder before their existing
identity/binding checks. Their mock Store boundaries now provide raw
`StoredCommandResolution` data rather than casting typed receipts into the new
Port contract.

## RED / GREEN evidence

- RED: a real external `SubmitHumanMessage` request used a valid CommandId,
  ProjectId, MessageId, matching authenticated Actor/Principal and successful
  Resolver path. Its DDL-valid historical Committed row had malformed
  `result_json`, with a different fingerprint caused by a valid changed
  `bodyRef`. Before implementation, Store-side `JSON.parse` failed before the
  Gateway could choose the tuple-mismatch branch; the HTTP response had an
  empty body instead of `IdempotencyConflict`.
- GREEN: the same request now returns HTTP 200 with
  `TerminalRejected/IdempotencyConflict`. The response does not contain the
  malformed result, sentinel, or stored fingerprint. The entire receipt row,
  including JSON bytes, remains identical; no handler execution (Application
  Gateway unit probe), command attempt, or event is recorded.
- Exact-tuple corrupted JSON: before and after the change it fails closed.
  The focused external test requires a non-success response, no reflection of
  the malformed value, byte-identical historical row, and no attempt/event.
  It intentionally does not pin an HTTP status or Problem code. This preserves
  evidence without inventing the still-unfrozen corruption mapping.
- P1 Gateway + SQLite Store focused tests: 22/22 PASS, including mismatch
  before decode and raw malformed JSON returned by the Store without parsing.
- AH10 receipt-first control-action focused tests: 49/49 PASS after migrating
  Store test doubles to the raw return contract.
- F23 external receipt tuple qualification: 2/2 PASS.
- `pnpm build`: PASS; `pnpm typecheck`: PASS; Biome on the 11 changed TS files:
  PASS; `git diff --check`: PASS.
- Full `pnpm check` was not run because the shared `C:\Arbor` full functional
  suite was in progress. The shared tree was not modified.

## Still open

The accepted design does not define a result/error shape decoder or typed
`CommandStore` corruption failure / transport Problem mapping for an exact
tuple whose JSON is malformed or structurally invalid. The existing
Application parse remains syntax-only and can surface as a non-success defect;
this change does not translate it into a new error or Problem. The exact-tuple
qualification asserts fail-closed behavior and unchanged durable state without
claiming a specific response DTO. A separate governance/implementation closure
is still required for structure validation and typed corruption handling.

The existing `control-actions.ts` raw prior-receipt decode path is included
only to preserve the existing AH10 receipt-first consumer after the Port shape
change. It has focused AH10 regression coverage; independent review of its
legacy-schema/error behavior is requested and remains pending. This result
does not claim that review or the exact-tuple decoder gap is closed.

## Public transport Problem oracle follow-up (2026-10-16)

The earlier F23 test's HTTP 200 `CommandReceipt` expectation was an incorrect
transport oracle. P8's external Problem presentation together with P1/F23
freezes the internal Gateway outcome as
`TerminalRejected(IdempotencyConflict)`, but the external transport presents
that rejection as a non-retryable stale Problem, HTTP 409; it does not forward a
successful receipt envelope. The test now asserts the complete external DTO:

```json
{
  "ok": false,
  "status": 409,
  "problem": {
    "code": "command/idempotency-conflict",
    "category": "stale",
    "message": "command/idempotency-conflict",
    "correlationId": null,
    "retryDisposition": "non-retryable",
    "safeDetails": { "commandId": "<the requested command id>" }
  }
}
```

The no-sentinel/raw-JSON/fingerprint leak assertions, byte-identical stored
receipt, unchanged attempts/events, and empty daemon errors remain. The two
exact-tuple corrupt/wrong-shape receipt cases retain their existing safe 503
Problem expectations.

Verification on base candidate `efc5a095b485288dbaa19d95a9fda54f1bb3191a`:

- `f23-receipt-tuple-ordering.functional.test.ts` — two consecutive runs,
  4/4 PASS each.
- `external-command-composition.test.ts` tuple-mismatch transport case — 1/1
  PASS.
- F21 `replays a v1 receipt only as a tuple conflict and leaves its row
  unchanged` representative — 1/1 PASS.
- `pnpm typecheck`, targeted Biome, and `git diff --check` — PASS.
- Test-only change; no production code or frozen design documents changed. No
  full functional suite was run.
