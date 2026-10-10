# P12 Sensitive Read Authentication Boundary — Design Landing

Status: fixed P12/P13 owner contracts applied under the user's standing
authorization; no production implementation in this change.

## Authorization and fixed candidate

- Candidate: `planning/proposals/P12-view-read-auth-boundary-draft.md`
- Candidate LF SHA-256: `90BCB4224D501FA10D949D386DE4B2C667F4256FECDC0D61E29C6836B552F89B`
- Independent review: Blocking = 0 at `f7a187fd691181f8d3e0d7d0bec0febd1a50326d`.
- Applied under the user's standing authorization to land high-confidence,
  independently reviewed design. Scope was limited to P12 `10` and P13 `05`,
  the semantic owners for transport authentication and WebSocket invalidation.

## Owner landing and blob digests

Digests below are SHA-256 over the exact Git blob bytes (the staged/committed
blob, not the CRLF working-tree representation). The repository's Git blob
content is LF-normalized. Existing owner labels are preserved: P12 `10` keeps
its `v1.13 G6` title marker; P13 `05` has no numeric revision marker.

| Owner | Change | Git blob SHA-256 |
|---|---|---|
| `docs/design/implementation/P12/10-transport-shells.md` | Sensitive HTTP/SSE/WS read admission, no-auth listener boundary, first-view-frame proof, supported principal, unchanged command order, local-only path and multi-principal boundaries | `043E8B5D50B0926467CB46B5DDA02605C72A54260FD7954EEA5B0A997367FC91` |
| `docs/design/implementation/P13/05-transport-build.md` | Existing WS frame schema reused; first view token proof before query/fanout/freshness; no URL credential or new frame kind | `F1B9A7D960D1460D74474B94F30783F6730ED169DE439240F1B25D22B1F84217` |

No P10 DTO/visibility change was made. The existing authorized local Workspace
Detail may retain `ResourceBoundary`; F21's path-free catalog remains stricter.
Project/Workspace visibility for multiple principals remains OPEN.

## Contract consistency

- Default no-auth loopback remains the local single-user experience.
- Non-loopback without authenticator fails closed for `/projects`, supported
  `/views`, conversation-progress SSE, and `/ws` before the corresponding
  source/query/broadcast access.
- With authenticator, sensitive reads admit only `user:local`; invalid,
  missing, or unsupported principals return no protected DTO/path/identity or
  progress events. Read permission is not inferred from command authority.
- HTTP only supports `POST /views/:view`; unsupported methods do not invoke
  ProjectionQueryPort. Supported view authentication precedes body decoding
  and projection access.
- On an authenticated listener, the first normal WS `view` frame carries the
  in-memory session credential in the existing `token?` field. It authenticates
  before query and fanout admission. No credential is put in URL/query and no
  frame kind is added. The client cannot claim fresh before the authenticated
  view response; WS command frames do not grant view subscription.
- `/project-resources` keeps its existing stricter no-auth/non-loopback guard
  and path-free payload. Public static assets and local CLI admin/ops remain
  outside the remote read boundary. Command authentication/Actor/Resolver/
  Gateway receipt order and F23 tuple semantics are unchanged.

## Evidence and remaining qualification

The pending test at
`tests/functional/pending/p12-view-read-auth-boundary.functional.test.ts`
provides isolated, sanitized RED evidence: unauthenticated wildcard HTTP reads
leak a project name/IDs and view fields, and a wildcard/no-auth WS client is
accepted and receives an in-memory invalidation. It uses a temporary database,
binds only a local ephemeral test server, connects only to `127.0.0.1`, and
prints no actual project name or canonical path. Valid local-principal and
loopback controls pass; `/project-resources` retains its existing guarded,
path-free behavior. The full evidence and test command are in
`planning/results/P12-view-read-auth-boundary-evidence.result.md`.

This is a design landing, not implementation or closure evidence. Still open:

- production HTTP method gating and proof auth precedes every query-capable
  method;
- SSE no-auth/non-loopback, authorized stream, and source-not-touched tests;
- WS configured-auth first-frame positive/negative tests, query-before-auth
  exclusion, authorized broadcast and browser freshness behavior;
- Project/Workspace visibility for multiple principals;
- any separate policy to redact canonical paths from authorized local detail.

No tests or full gates are claimed by this design-only commit. `docs/design/**`
changes are exactly the two listed owner files; production and test files are
unchanged in this landing commit.
