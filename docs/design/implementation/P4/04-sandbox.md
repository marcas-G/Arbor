# P4 — 04 Sandbox / Execution Workspace Binding

**Authority:** DID v1.25 EWB-1…EWB-10; SD v1.3 §6.5.
**Status:** FROZEN.

## 1. Boundary

P4 owns the provider-neutral `SandboxPort`, logical mount namespace and target
confinement. P11 owns Git worktree lifecycle, environment snapshots and
advanced/hardened sandbox providers.

`ResourceAddress` and tool path are distinct:

```text
ResourceAddress -> environment/authority identity
mount ref       -> execution-local logical resource
relative path   -> target inside that mount
```

## 2. Binding and handle contracts

```ts
interface SandboxMountBinding {
  readonly ref: "workspace" | string
  readonly address: FileTree | GitWorktree
  readonly region: CanonicalResourceRegion
  readonly access: "ReadOnly" | "ReadWrite"
}

interface SandboxPortService {
  readonly open: (input: {
    readonly executionId: ExecutionId
    readonly workspaceId: WorkspaceId
    readonly mounts: ReadonlyArray<SandboxMountBinding>
  }) => Effect.Effect<SandboxHandle, SandboxError>
  readonly close: (handle: SandboxHandle) => Effect.Effect<void, SandboxError>
}

interface SandboxOpenedMount {
  readonly ref: string
  readonly rootPath: string       // process-local, never model/wire-visible
  readonly region: CanonicalResourceRegion
  readonly access: "ReadOnly" | "ReadWrite"
}

interface SandboxHandle {
  readonly handleId: string
  readonly rootPath: string       // compatibility alias for primary workspace
  readonly mounts: ReadonlyArray<SandboxOpenedMount>
  readonly writableRegions: ReadonlyArray<CanonicalResourceRegion>
}
```

`open` rejects duplicate mount refs, a missing primary `workspace` mount, an
unsupported address family, or an address/region mapping that cannot be opened.
No adapter may silently substitute an empty directory for an admitted mount.

## 3. Relative target

```ts
interface SandboxTarget {
  readonly mount: string
  readonly path: string
}
```

`path` uses `/` separators. `.` denotes the mount root. Empty, absolute,
drive-qualified, UNC, backslash-containing, control-character, empty-segment
and `..` paths are invalid.

Target resolution requires:

1. exact mount-ref lookup;
2. lexical containment beneath that mount root;
3. for an existing target, realpath containment;
4. for a new target, realpath containment of the nearest existing ancestor;
5. `Write` access only on a `ReadWrite` mount.

The resolved host path is process-local data. It is not persisted and is never
returned to the model.

## 4. Guarantees

```text
- model-facing tools never receive or return host paths
- reads/writes resolve only through an opened mount
- writes require ResourceAdmission + writable canonical ownership upstream
- shell cwd is resolved through the same mount contract
- local trusted mode is explicitly not an OS security boundary
- hardened providers must confine process filesystem/network/environment access
- close releases only adapter-owned ephemeral resources; it never deletes a
  bound managed worktree
```

## 5. Failure contract

Invalid path, unmapped mount, missing/type-mismatched target, escape attempt or
ordinary filesystem access failure becomes a terminal `ExpectedFailure` tool
observation. A provider/executor defect is not swallowed here; it remains
visible to P9 recovery and side-effect reconciliation.

## 6. Must Not Decide

- No Worktree lifecycle mutation (P11).
- No authority/permission decision (precedes `open`).
- No provider-specific container/MicroVM mechanism.
- No host-path reconstruction in Model Context or prompts.
