# P11 — 12 Worktree Sandbox Binding

**Authority:** DID v1.25 EWB-1…EWB-10; P4 `04`.
**Status:** FROZEN.

## 1. Managed-worktree binding

The primary writable coding mount is a `GitWorktree` already created and
governed by the P11 Worktree lifecycle. Opening a tool sandbox binds that
resource as logical mount `workspace`.

Provider strategies may differ without changing the tool contract:

```text
LocalTrusted     -> bind the managed worktree directly
Container/Remote -> mount the managed worktree at an isolated provider path
ReadOnlyMirror   -> materialize a read-only resource into an adapter-owned root
```

A managed worktree is already the integration boundary. The default writable
path does not copy the entire tree to another temporary root and copy it back
on close. That historical strategy is retired because it loses mount identity,
can overwrite concurrent changes and can cross-write multiple backings.

## 2. Lifecycle and convergence

- Creation/retirement still goes through `CreateWorktree` / `RetireWorktree`.
- `open` never creates a worktree implicitly for an unresolved mount.
- Directly bound worktree changes are immediately fingerprint-visible; the
  existing environment watcher / explicit Governance change path records the
  environment transition. Sandbox close is not the ownership mutation owner.
- `close` removes only adapter-created ephemeral resources and never deletes or
  retires a pre-existing managed worktree.
- Parent integration/merge remains Parent cognition under SD §11.4.

## 3. Recovery

The mount binding retains source address + canonical region + captured
ResourceBoundary/Environment basis. Recovery may reopen the same logical mount
only when the current source still resolves to that basis. Drift or a retired
worktree fails closed and produces Attention; no host-prefix guessing is
allowed.

## 4. Security statement

Git worktree separation is resource isolation, not process isolation.
`LocalTrusted` is suitable for a trusted local user and still applies target,
permission, ownership, environment and shell-policy checks. Untrusted automatic
execution requires a hardened provider that prevents the process from reaching
host files, control storage, secrets and unauthorized networks.

## Accepted Native OS Sandbox resource/security boundary

A Git worktree and resource boundary isolate admitted code/resources for
integration; they are not an OS process security boundary. `SandboxPort`
retains mount identity and lifecycle. Provider setup binds the exact admitted
mounts to `SandboxHandle` and the current Execution-scoped
`SandboxProcessPolicy`; process spawn and descendants are owned by P4
`SandboxProcessPort`. Provider close/stop cleans its process tree and
provider-owned scratch without deleting or retiring the P11 Worktree. P11
recovery preserves the exact resource/worktree ownership and never promotes a


## Accepted V21 sandbox target/mount handoff digest

P11/12 supplies the exact logical mount rows from P11/04 resolution and
existing ResourceBoundary ownership. P4 derives each path-free target
identity and SandboxHandleBindingDigestV1 from existing canonical region,
mount ID/access and resourceBoundaryRevision; no SandboxHandleId, host path,
OS process handle, EnvironmentRevision, environment value or Workspace
content enters the digest. Mount rows sort by mountId; access remains exact
ReadOnly/ReadWrite. Restart may create a new process-local SandboxHandle but
must recompute and compare stable basis before process admission. Target/mount/
boundary changes use the existing ResourceBoundary revision/CAS path. P12/09
is only a mapping cross-reference, not a changed region codec. P11/12 owns
logical mount open/close and Worktree lifecycle, not OS isolation.
