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
