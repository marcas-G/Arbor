# P0 Task Contracts

Task contracts are projections of the frozen design into directly
implementable work. They are the unit a Coding Agent claims and executes.
They may narrow implementation work but may **not** override design
semantics.

## Authority order

1. `docs/design/03-detailed-implementation-design.md`
2. `docs/design/02-system-design.md`
3. `docs/design/01-scenarios.md`
4. `docs/design/00-problem-goals.md`
5. `planning/phases/*`
6. `planning/tasks/*`

Higher-level artifacts define system semantics. If a task conflicts with
the design, the design wins.

## Contract template

Every task file states:

- **Source** — the exact design sections it implements.
- **Depends On** — prerequisite task IDs.
- **Objective** — what is being built.
- **Inputs / Outputs** — types, files, or artifacts.
- **Must Hold** — semantics and invariants that must be true.
- **Must Not Decide** — things outside this task's authority.
- **Acceptance** — observable, mechanically checkable conditions.
- **Verification** — the exact command(s), naming the test suite, proving
  acceptance.

## Verification convention

- A task's Verification must name the specific test suite or filter that
  proves its acceptance; `pnpm check` alone is not sufficient evidence.
- Use `pnpm test -- <suite>` (a filename substring, e.g. `ids`,
  `workspace`). Do not prefix with `packages/domain`, which OR-matches every
  domain test and makes the filter meaningless.
- Type-level assertions (branded-ID interchange, illegal ADT construction)
  only count if the test files are compiled by `pnpm typecheck` (P0-001
  requires this).
- Acceptance bullets must be mechanically checkable: exhaustive
  discriminated-union switches, exported-symbol allowlists, schema field
  presence, or round-trip tests. Subjective bullets are not acceptable.

## Design-gap rule

If implementing a task requires deciding any undefined domain semantics,
state transition, authority rule, transaction boundary, concurrency
behavior, recovery behavior, idempotency behavior, ownership rule, or
failure semantic: **stop and raise a Design Gap** for manual governance.
Do not invent an answer. See `planning/gaps/`.

## Dependency graph

Authoritative edge list (`X -> Y` means Y depends on X):

```text
P0-001                    -> P0-002, P0-003, P0-004, P0-017
P0-002                    -> P0-003
P0-002, P0-003, P0-004    -> P0-005
P0-002, P0-003, P0-004    -> P0-007
P0-002, P0-003, P0-004    -> P0-010
P0-002, P0-003, P0-004    -> P0-011
P0-002, P0-003, P0-004    -> P0-013
P0-002, P0-003, P0-004    -> P0-014
P0-002, P0-003, P0-004    -> P0-015
P0-002, P0-003, P0-004, P0-015 -> P0-009
P0-005, P0-007, P0-009, P0-010, P0-012, P0-015 -> P0-006
P0-002, P0-003, P0-004, P0-011 -> P0-012
P0-005, P0-006, P0-011, P0-012 -> P0-008
P0-005 .. P0-015          -> P0-016
P0-016, P0-017            -> P0-018
```

Note: `Verification` and `Dependency` bind to `WorkId` / `WorkRevision`
brands only, so they are prerequisites of the `Work` aggregate rather than
dependents of it.

## Task index

| ID | Title | Depends on |
|---|---|---|
| P0-001 | Repository skeleton & toolchain baseline | — |
| P0-002 | Typed ID kernel | P0-001 |
| P0-003 | Scoped ordinals & core value-object primitives | P0-001, P0-002 |
| P0-004 | Domain error algebra | P0-001 |
| P0-005 | Project aggregate & transitions | P0-002, P0-003, P0-004 |
| P0-006 | Workspace aggregate & structural transitions | P0-005, P0-007, P0-009, P0-010, P0-012, P0-015 |
| P0-007 | Responsibility / resource ownership algebra | P0-002, P0-003, P0-004 |
| P0-008 | Work aggregate & lifecycle | P0-005, P0-006, P0-011, P0-012 |
| P0-009 | Execution binding ADT & ExecutionSettlement sum type | P0-002, P0-003, P0-004, P0-015 |
| P0-010 | Session runtime aggregate | P0-002, P0-003, P0-004 |
| P0-011 | Verification aggregate & verdict ADT | P0-002, P0-003, P0-004 |
| P0-012 | Acceptance / Deliverable / Dependency revision binding | P0-002, P0-003, P0-004, P0-011 |
| P0-013 | Command ADT vocabulary | P0-002, P0-003, P0-004 |
| P0-014 | Domain event envelope & catalog | P0-002, P0-003, P0-004 |
| P0-015 | Pure authority / policy vocabulary | P0-002, P0-003, P0-004 |
| P0-016 | C10 truth-table invariant tests | P0-005..P0-015 |
| P0-017 | Package DAG architecture tests | P0-001 |
| P0-018 | P0 convergence & result record | P0-016, P0-017 |

## Authority versions

Task contracts project `System Design v1.3` and `DID v1.4` (the governance
patch that resolved DG-01…DG-06). `Problem & Goals v1.2` / `Scenarios v1.2`
are unchanged.

## Entry blocker

P0-001 owns the frozen technical baseline (§14.1). The current environment
does not meet it (Node `v8.10.0`, broken pnpm, no npm). `pnpm check` cannot
run until this is fixed. The six Design Gaps are `RESOLVED`, so no task
remains design-blocked.
