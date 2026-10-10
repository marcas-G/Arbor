# P12 Sensitive Read Authentication — Wave A (HTTP/SSE)

Status: Wave A implementation and focused local-server qualification complete.
WebSocket authentication/subscription (Wave B) and multi-principal visibility
remain open.

## Scope

Implemented only HTTP/SSE sensitive-read admission in the isolated
`f23-fixture-core` tree, based on design landing
`97cbf93270b2698bd3a623c6e6e9ff04839b36d0`. Changed production files:

- `apps/single-workspace/src/transport/core.ts`
- `apps/single-workspace/src/transport/http.ts`
- `apps/single-workspace/src/transport/server.ts`

Focused test fixture updates:

- `tests/functional/pending/p12-view-read-auth-boundary.functional.test.ts`
- `tests/p12-transport.test.ts`
- `tests/p12-acceptance.test.ts`

No WS server/client code, command authority/order, static serving, resource
catalog logic, P10 view semantics, or canonical detail path DTO was changed.

## Behavior

- `GET /projects` now authenticates and requires `user:local` before
  `ProjectDirectory.list()`. A no-auth non-loopback listener fails closed;
  configured missing/invalid credentials fail 401; foreign principal retains
  the safe visibility-resolver-required response. Loopback/no-auth local
  behavior remains.
- Supported HTTP view reads are exactly `POST /views/:view`. The server
  rejects other methods without decoding their bodies or calling
  ProjectionQueryPort. On the supported POST route, non-loopback/no-auth and
  configured missing/invalid/foreign credentials fail before reading the
  request body and before query. Direct `HttpShell.handle` callers also pass
  the same existing Authenticator and local-principal gate.
- `GET /conversation-progress/:messageId` authenticates and requires
  `user:local` before querying `human_messages` or subscribing to the progress
  hub. Existing stored-human-principal binding remains. No-auth non-loopback
  is rejected; valid configured local and loopback local reads remain.
- `/project-resources` retains its existing stricter path-free guard. HTTP
  command routing and static Web asset handling are unchanged.

## RED → GREEN and verification

The pending regression uses a temporary SQLite database, known Project,
Workspace and human MessageId, and actual local HTTP listeners bound to
ephemeral ports. The wildcard listener is contacted only via `127.0.0.1`; no
external service is contacted. Sanitized spies count ProjectionQueryPort,
ProjectDirectory and progress-hub source calls. Failure output uses only
statuses and booleans/counts, not project names or canonical paths.

Before implementation, the test reproduced:

- unauthenticated wildcard project listing: protected data returned and
  `ProjectDirectory.list()` called once;
- unauthenticated wildcard known-message SSE: HTTP 200 event stream and one
  progress-hub subscription;
- configured unauthenticated/invalid/foreign view requests: DTOs returned;
- view methods GET/PUT/PATCH/OPTIONS reached the query source (four calls);
  DELETE was already rejected.

After implementation, the pending test passes 1/1. It asserts zero source
calls for unauthorized wildcard/configured reads and unsupported view
methods, safe non-success statuses, configured `user:local` and loopback
positive reads, authorized SSE stream access, and the existing path-free
catalog control. All 5 methods in the negative matrix return 400 with zero
projection calls.

Verification:

- `pnpm exec biome check` on all six changed code/test files — PASS.
- `pnpm typecheck` — PASS.
- `pnpm exec vitest run --config vitest.pending-functional.config.ts tests/functional/pending/p12-view-read-auth-boundary.functional.test.ts` — PASS, 1/1.
- Targeted P12/P13 regression command covering `tests/p12-transport.test.ts`,
  `tests/external-command-boundary.test.ts`, `tests/p12-acceptance.test.ts`,
  `apps/single-workspace/test/p13-web-transport.test.ts`, and
  `apps/single-workspace/test/project-resource-profile-catalog.test.ts` —
  PASS, 48 tests.
- Full `pnpm check` and full functional suite were not run.

The first targeted P12 regression attempt exposed three old HTTP view test
fixtures authenticated as non-local principals. They were corrected to use a
dedicated `user:local` read token while preserving their command identity and
assertions; the focused P12/P13 run then passed.

## Remaining scope

- Wave B is still required: authenticated first WS `view` frame, no
  pre-auth query/broadcast, and browser freshness behavior. The existing WS
  implementation was intentionally untouched; its prior wildcard invalidation
  RED remains applicable.
- Multi-principal Project/Workspace read visibility remains OPEN.
- This qualification starts the actual local HTTP server and temporary DB
  inside the Vitest process; it is not a separate child-process daemon/restart
  qualification.

## Follow-up: explicit configured-authenticator provenance

Independent review found that the original Wave A test constructed a local
`makeHttpShell` and omitted `startWebTransport.authenticator`; it did not model
production Composition. In production, `TransportBoundary.authenticator` is
always non-null because Composition substitutes `makeLocalAuthenticator()`
when no authenticator is configured, and `main` passes that fallback object to
the server. Thus the first Wave A guard's `config.authenticator === undefined`
test could not distinguish configured auth from the local fallback on a
wildcard bind.

The follow-up adds the explicit `TransportBoundary.authenticatorConfigured`
composition fact (derived from `SingleWorkspaceConfig.authenticator` before
fallback) and passes it through `main` into required
`WebTransportConfig.authenticatorConfigured`. Sensitive routes, including
the pre-existing `/project-resources` guard, now use that trusted bool plus
listener host, never object non-nullness. The authenticator remains available
to perform credential validation when the bool is true. No handler reads
global environment state.

The new pending regression builds the real `buildSingleWorkspaceLayer` with
no configured authenticator, confirms its Composition boundary still contains
the local fallback object while `authenticatorConfigured=false`, then starts
the real local HTTP server with that pair on both `0.0.0.0` and loopback. On
wildcard, `/projects`, `/views`, known-message SSE and `/project-resources`
all return 503 with zero ProjectDirectory/Profile/authorized-view/progress
subscription source calls. The same composition on loopback preserves local
200 responses for all four. This test was RED before the explicit-state fix
(`GET /projects` returned 200) and is now GREEN.

Follow-up verification:

- `pnpm typecheck` — PASS.
- Biome on all touched source/test files — PASS.
- Both pending Wave A tests, including configured missing/bad/valid/foreign
  credentials and real Composition fallback — PASS, 2/2.
- P13 local transport/e2e/catalog tests — PASS, 25/25.
- No full `pnpm check` or full functional suite was run.

The P13 HTTP e2e fixture previously used its `user:human` command credential
for a P10 view read. It now provides a separate `user:local` read token for
that query while retaining the original human command identity and command
assertions; the updated P13 tests pass.
