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
