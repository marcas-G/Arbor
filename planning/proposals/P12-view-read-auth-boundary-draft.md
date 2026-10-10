# P12 Sensitive Read Transport Authentication Boundary

**Status: DRAFT — not accepted; no production or design-owner changes are authorized by this file.**

## Problem and evidence

Arbor's single-user daemon stores canonical Workspace `ResourceBoundary`
addresses. F21's Profile selector and `GET /project-resources` catalog are
path-free: the public catalog exposes only ref, version, display name and
availability, while the trusted Profile lookup carries the canonical address
inside Application. CreateProject persists that address in Workspace state.
P10's frozen `WorkspaceDetailRes` contains `boundary: ResourceBoundary`, and
P13 currently renders FileTree/GitWorktree paths in Workspace Detail. That is
not itself a contradiction of F21's narrower catalog/selector contract: an
authorized local user may see the path they selected.

The security boundary is broader than `/views`. P12 `10` §1/§2 assigns HTTP,
WebSocket, CLI, web-shell, authentication and deployment to P12 and says
external human/parent requests authenticate at the transport boundary. P12
`10` §3 makes authentication precede external command decoding. Current route
inventory at integration base `e122a89fdd7329ef37c9dd962a30df9e7924a575`:

| Surface | Current route/frame | Data / current boundary |
|---|---|---|
| Project directory | HTTP `GET /projects` | Returns project names, ProjectIds, root WorkspaceIds and lifecycle/revision metadata. Configured auth is checked and only `user:local` is admitted, but without an authenticator it maps every request to local principal and lacks the non-loopback listener guard. |
| P10 views | HTTP `POST /views/:view` (implementation currently accepts any method except DELETE); WebSocket `view` frame | Projection DTOs can include WorkspaceIds, project/work facts and canonical host paths. HTTP route and `TransportCore.queryView` do not authenticate. WebSocket view-frame query does not inspect its existing optional token. |
| WS invalidation | Server→client frames on `/ws` | Contains only view id and journal watermark, not DTO/event bodies, per P13 `05` TR-W1. Still exposes view activity/freshness metadata; every successfully upgraded socket currently joins broadcast before authentication. |
| Conversation progress | HTTP/SSE `GET /conversation-progress/:messageId` | Checks configured authentication and stored `human_principal`; without an authenticator it maps requests to local principal and lacks a non-loopback guard. A known message ID can therefore reach that principal's stream on a wildcard/no-auth listener. |
| Resource Profile catalog | HTTP `GET /project-resources` | Path-free catalog. Existing guard rejects non-loopback/no-auth, authenticates when configured, and admits only `user:local`; preserve this stricter existing behavior. |
| Commands | HTTP `POST /commands`; WebSocket `command` frame | Mutating authority path; already calls authenticated submission. This proposal does not change command auth, decode, Actor, Resolver, Gateway or receipt ordering. |
| Static client | HTTP `GET`/`HEAD` non-API paths when static root configured | Public Web bundle/static assets only; no canonical Project/Workspace view DTO. Keep public. Health/readiness is not an HTTP route in `server.ts`; operational HealthPort/CLI output is a local admin surface, not a remote API route. |
| CLI | Local process `view` / `command` commands | CLI view invokes ProjectionQueryPort directly and is not exposed by the HTTP listener; classify as local admin/ops surface. Do not silently claim it is a remote authenticated route. |

The P12 `10` contract is sufficient to classify missing external transport
authentication as an implementation defect for the existing single-user
shell. P15's local project-directory comment explicitly requires a future
visibility resolver before multi-principal listings; the configured-auth
implementation already fails closed for non-local principals. This proposal
does not invent that resolver or multi-tenant policy.

## Proposed minimum contract

1. Preserve the existing no-auth local single-user experience only when the
   listener host is loopback. A non-loopback listener with no authenticator
   fails closed for every sensitive remote read before loading its data.
2. When an authenticator is configured, every sensitive external read first
   authenticates and admits only the existing supported local principal
   (`user:local`). Missing/invalid credentials and unsupported principals
   receive a safe non-success response with no read DTO, canonical path,
   Project name/ID or Workspace ID. Do not infer read permission from command
   authority.
