# Task Contracts

Task contracts are projections of the frozen design into directly
implementable work. They are the unit a Coding Agent claims and executes.
They may narrow implementation work but may **not** override design
semantics.

Phases: **P0** (complete) and **P1** (design closure frozen; contracts below).
P1 tasks additionally reference `docs/design/implementation/P1/**`.

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
- Use `pnpm test <suite>` (a filename substring, e.g. `ids`,
  `workspace`). Do not prefix with `packages/domain`, which OR-matches every
  domain test and makes the filter meaningless.
- P1 suites live under `<package>/test/<suite>.test.ts` (or
  `tests/<area>/<suite>.test.ts`); the harness (P1-017) includes
  `packages/*/test`, `adapters/*/test`, and `tests/**`, so the suite name
  matches a real file.
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

## P0 dependency graph

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

## P0 task index

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

## P1 dependency graph

Authoritative edge list (`X -> Y` means Y depends on X):

```text
P0-001            -> P1-017
P1-017            -> P1-001, P1-002
P1-001            -> P1-003
P1-001, P1-002    -> P1-004
P1-003, P1-004    -> P1-005, P1-006, P1-007
P1-006            -> P1-008
P1-002, P1-004    -> P1-009
P1-005, P1-006, P1-009 -> P1-010, P1-011, P1-012
P1-003, P1-006, P1-009 -> P1-013
P1-007, P1-008, P1-010, P1-011, P1-012 -> P1-014
P1-001, P1-002, P1-007, P1-009 -> P1-015
P1-013, P1-014, P1-015 -> P1-016
```

## P1 task index

| ID | Title | Depends on |
|---|---|---|
| P1-001 | SQLite adapter, connection settings, migration mechanism | P1-017 |
| P1-002 | `ports` package: Effect service contracts | P0-001, P1-017 |
| P1-003 | P1 DDL migrations | P1-001 |
| P1-004 | `TransactionScope` / `TransactionPort` implementation | P1-001, P1-002 |
| P1-005 | Project/Workspace/Work/Session repositories | P1-003, P1-004 |
| P1-006 | `CommandStore` + `DomainEventJournal` | P1-003, P1-004 |
| P1-007 | Resource ownership + environment revision + resolver | P1-003, P1-004 |
| P1-008 | Consumer offset + dead-letter + journal boundary | P1-006 |
| P1-009 | `CommandGateway` + fingerprint | P1-002, P1-004 |
| P1-010 | `CreateProject` handler | P1-005, P1-006, P1-009 |
| P1-011 | `CreateChildWorkspace` handler | P1-005, P1-006, P1-009 |
| P1-012 | `AssignWork` handler | P1-005, P1-006, P1-009 |
| P1-013 | Idempotency / replay / concurrent-duplicate tests | P1-003, P1-006, P1-009 |
| P1-014 | Recovery matrix tests | P1-007, P1-008, P1-010, P1-011, P1-012 |
| P1-015 | Architecture tests for new packages | P1-001, P1-002, P1-007, P1-009 |
| P1-016 | P1 convergence & result record | P1-013, P1-014, P1-015 |

## Authority versions

P0 tasks project `System Design v1.3` / `DID v1.5`. P1 tasks project
`DID v1.6` plus the frozen phase contracts in
`docs/design/implementation/P1/**`. `Problem & Goals v1.2` / `Scenarios v1.2`
are unchanged.

## Entry blocker

P0-001 owned the frozen technical baseline (§14.1). It is now satisfied via
the pinned image `arbor-node24:24.21.0` (Node 24.21.0 + pnpm 12.4.2) and the
project `env.sh` wrapper; `pnpm check` is green. The six Design Gaps are
`RESOLVED`, so no task remains design-blocked. See
`planning/results/P0-001.result.md`.
