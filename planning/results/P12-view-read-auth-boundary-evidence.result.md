# P12 View Read Authentication Boundary — Isolated Evidence

Status: proposal + pending RED committed on the isolated `e122a89` tree;
not implemented, pushed, or merged.

## Source / workspace safety

- Started from `f23-fixture-core` HEAD `5adef77142cf13c5ff742309f0141528d81104fe`,
  tracked-clean.
- `5adef77` and its AH19 parent `25f4524` change the AH19 provider-gate test
  and core fixture result record. Those two final file blobs are byte-identical
  at integration HEAD `e122a89fdd7329ef37c9dd962a30df9e7924a575`; the source
  commit is patch-equivalent there even though it is not an ancestor commit.
- Safely detached this isolated tree with `git switch --detach e122a89...`;
  no reset/delete was used. `C:\Arbor` and the separate integration worktree
  were not modified.

## Contract disposition

P12 `10` §1/§3 assigns transport authentication/deployment to P12 and states
that external human/parent requests authenticate at the transport boundary.
That is sufficient to classify the missing authentication on external view
requests as an implementation defect for the existing single-user shell.
P10 `05` freezes `WorkspaceDetailRes.boundary: ResourceBoundary`, and P13 `03`
renders the boundary. P1/P12 F21 constraints instead keep canonical paths out
of the Profile-list/selection surface and client payload; `ProjectResourceProfilePort.list`
does not return `canonicalAddress`, while CreateProject persists the trusted
canonical address in Workspace state. Thus seeing a path in local Workspace
Detail is not itself a contradiction of F21.

Multi-principal Project/Workspace view visibility is not established by these
contracts. The draft keeps it OPEN and admits only `user:local` on the
single-user view boundary. It does not infer read authority from command
resolver facts or expand into a multi-tenant model. F21's path-free catalog,
CreateProject selector, and local Workspace Detail DTO/rendering are unchanged.

## RED evidence

Pending test: `tests/functional/pending/p12-view-read-auth-boundary.functional.test.ts`.
It uses a temporary SQLite DB, seeds one Workspace with a real canonicalized
FileTree path, starts ephemeral `0.0.0.0` listeners, and sends HTTP only to
`127.0.0.1`; it contacts no non-local service. Failure diagnostics contain
only HTTP status and boolean indicators, never the path value.

The expected-denial assertion REDs on current behavior. The sanitized
observations show:

- unauthenticated non-loopback `/views/workspace-detail`: HTTP 200,
  `canonicalPathReturned=true`;
- unauthenticated non-loopback responsibility-tree: HTTP 200,
  `workspaceIdReturned=true`;
- configured-auth missing token / invalid token / foreign `user:foreign`
  requests: HTTP 200; detail responses have `canonicalPathReturned=true`,
  tree responses have `workspaceIdReturned=true`;
- configured valid `user:local` token: HTTP 200 with the expected local view;
- default loopback without an authenticator: HTTP 200 with the expected local
  Workspace Detail path.

The positive token and loopback assertions precede the expected-denial
assertion and pass before Vitest reports the intended RED. RED exit: 1 failed
test, at least five unauthorized observations returned data.

## Verification and boundary

- `pnpm typecheck` — PASS.
- Targeted Biome for the new pending test — PASS.
- Targeted pending test — intentionally RED as above; no fix applied.
- No full check/functional tests were run.
- Only this proposal, this result record, and the pending test were added.
- No production code or `docs/design/**` changed. The proposal is DRAFT and
  unaccepted; production `/views` behavior is unchanged.

## Recommended follow-up

Review the P12 transport defect and agree the narrow single-user rule before
implementation. First add transport authentication and fail closed for
non-loopback/no-auth view requests. Keep project/workspace visibility for
multiple principals OPEN until a separate read-authorization contract exists.
If the product wants paths hidden from every UI, govern a separate P10/P13
redacted boundary DTO; do not conflate that with F21's path-free selector.
