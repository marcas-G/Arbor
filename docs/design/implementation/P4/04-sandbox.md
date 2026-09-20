# P4 — 04 Sandbox

**Authority:** DID v1.8 §7.2/§7.6, G3; SD v1.3 §6.5.
**Status:** DRAFT (first draft for contract review).

## 1. Boundary (G3)

P4 owns `SandboxPort` + a **minimal local executor**. P11 owns worktree/resource
isolation, environment snapshots and advanced sandboxing.

## 2. SandboxPort

```ts
interface SandboxPortService {
  readonly open: (input: {
    readonly executionId: ExecutionId;
    readonly workspaceId: WorkspaceId;
    readonly regions: ReadonlyArray<CanonicalResourceRegion>;
  }) => Effect.Effect<SandboxHandle, SandboxError>;
  readonly close: (handle: SandboxHandle) => Effect.Effect<void, SandboxError>;
}

interface SandboxHandle {
  readonly handleId: string;
  readonly rootPath: string;
  readonly writableRegions: ReadonlyArray<CanonicalResourceRegion>;
}
```

- `open` returns an isolated execution root scoped to the admitted regions.
- The sandbox never widens access beyond the resolved canonical regions; it is
  not a substitute for authority/permission checks.
- Resource limits (CPU/memory/time/disk) and the concrete mechanism are
  implementation/empirical; the port shape and the isolation guarantee are
  contract.

## 3. Guarantees

```text
- commands execute only inside the sandbox root
- writes are confined to writableRegions (ResourceOwnership validated upstream)
- the sandbox cannot reach the canonical control DB or raw secrets
- close releases all sandbox resources
```

## 4. Execution adapter

A minimal local executor (`adapters/sandbox-local`) implements `SandboxPort`
using a subprocess with a confined working directory and an allow-listed
environment. Advanced isolation (containers, namespaces, worktrees) is P11.

## 5. Must Not Decide

- No worktree/git environment management (P11).
- No authority/permission decisions (they precede the sandbox).
- No concrete resource-limit numbers (empirical).
