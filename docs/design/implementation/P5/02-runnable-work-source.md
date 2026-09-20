# P5 — 02 Provisional Runnable Work Source

**Authority:** DID v1.9 §8.18A, §11 P5, G2; P2 `05`.
**Status:** DRAFT (first draft for contract review).

## 1. Boundary (G2)

P5 provides a **provisional single-workspace implementation of the existing P2
`RunnableWorkSource` port**. It does **not** define global Work runnability and
does **not** change the port. P7 later supersedes it with a dependency-aware
implementation.

```ts
interface RunnableWorkSourceService {
  readonly classify: (workspaceId: WorkspaceId) => Effect.Effect<{
    readonly current: Option.Option<WorkId>;
    readonly runnable: ReadonlyArray<WorkId>;
  }, RunnableWorkSourceError>;
}
```

## 2. Provisional semantics

```text
current  = workspace.currentWorkId (when the Work is Open)
runnable = Open Work owned by the workspace, excluding `current`
```

- `current` is read from the Workspace aggregate (`currentWorkId`); it is
  `None` when unset or when the pointed Work is not `Open`.
- `runnable` is the set of `Open` Work in the workspace (from
  `WorkRepository.listByWorkspace(workspaceId, "Open")`), minus `current`.
- Deterministic ordering: by `WorkId` (stable, no dependency graph).
- No dependency/Wait-for awareness (P7); no cross-workspace awareness (P6).

## 3. Scheduler integration

- P2's `ExecutionSchedulerLive` consumes this via the `RunnableWorkSource` port
  and applies the DID §8.18A decision table unchanged.
- `Admit { focus: Work(current) }` / `SelectCurrentWork(theOne)` /
  `Admit { focus: Coordination }` / `Idle` / `Noop` decisions are P2's; P5 only
  supplies the classification.

## 4. Must Not Decide

- No change to the `RunnableWorkSource` port.
- No dependency-aware runnability (P7 supersedes).
- No Work lifecycle transition.
- No global runnability semantics.
