# P12 Sensitive Read Authentication Boundary — Route Audit and RED

Status: expanded governance candidate + pending HTTP RED; not implemented,
accepted, pushed, or merged.

## Source and workspace safety

- Audit base: integration commit `e122a89fdd7329ef37c9dd962a30df9e7924a575`.
- Prior single-route candidate: `81c9ada8b4e05526b10d7c24a420872c5cef13c0`.
- This revision was made only in the isolated `f23-fixture-core` checkout, now
  detached at the integration base plus that prior candidate. It did not touch
  `C:\Arbor` or the separate integration tree.
- No production code or `docs/design/**` was edited. The candidate remains
  DRAFT and does not claim that the new boundary is implemented.

## Public read-route inventory

Reviewed `apps/single-workspace/src/transport/server.ts`, `http.ts`,
`websocket.ts`, `cli.ts`, `main.ts`, P12 `10`, P10 `01`/`05`, and P13 `03`/`05`.

| Read surface | Access and sensitivity at audited base | Disposition in candidate |
|---|---|---|
| HTTP `GET /projects` | Lists ProjectId, name, lifecycle, root WorkspaceId and revision. Configured authenticator admits only `user:local`, but absent authenticator maps all callers to local principal without checking listener host. Wildcard/no-auth leaks directory data. | Sensitive read: require local transport boundary; no-auth non-loopback fail-closed. Keep foreign-principal visibility fail-closed and multi-principal policy OPEN. |
| HTTP `POST /views/:view` | Projection DTOs; Workspace Detail includes canonical boundary path; tree and other views expose project/workspace facts. HTTP shell and `queryView` do not authenticate. HTTP implementation currently matches any method except DELETE, which should not be treated as a separately authorized read API. | Sensitive read: authenticate before projection; preserve current POST contract and do not broaden methods. |
| WebSocket `view` frame on `/ws` | Upgrade accepts without auth; `WebSocketFrame` already has an optional `token`, but `makeWebSocketShell` ignores it for views and calls `queryView`. DTO sensitivity is the same as HTTP views. | Reuse the existing first ordinary `view` request with token as proof; authenticate and restrict to `user:local` before query and before broadcast admission. No URL token or new frame kind. |
| WebSocket invalidation frames | Server broadcasts `{view, watermark}` only; P13 `05` TR-W1 says no DTO/event body. It still exposes view freshness/activity metadata to every socket immediately after unauthenticated upgrade. | A socket is not subscribed until the existing authenticated view frame succeeds. Reject non-loopback/no-auth upgrade; no-auth loopback keeps local behavior. |
| HTTP/SSE `GET /conversation-progress/:messageId` | With configured auth, validates authenticated principal against stored human principal. Without auth it maps callers to local principal and does not check listener host; known message ID may expose that principal's stream on wildcard/no-auth bind. | Sensitive read: preserve ownership check and add the common non-loopback/no-auth fail-closed boundary. |
| HTTP `GET /project-resources` | Path-free Profile catalog. Existing code already rejects non-loopback/no-auth, authenticates configured auth, and admits only `user:local`. | Preserve existing stricter boundary and path-free payload unchanged. |
| HTTP `POST /commands`; WebSocket `command` frame | Mutation/submission path, not a read DTO. Submission authenticates at core/application boundary. | Out of this proposal; do not alter command auth/decode/Actor/Resolver/Gateway/receipt ordering. |
| Static `GET`/`HEAD` non-API paths | Public Web bundle/assets only; no canonical Project/Workspace view DTO. | Remain public. |
| HTTP health/readiness | No health/readiness HTTP route found in `server.ts`; HealthPort/CLI operational output is not an exposed HTTP endpoint in this shell. | No new route authorized. Classify any future endpoint by returned data before exposure. |
| CLI `view`/`command` | CLI view directly queries in-process projection; it is a local admin/ops process and is not reachable through the HTTP listener. | Outside remote transport rule; no CLI semantics changed. |

