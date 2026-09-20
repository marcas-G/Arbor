# P4 — 08 Minimal Tools (read / patch / shell)

**Authority:** DID v1.8 §11 P4, G5/G6; SD v1.3 §6.5/§6.6.
**Status:** DRAFT (first draft for contract review).

## 1. Versioned contract artifacts (G5/G6)

The minimal tools are **versioned P4 contract artifacts**, not implementation
freedom. Each tool pins:

```text
name, version, hash
inputSchemaJson    (exact, frozen)
resultSchemaJson   (exact, frozen)
sideEffectSemantics
capabilityMetadata
```

Only backend choice, resource limits and numeric thresholds are
implementation/empirical.

## 2. `read`

```text
name: read
sideEffectSemantics: ReadOnly
input:  { path: ResourceAddress, offset?: int, limit?: int }
result: { text: string, truncated: boolean, byteSize: int }
```

- Read-only: transient retry allowed.
- Confined to admitted canonical regions.

## 3. `patch`

```text
name: patch
sideEffectSemantics: Idempotent
input:  { path: ResourceAddress, unifiedDiff: string }
result: { applied: boolean, hunks: int }
```

- Idempotent: same invocation key replay allowed.
- A conflicting patch is an `ExpectedFailure` (model-correctable), not a crash.

## 4. `shell`

```text
name: shell
sideEffectSemantics: Reconcilable
input:  { command: string, cwd: ResourceAddress, timeoutMs?: int }
result: { exitCode: int, stdoutRef: string, stderrRef: string, truncated: boolean }
```

- Reconcilable: on ambiguity, reconcile (inspect external reality) before replay.
- **Shell policy enforcement is a P4 phase-scoped contract (G6)**, not
  implementation choice:

```text
policy evaluation (deterministic, before sandbox execution):
  - command allow/deny classification
  - path confinement to admitted canonical regions
  - environment allow-list
  - resource/time limits
  - destructive-command classification -> requires InvocationApproval
```

- The policy mechanism is frozen here; concrete allow/deny lists and limits are
  empirical/configurable.
- The approval requirement is evaluated **per intent** (a policy predicate),
  not a static per-tool flag: `shell` requires an `InvocationApproval` only for
  destructive commands.
- Raw stdout/stderr above the bounded size become Artifacts (`07` §5).

## 5. Organizational actions are excluded

`create_child`, `assign`, `query_workspace`, `declare_dependency`,
`report_parent` are **not** in this tool set; they route through
`CommandGateway` (DID §7.6).

## 6. Environment / git tools

Worktree/resource isolation, git-specific operations, external change detection
and advanced sandboxing belong to P11; P4 provides only the minimal
`read`/`patch`/`shell` surface.

## 7. Must Not Decide

- No git worktree lifecycle (P11).
- No external change detection / impact analysis (P11).
- No concrete allow/deny lists or limit numbers (empirical).
