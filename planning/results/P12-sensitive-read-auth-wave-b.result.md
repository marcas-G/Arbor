# P12 Sensitive Read Authentication — Wave B (WebSocket)

Status: WebSocket read-subscription authentication is implemented and
qualified in the isolated tree. HTTP/SSE Wave A remains in
`planning/results/P12-sensitive-read-auth-wave-a.result.md`.

## Contract implemented

- `/ws` with no configured authenticator on a non-loopback listener is
  rejected before `wss.handleUpgrade`; the connection is never admitted to
  the broadcast set.
- No-auth loopback retains local-single-user behavior: a local socket can
  receive invalidations and can make its ordinary view request without a
  credential.
- A configured-auth listener may complete the WebSocket upgrade, but the
  socket is not added to invalidation fanout until its first ordinary `view`
  frame authenticates as `user:local`. The request uses the existing
  `WebSocketFrame.token?` field. The server authenticates before calling
  `ProjectionQueryPort`; missing, invalid, or unsupported-principal frames
  return no DTO, close with policy failure, and never subscribe.
- Later `view` frames on an authenticated connection use the bound local
  connection identity. A `command` frame keeps its existing authenticated
  command path but does not admit an unproved socket to view invalidations.
- The browser sends a real initial Attention view request from the in-memory
  session token/project id. It never places credentials in the WebSocket URL.
  `AppProviders` marks freshness only after the successful first view response;
  invalidations received before that response are buffered and then trigger
  the normal protected HTTP refetch. A server policy close does not reconnect
  with the same rejected proof.

No new frame kind/schema, HTTP/SSE behavior, command authority, F23 receipt
ordering, P10 DTO, or multi-tenant policy was added.

## RED evidence and qualification

At the Wave A base `917c176`, source inspection showed `server.ts` called
`wss.handleUpgrade`, immediately inserted every socket into the broadcast set,
and `makeWebSocketShell` ignored `token` for `view` frames. The prior sanitized
wildcard/no-auth WebSocket RED is recorded in
`planning/results/P12-view-read-auth-boundary-evidence.result.md`; the Wave A
completion record was corrected to make clear that `/ws` was then still OPEN.
The new configured-auth first-frame matrix was added with this implementation;
it was not separately rerun against an old-source checkout. Its regression
assertions encode the pre-fix source behavior and now pass on the fixed server.

Pending integration test:
`tests/functional/pending/p12-view-read-auth-boundary.functional.test.ts`.
It uses temporary SQLite and actual local Node WebSocket/HTTP servers; all
client connections target `127.0.0.1`. It reports sanitized booleans/statuses,
not credential or Project/Workspace values.

- Configured-auth socket before first frame: no broadcast and no view query.
- Missing, bad, and foreign first-view credentials: socket closes; no DTO,
  query source call, or invalidation subscription.
- Valid `user:local` first view: one query returns 200; only then does a
  published invalidation reach that socket.
- Valid command-only frame: does not create view subscription or receive an
  invalidation.
- No-auth wildcard: upgrade rejected before connection; no invalidation.
- No-auth loopback: initial view returns 200 and local invalidation is
  delivered.

The Wave A + Wave B pending file passes 2/2 tests.

## Late-authenticator close race

WebSocket admission now tracks per-connection closure and a single in-flight
first-view authentication. Duplicate first-view frames while authentication is
pending do not start parallel authentication/query paths. After the await, the
server rechecks both the close state and `ws.readyState` before query or
broadcast admission. A close callback removes the socket immediately; a late
successful auth result cannot reinsert it. `WebTransportHandle` exposes only
an in-process subscriber count for deterministic qualification (no network
route).

A delayed-authenticator regression in
`apps/single-workspace/test/p13-web-transport.test.ts` sends two first-view
frames, waits for auth to block, closes the client, then resolves auth as
`user:local`. It asserts one auth call, zero ProjectionQuery calls, zero
broadcast subscribers, and no post-close frame. The focused case passes 1/1.

Web-client and targeted regression evidence:

- `pnpm --filter @arbor/web typecheck` — PASS.
- `pnpm --filter @arbor/web test -- ws-invalidation-query.test.tsx invalidation-channel.test.ts` — PASS, 7/7.
- Targeted P12/P13 set (`tests/p12-transport.test.ts`,
  `tests/external-command-boundary.test.ts`, `tests/p12-acceptance.test.ts`,
  and three single-workspace P13 transport/e2e/catalog files) — PASS, 55/55.
- Root `pnpm typecheck` — PASS.
- Biome on all touched code/test files — PASS.
- No full `pnpm check`, functional suite, or separate Playwright browser
  process was run; the web client qualification is React Testing Library plus
  real-server P13 e2e.

## Remaining scope

- Project/Workspace visibility for multiple authenticated principals remains
  OPEN by design; only `user:local` is admitted to v1 sensitive reads.
- This is not separate-process daemon restart or cross-origin/TLS deployment
  qualification. Credentials are proven to remain out of URLs/logged test
  output; secure remote transport deployment is outside this change.