P12 `10` §1/§2 assigns transport/auth/deployment surfaces to P12 and §3 says
external human/parent requests authenticate at the boundary. P12's existing
`WebSocketFrame.token?` is a non-URL credential field; P13 `05` freezes frame
kinds as `view`/`command` and the Web client stores its credential in memory,
so an authenticated first ordinary `view` request can gate subscription without
inventing a protocol frame. This requires P13 client wiring to send that first
request and to report the remote channel as fresh only after success. This supports an
implementation-defect classification for the missing external read guards.
P15's local-single-user directory note requires a future visibility resolver
for multi-principal listings; P10/P13 do not provide such a resolver. The
candidate therefore keeps that policy OPEN rather than extending command
authority or inventing tenant visibility. F21 path-free catalog/selector and
authorized local Workspace Detail rendering remain distinct contracts.

## Isolated RED evidence

Pending test:
`tests/functional/pending/p12-view-read-auth-boundary.functional.test.ts`.
It seeds a temporary SQLite database and canonical FileTree boundary, starts
only local ephemeral test listeners bound to `0.0.0.0`, and connects exclusively
through `127.0.0.1`. It does not contact a real remote service. Assertions and
failure output contain only HTTP status and boolean presence indicators; no
path or project-name value is printed.

Command: `pnpm exec vitest run --config vitest.pending-functional.config.ts tests/functional/pending/p12-view-read-auth-boundary.functional.test.ts`

Observed intentional RED: one test fails because six unauthorized external
view/directory reads returned HTTP 200 and/or protected data, and because the
unauthenticated wildcard WebSocket was accepted and received a broadcast
invalidation:

- no-auth wildcard Workspace Detail: 200, canonical path present;
- no-auth wildcard responsibility tree: 200, WorkspaceId present;
- no-auth wildcard `GET /projects`: 200, project name, ProjectId and root
  WorkspaceId present;
- configured-auth missing-token Workspace Detail: 200, canonical path present;
- configured-auth invalid-token tree: 200, WorkspaceId present;
- configured-auth foreign-principal Workspace Detail: 200, canonical path
  present.
- unauthenticated wildcard WebSocket: `connected=true`,
  `frameReceived=true` after the test directly publishes a sanitized
  `{view, watermark}` invalidation through its isolated in-memory fanout.

Positive/control assertions before the RED passed: configured valid
`user:local` can read Workspace Detail and project directory; loopback/no-auth
can read both; `/project-resources` on wildcard/no-auth returns 503 and its
authorized path-free response returns 200 without the canonical path. A
configured-auth `GET /projects` with missing, invalid and foreign-principal
credentials is also in the expected-denial observations; these sanitized
checks confirm the existing configured-auth directory gate remains in place.
No route behavior was changed to obtain this evidence.

The RED directly establishes `/projects`, HTTP view, and unauthenticated WS
broadcast gaps. It does not establish WS configured-auth token/frame gating,
HTTP WS-view dispatch authorization-before-query, or SSE behavior; those need
dedicated positive/negative qualifications before closure.

## Verification and remaining scope

- `pnpm exec biome check tests/functional/pending/p12-view-read-auth-boundary.functional.test.ts` — PASS.
- `pnpm typecheck` — PASS.
- Pending test — intentional RED, one test failure with six leaking HTTP
  observations plus wildcard WS accepted/broadcast booleans; this is expected
  red-contract evidence, not a suite pass.
- No full check or functional suite was run.
- The proposal is unaccepted. Production and frozen design documents are
  unchanged.
- Open qualifications: dedicated SSE unauthorized/authorized stream test;
  WebSocket authenticated first-view frame/invalid token tests and authorized
  broadcast test; prove unauthorized requests do not reach projection/stream
  sources; all query-capable HTTP method gating; future multi-principal
  Project/Workspace visibility; any separate policy to redact canonical paths
  from authorized local detail.
