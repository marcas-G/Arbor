# P4 — 08 Minimal Tools (read / list / patch / shell)

**Authority:** DID v1.25 EWB-1…EWB-10; SD v1.3 §6.5/§6.6.
**Status:** FROZEN.

## 1. Versioned contract artifacts

Tool identity is `(name, version, hash)`. New turns expose `read@2`, `list@2`,
`patch@2`, and `shell@3`. Historical definitions remain available only for
exact historical decoding/recovery under their stored version/hash; they are
not reinterpreted by a new catalog.

Shared target:

```ts
interface SandboxTarget {
  readonly mount: string       // primary coding mount = "workspace"
  readonly path: string        // normalized mount-relative path; "." = root
}
```

## 2. `read@2`

```text
sideEffectSemantics: ReadOnly
input:  { target: SandboxTarget, offset?: int, limit?: int }
result: { text: string, truncated: boolean, byteSize: int }
```

Target must be an existing ordinary file. Transient replay is allowed.

## 3. `list@2`

```text
sideEffectSemantics: ReadOnly
input:  { target: SandboxTarget, depth?: int }
result: { entries: string[], truncated: boolean }
```

Target must be an existing directory. Entries are returned relative to the
selected mount, never as host paths.

## 4. `patch@2`

```text
sideEffectSemantics: Idempotent
input:  { target: SandboxTarget, unifiedDiff: string }
result: { applied: boolean, hunks: int, created: boolean }
```

- Existing-file update preserves the v1 context-matching behavior.
- A missing target may be created only by a pure insertion beginning at old
  line zero. Its nearest existing parent must resolve inside the selected
  writable mount.
- Replay against the already-created identical content succeeds with
  `applied=false`; conflicting existing content is `ExpectedFailure`.
- Delete/move are outside this version.

## 5. `shell@2`

```text
sideEffectSemantics: Reconcilable
input:  { command: string, cwd: SandboxTarget, timeoutMs?: int }
result: { exitCode: int, stdoutRef: string, stderrRef: string,
          truncated: boolean }
```

`cwd` resolves through the same mount contract and must be a directory. Shell
policy/approval, minimal environment and resource/time limits remain mandatory.
On ambiguous completion, reconcile before replay.

## 6. Catalog / invocation binding

The exact definition selected by `TurnProfileResolver` is authoritative. The
executable handler resolves the visible `(name, version, hash)` and passes that
version into Tool Runtime. It must not hard-code `"1"` or select among two
visible versions with the same name.

## 7. Organizational actions are excluded

Organizational/control actions route through `ControlToolRegistry` and shared
Agent Runtime policy; they are not executable filesystem tools.

## 8. Must Not Decide

- No Worktree lifecycle or git integration decision.
- No concrete shell allow/deny list or numeric resource limit.
- No authority derived from model-provided mount/path text.

## Accepted AH7-DG-02 shell@3 successor and Reconcilable profile gate (DID v1.40)

The historical `shell@2` definition above is unchanged: its stored
`Reconcilable` tag is not rewritten or reinterpreted. Exact settled shell@2
invocations replay only their stored result. An exact, fully bound
`NotAdmitted` shell@2 invocation may re-enter only through current P4 authority,
approval, resource, stop and Worker-fence checks, and the exact v2 definition
must remain available until such rows terminate. P39 preflight isolates an
active P36 NotAdmitted row whose binding is not provable; it must not graft a
new binding onto that row.

The new unrestricted `shell@3` definition has `sideEffectSemantics =
NonIdempotent`, uses a new definition hash, and has no reconciliation profile.
Command text or shell policy cannot prove stable effect identity, authoritative
completion, reconstructable prior output, or stale-attempt finality. After
`MayHaveStarted`, ambiguity is `StillUnknown`/OutcomeUnknown and never a blind
Executor replay. `requiresApproval` remains independent from this effect tag.

`Reconcilable` may be assigned only to a separately registered constrained
tool/profile pair with exact tool/profile version and hashes, a stable
Runtime-derived effect key, an authoritative query source, reconstructable
`Occurred` result evidence, and externally provable cancellation/fencing or
finality. The Runtime, not the model, selects the profile and effect key.
Without all of these capabilities the result is `StillUnknown`; a temporary
negative lookup is not `NotOccurred`.
