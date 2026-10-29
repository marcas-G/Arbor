# F23 Wave 2 — External Command Boundary

Date: 2026-10-10
Accepted contract: `ACCEPT_EXTERNAL_COMMAND_RUNTIME_CODEC`
Accepted proposal SHA-256: `DD24C9550BFE253D94DE7236255E5E8E710A7E612A57607E474E8A90653529FC`

## Result

**Wave 2 external HTTP/WebSocket/CLI wiring is implemented and focused
qualification passes. F23 / FT-DG-03 remains OPEN.** The external path now
authenticates before command schema inspection and applies the Wave 1 strict
wire-v1 decoder in Composition before resolving authority or entering the
Gateway.

The request path is:

```text
HTTP / WebSocket / CLI raw unknown
  → authenticate Principal
  → decode registered wire-v1 envelope and payload
  → derive Handler schema and semantic fingerprint
  → exact string Actor == authenticated Principal
  → reject descriptors that disallow external origin
  → load current facts / active Grants and run Resolver
  → existing Gateway transaction and receipt boundary
```

Malformed payloads return the non-reflecting `InvalidCommandPayload` Problem
with HTTP status 400, stable schema-authored issue paths, and no receipt,
attempt, Resolver invocation, Gateway invocation, or canonical event. Unknown
command names and caller property names/values are never reflected. A valid
but mismatched Actor is rejected as `authority/denied` before facts loading or
Resolver. A syntactically valid command whose registered descriptor disallows
external origin is also rejected before facts loading or Resolver. That
deny-only origin gate does not authorize commands whose descriptor permits
external origin; they still require the P12 Resolver and Gateway authority
checks. Internal/model execution routes do not enter the external submission
port.

## Public F23 reproduction and repair

Before implementation, the isolated public-process F23 case reproduced the
original failure: `SubmitHumanMessage` with
`messageId = "msg_not-a-uuid-v7"` returned HTTP 200 and a `Committed` receipt.
After implementation, the same public HTTP case returns HTTP 400 with:

```text
code: InvalidCommandPayload
message: Command payload is invalid
safeDetails.commandType: SubmitHumanMessage
safeDetails.issues: [{ path: ["payload", "messageId"], rule: "format" }]
```

The test confirms the rejected value is not echoed, the transcript does not
contain the submitted body, and read-only inspection finds no matching
`commands` row, `command_attempts` row, or `domain_events.caused_by_command_id`.
The invalid `AcceptanceId` public case also remains rejected; both isolated F23
cases pass.

## CreateProject wire-shape compatibility

The accepted strict payload contract follows P1 `CreateProjectPayload`: the
`projectId` belongs to the outer envelope and is not a payload field. Existing
browser and test callers duplicated it inside `payload`, which the exact
closed codec correctly rejected as an unknown field. The Web form and public
fixture helpers now keep the ID only in the envelope. The P13 E2E fixtures
also generate UUIDv7 IDs required by the accepted branded-ID codec instead of
UUIDv4 values. These are caller/fixture alignment changes; the codec schema
and domain semantics were not relaxed.

Normal project creation remains covered by the real P13 Composition HTTP and
WebSocket E2E tests, and the browser form test asserts that the envelope keeps
the project ID while the payload omits it.

## Changed scope

- HTTP, WebSocket, and CLI now pass raw `unknown` command envelopes through the
  authenticated transport core without envelope casts or pre-authentication
  schema checks.
- Composition decodes into `DecodedExternalCommandEnvelope`, binds the exact
  authenticated Actor, derives the existing Handler schema/fingerprint, then
  loads Resolver inputs and invokes the existing Resolver/Gateway path.
- Transport Problem mapping adds the frozen validation → HTTP 400 mapping.
- Regression coverage includes authentication priority and raw forwarding for
  all three shells, malformed-input short-circuiting, Actor binding and
  Resolver/Gateway order, registry parity, P13 HTTP/WebSocket behavior, F23
  public behavior, registered origin denial, and valid CreateProject callers.
- No file under `docs/design/**`, Application Gateway implementation, receipt
  store, migration, or SQL contract was changed. No functional test was
  promoted from the pending suite.

## Verification

- Pre-implementation public F23 MessageId case: **RED reproduced** — HTTP 200,
  `Committed`.
- Focused shell/composition/codec/registry/P13 HTTP+WebSocket/P12 transport
  command: **PASS, 7 files / 49 tests**.
- Raw external `AssignWork` negative control: **RED reproduced** before the
  deny check with `load-inputs`, Resolver, and Gateway all called and a
  `Committed` result; after the fix, the descriptor denies it before those
  calls. Focused rerun: **PASS, 3 files / 10 tests**; P12 transport and P13
  HTTP/WebSocket rerun: **PASS, 2 files / 16 tests**.
- Pending F23 public cases: **PASS, 2 / 2**.
- S1/S3 public CreateProject regression: **PASS, 1 / 1**.
- B01 public conversation/CreateProject regression: **PASS, 1 / 1**.
- Web `CreateProjectForm` tests: **PASS, 15 / 15**.
- Root TypeScript build and test typecheck: **PASS** (`pnpm typecheck`).
- Web TypeScript check: **PASS** (`pnpm --filter @arbor/web typecheck`).
- Biome on the 20 changed source/test files: **PASS**.
- Architecture suite previously run in this worktree: **PASS, 31 files / 158
  tests**.
- `git diff --check`: **PASS**.
- `pnpm check` was not independently completed for this wave. An early attempt
  stopped in the repository-wide lint step at the pre-existing
  `packages/agent-runtime/src/model-decision.ts:4070` non-null assertion, so
  the later check stages did not run. Per coordination, the merged waves will
  receive one traceable full `pnpm check`; this result makes no full-check
  claim. Full `pnpm test:functional` was not run.

## Remaining work

This result does not close F23. Wave 2 qualifies the external entry boundary
and the focused malformed-ID journey only. Typed internal submission
validation, receipt/historical-row behavior and inventory, broader replay and
visibility cases, concurrency qualification, and the overall release matrix
remain outside this result or open. The F23 tests remain isolated pending
formal qualification and promotion.
