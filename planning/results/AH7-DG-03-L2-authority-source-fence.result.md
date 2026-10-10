# AH7-DG-03 L2 authority-source fence result

Status: **authority-source fencing repair PASS; AH7-DG-03 remains open.**

This is a follow-up to L2 commit
`94002839f94f9bf7937be192ed41429d3f03f7d6`, performed only in the independent
`ah7-approval-atomicity` worktree. No design document or production behavior
outside the accepted AH7-DG-03 pipeline was changed.

## RED → GREEN evidence

The new file-backed SQLite barrier test:

1. commits the exact ToolInvocation + approval claim;
2. reads the workspace policy revision, active grant ids/revisions and
   verifier binding used by the authority snapshot;
3. pauses after that read;
4. commits a grant revocation over a separate SQLite connection;
5. resumes the effect-admission transaction.

With the same-transaction source revision comparison temporarily disabled, the
test was RED: the gate returned `Admitted` instead of `Denied`. With the
comparison restored, it is GREEN: the gate denies, the invocation remains
`NotAdmitted`, the terminal P4 result is
`Denied(ApprovalNoLongerAuthorized)`, and approval remains consumed by the same
invocation id.

A ToolRuntime barrier test pauses after authority resolution, changes the
authority source before the store gate, then verifies the typed no-effect
denial, one exact approval consumer, and zero executor calls. These two tests
separately prove the runtime response and the real SQLite atomic source check.

An additional adapter test expires the same worker lease at the exact
`expires_at == now` boundary. The fenced effect gate is rejected and the marker
stays `NotAdmitted`.

## Implementation

- Production `ToolAuthorityResolverLive` attaches an implementation-only
  `sourceRevision` to its trusted authority snapshot. It covers workspace
  policy revision, active PermissionGrant identity/revision set, and the
  execution's verifier binding; it adds no authority.
- Immediately before effect admission, Runtime requires this token whenever
  the caller has an execution fence. Missing source provenance fails closed.
- `ToolInvocationStore.admitEffect` recomputes that source token from current
  SQLite rows **inside the same transaction** as the lease/stop check and
  `NotAdmitted → MayHaveStarted` CAS. A mismatch returns typed authority
  denial without changing the effect marker.
- The implementation uses existing source revisions and active-row
  membership; no schema migration or design-document change was needed.
- The P12 provider-tools P4 test mock was adapted to the expanded
  `ToolInvocationStore` interface; its legacy unfenced `context.authority`
  remains test-only. P12 command `AuthorityResolverPort` mocks are a separate
  boundary and are unchanged.
- Health now recognizes the P36 current migration baseline. The P12 daemon
  migration smoke (starting from P34 and upgrading at daemon start) passes.

## Narrow gates

- Focused adapter/migration + ToolRuntime run: **9 files / 29 tests PASS**.
- Focused legacy P12 compatibility selection: **12 files / 52 tests PASS, 1
  pre-existing skipped case** (the P12 composition test containing the local
  tree query was intentionally excluded from this green selection).
- `@arbor/ports`, `@arbor/persistence-sqlite`, `@arbor/tool-runtime`,
  `@arbor/agent-runtime`, and `@arbor/single-workspace` builds PASS.
- Targeted Biome and `git diff --check` PASS.

No full suite, real daemon process/crash matrix, L3 durable AgentLoop
qualification, L4 P9 recovery matrix, push or merge was performed.

The unfiltered P12 composition case still has a separate tree-view response
failure (`403 auth/unsupported-principal`) after its CreateProject request.
This does not traverse AH7 ToolRuntime; it needs the P12 local-principal test
fixture corrected during later integration. The attempted test-only
authorization-header change was removed and is not part of this patch.
