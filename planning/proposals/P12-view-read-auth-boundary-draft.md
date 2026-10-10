# P12 View Read Authentication Boundary

**Status: DRAFT — not accepted; no production or design-owner changes are authorized by this file.**

## Problem and evidence

The local single-user daemon stores canonical Workspace `ResourceBoundary`
addresses. F21's Profile selector and `GET /project-resources` catalog are
path-free: the public catalog exposes only ref, version, display name and
availability, while the trusted Profile lookup carries the canonical address
inside Application. CreateProject persists that address in the Workspace.

That does not mean every view is path-free. P10's frozen `WorkspaceDetailRes`
contains `boundary: ResourceBoundary`; the projection returns the canonical
Workspace boundary, and P13 currently renders `FileTree.path` and
`GitWorktree.path` in Workspace Detail and its header. That is not, by itself,
a contradiction of F21's narrower catalog/selector contract. The local
single-user loopback user may see the path they selected.

There is a separate transport boundary defect. P12 `10` §1/§3 assigns HTTP,
web-shell authentication and deployment to P12 and says external human/parent
requests are authenticated at the transport boundary. The current
`POST /views/:view` route calls `TransportCore.queryView` without passing or
checking a credential; `queryView` directly invokes `ProjectionQueryPort`.
The command route authenticates, but the view route does not. The server
defaults to loopback and `main.ts` describes unauthenticated operation as a
loopback desktop process; however, `ARBOR_HTTP_HOST` can select a non-loopback
bind. The separate Profile catalog route has a non-loopback/no-auth guard,
but `/views` does not.

On a remotely reachable listener, an unauthenticated caller can POST a known
WorkspaceId to `/views/workspace-detail` and receive canonical boundary
paths. `WorkspaceDetailReq` contains only WorkspaceId; the projection query
has no principal or project-visibility context. A known ProjectId can also be
queried through the unauthenticated responsibility-tree view to obtain
WorkspaceIds. No real remote service is contacted by the attached RED test.

## Proposed minimum contract

1. Preserve current local behavior: with no configured authenticator and a
   loopback listener, the local single-user principal may query views.
2. With no authenticator, a non-loopback listener must fail closed for views
   (preferably reject the configuration or return a safe non-success Problem
   before projection data is loaded). The guard applies to every view, not
   only `/project-resources`.
3. With an authenticator configured, every external view request authenticates
   before ProjectionQueryPort access. Only the existing supported local
   principal (`user:local`) is admitted by this single-user read surface;
   missing/invalid credentials and unsupported principals receive a safe
   non-success response with no DTO/path data. This does not alter command
   submission, Authority Resolver ordering, or grants.
4. Do not infer cross-principal read permission from command authority.
   Project/Workspace visibility for multiple authenticated principals remains
   **OPEN**; this proposal does not introduce a multi-tenant model or claim
   foreign-project isolation.
5. F21's path-free catalog and closed `Profile(ref, version) |
   ConversationOnly` CreateProject selector remain unchanged. An authorized
   local Workspace Detail may continue to show canonical ResourceBoundary as
   P10/P13 currently specify. If product policy requires every UI surface to
   hide host paths, that is a separate P10/P13 view DTO/rendering decision.

## Implementation disposition and owners

P12 `10` already owns HTTP/web-shell authentication and deployment, and its
§3 authentication-at-transport rule is sufficient to classify the missing
view authentication as an **implementation defect** for the current local
human shell. P10 `05` owns view shape/semantics and P13 `03` owns rendering;
neither currently requires redacting Workspace Detail's ResourceBoundary.
The multi-principal visibility decision is not specified by those view
contracts and remains OPEN. This candidate proposes only a fail-closed
single-user boundary until that policy is separately governed.

## Required qualification

- Keep the regression under `tests/functional/pending/` until implementation
  is accepted and independently reviewed.
- Use a temporary SQLite database with a known canonical FileTree boundary;
  start only local test listeners (`host: 0.0.0.0`, ephemeral port) and connect
  exclusively through `127.0.0.1`.
- RED the unauthenticated non-loopback and configured-auth missing/invalid or
  unsupported-principal `/views/workspace-detail` and responsibility-tree
  requests; record only status and booleans for path/WorkspaceId presence, never
  the path value.
- Positive controls: configured valid `user:local` token can query; default
  loopback with no authenticator preserves current local behavior.
- Verify `/project-resources` remains path-free, no command mutation path is
  changed, and no query result leaks in unauthorized responses.

This draft does not modify `docs/design/**`, production transports, F21, or
Project/Workspace data semantics.