3. Apply this boundary consistently to `GET /projects`,
   `GET /conversation-progress/:messageId`, and every HTTP method that can
   reach a P10 view query. Only the frozen HTTP `POST /views/:view` is a
   supported view method; unsupported methods return a safe non-success result
   without reading request data or invoking ProjectionQueryPort. For any
   supported view, authenticate before body decode and before projection.
   Preserve `/project-resources`' existing stricter guard and path-free DTO.
   Keep command submission authorization semantics/order unchanged.
4. Preserve P13's existing WebSocket frame schema; do not put credentials in
   the URL and do not add a new auth/subscription frame. `WebSocketFrame` in
   P12 already has an optional `token` on its existing `view` and `command`
   frames. For an authenticated listener, the browser sends its first normal
   `view` request frame with the session credential. The server validates that
   credential and `user:local` **before** invoking the view query and before
   adding that socket to invalidation broadcast. A missing/invalid/unsupported
   principal receives no DTO or invalidation and the socket closes. The normal
   query response is the first DTO and can be consumed as an ordinary view
   result; later broadcasts carry only P13's existing invalidation frame.
   Credentials, including the authenticator's Basic credential token, travel
   only in the WebSocket data-frame body, never URL/query parameters.
5. For a no-auth loopback listener, retain the local single-user WS behavior.
   For a non-loopback listener with no authenticator, reject `/ws` at upgrade
   before accepting/subscribing the socket. Configured-auth listeners wait for
   the first authenticated view frame before subscription. A command frame
   retains its existing command-auth path and does not by itself widen view
   subscription permission.
6. Static Web assets and local admin/ops CLI are not remote canonical-data
   read APIs and remain outside this transport rule. If a new HTTP health or
   other read endpoint is later added, classify it by returned data before
   exposure; this draft does not authorize a new endpoint.
7. Project/Workspace visibility for multiple authenticated principals remains
   **OPEN**. The current v1 shell is single-user; this candidate does not add
   multi-tenant visibility, project scoping, or a new principal model.
8. F21's path-free catalog and closed `Profile(ref, version) | ConversationOnly`
   selector remain unchanged. An authorized local Workspace Detail may
   continue to show canonical ResourceBoundary as P10/P13 currently specify.
   If policy requires every local UI surface to hide host paths, govern a
   separate P10/P13 DTO/rendering change.

## Implementation disposition and owners

P12 `10` owns external HTTP/WS/web-shell authentication and deployment. Its
transport-boundary rule supports classifying the missing guards as an
**implementation defect**, not a change to P10 view meaning. P10 `05` owns DTO
shape, P13 `03` owns presentation, and neither is changed here. P13 `05` freezes
client→server frame kinds as `view`/`command`; P12's existing
`WebSocketFrame.token?` is sufficient for the first-view-frame proof, so this
candidate adds no frame schema. P13 client implementation must send its first
ordinary view request with the in-memory session credential and must not report
a remote WebSocket as fresh before that request succeeds. P15's
single-user directory contract supports the configured-principal restriction
but leaves future multi-principal visibility OPEN. No command authority,
Gateway receipt, F21 resource admission, or local detail rendering semantics
are modified.

## Required qualification

- Keep regression coverage under `tests/functional/pending/` until this
  candidate is accepted, implemented and independently reviewed.
- Use an isolated temporary SQLite database and local test servers only. The
  wildcard bind is `0.0.0.0` with an ephemeral port; all requests connect only
  to `127.0.0.1`. Never contact a real remote service or print path/project
  values in test diagnostics.
- RED unauthenticated wildcard `GET /projects` and HTTP view queries; also
  configured-auth missing/invalid/foreign-principal reads. Assert only
  sanitized status and boolean presence of protected values. Prove all HTTP
  methods that could otherwise reach a view query authenticate before that
  query; unsupported methods must not query at all.
- Positive controls: configured valid `user:local` can read, loopback/no-auth
  retains local behavior, and `/project-resources` continues to reject
  wildcard/no-auth while returning its path-free payload to the supported
  local principal.
- Additional route qualification before closure: no-auth wildcard SSE must
  not read a known local principal's progress stream; WebSocket view frames
  must prove `user:local` before query/broadcast; unauthorized requests must
  not reach projection/stream data sources. Command routes remain independently
  covered and unchanged.

This draft does not modify `docs/design/**`, production transports, F21, or
Project/Workspace data semantics. The pending HTTP/WebSocket RED does not by
itself qualify SSE, authenticated WebSocket positive paths, all HTTP methods,
or close multi-principal visibility.
