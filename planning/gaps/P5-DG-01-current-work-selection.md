# P5-DG-01 — Acceptance story cannot reach `Admit Work(current)`

## Status

**OPEN** — awaiting manual governance. P5-009 is blocked.

## Owning design documents

- `docs/design/implementation/P5/05-slice-acceptance.md` §1 (steps 1–2)
- `docs/design/implementation/P5/02-runnable-work-source.md` §2–§3
- `docs/design/03-detailed-implementation-design.md` §1.4 / §8.18A
- `docs/design/implementation/P2/05-scheduler-wait.md` §4
- `docs/design/implementation/P5/01-composition-root.md` §5 / `05` §6

## Symptom

The frozen P5 acceptance story requires:

```text
1.  CreateProject + AssignWork (P1 commands)   -> Open Work, session
2.  Scheduler.reevaluate (02 provisional source) -> Admit Work(current)
```

But P5 `02` §2 defines `current = workspace.currentWorkId`, and
`CreateProject` / `AssignWork` do **not** set `workspace.currentWorkId` (P1
command contracts; `packages/application/src/commands/assign-work.ts`).
The workspace therefore starts with `currentWorkId = null`.

Applying the frozen P2 `05` §4 / DID §8.18A table with
`current = None, runnable = 1` yields `SelectCurrentWork(theOne)`, **not**
`Admit { focus: Work(current) }`.

## Evidence

```text
P5 05 §1 step 2        -> "Scheduler.reevaluate (02 provisional source) -> Admit Work(current)"
P5 02 §2               -> current = workspace.currentWorkId (when the Work is Open)
P1 AssignWork handler  -> creates the Work; never writes workspace.currentWorkId
P2 05 §4 table         -> current = None, runnable = 1  =>  SelectCurrentWork(theOne)
P2 05 §4 note          -> "SelectCurrentWork ... P2 computes the deterministic decision
                           but does not execute it — execution belongs to the
                           Work-governance phase (P6/P7). P2 adds no governance command."
P5 01 §5 / 05 §6       -> P5 is integration only; no new subsystem semantics
```

Failure evidence (P5-009 acceptance test, `apps/single-workspace/test/p5-slice-acceptance.test.ts`):

```text
$ arbor pnpm test p5-slice-acceptance
AssertionError: expected 'SelectCurrentWork' to be 'Admit'
```

The only ways to satisfy step 2 without changing a frozen contract are:

1. P5 executes `SelectCurrentWork` — forbidden by P2 `05` §4 (execution owned by
   P6/P7) and P5 `01` §5 (no new subsystem semantics); or
2. P5 writes `workspace.currentWorkId` directly — forbidden by the P5 plan's
   "no canonical writes outside `CommandGateway`"; or
3. P1 `AssignWork` (or another P1 command) sets `currentWorkId` when unset —
   not in the frozen P1 command contracts.

## Why planning cannot decide this

Which component executes `SelectCurrentWork`, and whether the acceptance story's
step 1 pre-establishes a current Work, is **Work-governance / scheduling
ownership semantics**. It spans P1 command contracts, P2 scheduler ownership,
and the P5 acceptance story, so no single phase-scoped contract can resolve it
without silently rewriting upstream semantics.

## Required resolution (choose one, by manual governance)

1. Amend P5 `05` §1 so step 1 explicitly establishes the current Work (e.g. the
   story seeds `workspace.currentWorkId`, or an explicit governance step is
   named), and step 2 then legitimately yields `Admit Work(current)`; or
2. Authorize P5 to execute `SelectCurrentWork` as a thin integration step (a
   P5-owned governance command), amending P2 `05` §4's ownership note; or
3. Add a P1 command contract that sets `currentWorkId` (e.g. `AssignWork` selects
   the first Work when the workspace has no current Work), and update the P1
   contract + P5 story accordingly.

## Affected planning tasks

- P5-009 (blocked) — full vertical-slice acceptance story.
- P5-011 (blocked) — phase convergence depends on P5-009.
- P5-002 / P5-006 (informational) — the provisional source and Yield/Wait tests
  already rely on `currentWorkId` being pre-set by test setup, which the
  acceptance story does not.
