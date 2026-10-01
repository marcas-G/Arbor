# DOGFOOD-DG-03 — Executable filesystem tool target cannot be mapped into the sandbox

**Status:** OPEN — awaiting manual governance

**Discovered:** 2026-10-02 real Work Agent Loop dogfooding, project `发布候选验证`

**Owner:** DID §1.5 ResourceAddress semantics; P4 `04` SandboxPort; P4 `08`
minimal tool input contracts; P11 worktree-backed sandbox mapping

**Affected work:** executable `read` / `list` / `patch` (and `shell.cwd`
consistency), plus release-validation Work
`wrk_01a0f834-681f-7b62-9455-aa83bba1e10b`

## Failure evidence

The real model emitted the catalog-valid invocation:

```json
{
  "path": {
    "_tag": "GitWorktree",
    "path": "C:/Users/ThinkPad/.codex/worktrees/release-dogfood/Arbor"
  },
  "depth": 2
}
```

The environment resolver and resource admission accepted that semantic address.
The worktree sandbox then copied the admitted worktree into an isolated temporary
root. `listExecutor` passed the original absolute `ResourceAddress.path` to
`resolveExistingWithin(sandbox.rootPath, ...)`, whose contract only permits a
sandbox-relative path. The executor raised:

```text
Error: absolute paths are not allowed
```

That defect escaped the typed error channel and terminated the production
daemon. The failed execution was
`exe_04193841-0eb1-7bbb-8838-49139f91b8f1`; the daemon log is local runtime
evidence at `C:/Arbor/arbor-p17-final.err.log`.

## Why this is a design gap

The frozen contracts define:

```text
read.path / list.path / patch.path = ResourceAddress
SandboxHandle = { rootPath, writableRegions }
```

`ResourceAddress` is explicitly an environment-facing semantic address and may
therefore contain an absolute host/worktree path. It is not a sandbox-relative
path. Conversely, the only safe filesystem resolver accepts a path relative to
`SandboxHandle.rootPath`.

The contract does not define the missing relation:

```text
(admitted semantic resource root, target within that root)
                         ↓
               isolated sandbox target
```

Treating every accepted absolute address as `.` only works for listing the
resource root. It cannot distinguish `root/src/a.ts` from the root itself for
`read` or `patch`. Deriving a relative path from `writableRegions` is also
insufficient because the region may be the exact nested target while the
worktree adapter actually mirrors a containing backing worktree. Adding an
adapter-specific cast or stripping the host prefix would silently invent mount
semantics and can misroute writes.

## Required governance decision

The owning contracts must define all of the following before filesystem tool
execution resumes:

1. How a model names both the admitted resource root and a target inside it.
2. Whether the tool surface introduces a versioned target such as
   `{ root: ResourceAddress, relativePath: string }`, or instead makes target
   resolution a first-class SandboxPort operation.
3. How a SandboxHandle exposes a provider-neutral mount mapping without leaking
   adapter-specific state into Tool Runtime.
4. Multi-region behavior and ambiguity rejection when more than one admitted
   root could contain a target.
5. Lexical traversal and symlink/junction escape rules before read and write.
6. Write-back identity: the sandbox target must map to exactly one admitted,
   ownership-validated canonical region.
7. Tool-definition version/hash migration and the fail-closed disposition of
   the current `read-v1`, `list-v1`, `patch-v1`, and `shell-v1` schemas.
8. Failure taxonomy: invalid/unmapped targets must become a terminal typed tool
   observation and must never terminate the daemon.

## Recommended ruling for review

Use a versioned, explicit two-part target:

```text
FilesystemTargetV2 {
  root: ResourceAddress
  relativePath: RelativePath   // `.` allowed for list/shell cwd
}
```

`ProjectEnvironment` resolves and admits `root`; `SandboxPort.open` returns a
provider-neutral opaque mount identity for every admitted root; a SandboxPort
resolver maps `(mount identity, RelativePath)` to an isolated path. Tool Runtime
never performs host-prefix stripping. `RelativePath` rejects absolute paths,
`..` escape, and post-resolution symlink/junction escape. A write resolves to
one and only one admitted writable region. Existing v1 definitions remain
registered only long enough to reject with an explicit migration observation;
they are not reinterpreted.

This recommendation is not an accepted contract. Manual governance may select
another design if it closes the same ambiguity and recovery requirements.

## Scope repairable without closing this gap

The daemon-crash propagation is an implementation defect independent of target
semantics. Tool Runtime may translate executor defects into its existing typed
`ToolRuntimeError` channel and prove that translation by test. That containment
does not authorize guessing a filesystem target or resuming affected tool
execution.

## Closure condition

This gap becomes `RESOLVED` only after manual governance updates the owning
design contracts, records the resolving revision here, and separately
authorizes implementation. Until then, the affected release-validation Work is
`BLOCKED_BY_DESIGN_GAP`.
