# Task Contracts

Task contracts are projections of the frozen design into directly
implementable work. They are the unit a Coding Agent claims and executes.
They may narrow implementation work but may **not** override design
semantics.

Phases: **P0**, **P1**, **P2** (complete); **P3** (planning; contracts frozen
at Blocking=0). P1 tasks reference `docs/design/implementation/P1/**`; P2 tasks
`docs/design/implementation/P2/**`; P3 tasks `docs/design/implementation/P3/**`.

## Authority order

1. `docs/design/03-detailed-implementation-design.md`
2. `docs/design/02-system-design.md`
3. `docs/design/01-scenarios.md`
4. `docs/design/00-problem-goals.md`
5. `docs/design/implementation/P1/**` (P1 phase contracts)
6. `planning/phases/*`
7. `planning/tasks/*`

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
P0-001            -> P1-017, P1-018
P1-017, P1-018    -> P1-002
P1-002            -> P1-001
P1-001            -> P1-003
P1-001, P1-002    -> P1-004
P1-003, P1-004    -> P1-005, P1-006, P1-007
P1-006            -> P1-008
P1-002, P1-004, P1-006 -> P1-009
P1-005, P1-006, P1-009 -> P1-010, P1-011, P1-012
P1-003, P1-006, P1-009 -> P1-013
P1-001, P1-003, P1-007, P1-008, P1-010, P1-011, P1-012 -> P1-014
P1-001, P1-002, P1-007, P1-009 -> P1-015
P1-013, P1-014, P1-015 -> P1-016
```

## P1 task index

| ID | Title | Depends on |
|---|---|---|
| P1-001 | SQLite adapter, connection settings, migration mechanism | P1-017, P1-002 |
| P1-002 | `ports` package: Effect service contracts | P0-001, P1-017, P1-018 |
| P1-003 | P1 DDL migrations | P1-001 |
| P1-004 | `TransactionScope` / `TransactionPort` implementation | P1-001, P1-002 |
| P1-005 | Project/Workspace/Work/Session repositories | P1-003, P1-004 |
| P1-006 | `CommandStore` + `DomainEventJournal` | P1-003, P1-004 |
| P1-007 | Resource ownership + environment revision + resolver | P1-003, P1-004 |
| P1-008 | Consumer offset + dead-letter + journal boundary | P1-006 |
| P1-009 | `CommandGateway` + fingerprint | P1-002, P1-004, P1-006 |
| P1-010 | `CreateProject` handler | P1-005, P1-006, P1-009 |
| P1-011 | `CreateChildWorkspace` handler | P1-005, P1-006, P1-009 |
| P1-012 | `AssignWork` handler | P1-005, P1-006, P1-009 |
| P1-013 | Idempotency / replay / concurrent-duplicate tests | P1-003, P1-006, P1-009 |
| P1-014 | Recovery matrix tests | P1-001, P1-003, P1-007, P1-008, P1-010, P1-011, P1-012 |
| P1-015 | Architecture tests for new packages | P1-001, P1-002, P1-007, P1-009 |
| P1-016 | P1 convergence & result record | P1-013, P1-014, P1-015 |
| P1-017 | Package skeletons + build/test harness wiring | P0-001 |
| P1-018 | Domain artifact evolution (CommandResolution/CommandReceipt/fingerprint) | P0-001 |

## Authority versions

P0 tasks project `System Design v1.3` / `DID v1.5`. P1 tasks project
`DID v1.6` plus the frozen phase contracts in
`docs/design/implementation/P1/**`. P2 tasks project `DID v1.7` plus the P2
phase contracts in `docs/design/implementation/P2/**`. P3 tasks project
`DID v1.7` plus the P3 phase contracts in `docs/design/implementation/P3/**`. `Problem & Goals v1.2` /
`Scenarios v1.2` / `System Design v1.3` are unchanged.

## Entry blocker

P0-001 owned the frozen technical baseline (§14.1). It is satisfied via the
pinned image `arbor-node24:24.21.0` (Node 24.21.0 + pnpm 12.4.2) and the
project `env.sh` wrapper; `pnpm check` is green. **P0 and P1 are COMPLETE**;
all `DG-*` / `P1-DG-*` are RESOLVED. P2 design closure is complete
(`docs/design/implementation/P2/**`, Blocking=0) and P2 is COMPLETE. P3 design
closure is complete (`docs/design/implementation/P3/**`, review Blocking=0);
P3 planning is frozen pending implementation authorization. See
`planning/gaps/`.

## P2 dependency graph

Authoritative edge list (`X -> Y` means Y depends on X):

```text
P1-016                          -> P2-001
P2-001                          -> P2-002, P2-017
P2-002                          -> P2-003, P2-014
P2-003                          -> P2-004
P2-004                          -> P2-005, P2-008, P2-012
P2-005                          -> P2-006
P2-006                          -> P2-007
P2-005, P2-006, P2-008          -> P2-009
P2-005, P2-007                  -> P2-010
P2-005, P2-007, P2-008          -> P2-011
P2-009, P2-012                  -> P2-013
P2-002, P2-009                  -> P2-014
P2-009, P2-010, P2-011, P2-014  -> P2-015
P2-005..P2-015                  -> P2-016
P2-016, P2-017                  -> P2-018
```

## P2 task index

| ID | Title | Depends on |
|---|---|---|
| P2-001 | P2 package skeletons + harness wiring | P1-016 |
| P2-002 | P1/P0 artifact evolution + pointer notes | P2-001 |
| P2-003 | `ports` P2 contracts | P2-002 |
| P2-004 | P2 DDL migrations | P2-003 |
| P2-005 | `ExecutionRepository` (SQLite) | P2-004 |
| P2-006 | `LeaseService` + fence/stop predicates | P2-005 |
| P2-007 | `FenceStopCheck` real implementation | P2-006 |
| P2-008 | `SessionRepository.appendEntry` + `AgentExecutionState` store | P2-004 |
| P2-009 | `AdmitExecution` handler | P2-005, P2-006, P2-008 |
| P2-010 | `StopExecution` handler | P2-005, P2-007 |
| P2-011 | `SettleExecution` handler | P2-005, P2-007, P2-008 |
| P2-012 | `WorkWaitStore` + `SchedulerTimerStore` | P2-004 |
| P2-013 | `ExecutionScheduler` + `RunnableWorkSource` stub | P2-009, P2-012 |
| P2-014 | `WorkerDispatchPort` + `ExecutionDriverPort` + `FakeDriver` + `RuntimeSafetyGate` | P2-002, P2-009 |
| P2-015 | Recovery skeleton + `RecoveryController` | P2-009, P2-010, P2-011, P2-014 |
| P2-016 | Lease / stop / settle / recovery tests | P2-005..P2-015 |
| P2-017 | Architecture tests for P2 packages | P2-001, P2-003 |
| P2-018 | P2 convergence & result record | P2-016, P2-017 |

## P3 dependency graph

Authoritative edge list (`X -> Y` means Y depends on X):

```text
P2-018                                   -> P3-001
P3-001                                   -> P3-002
P3-002                                   -> P3-003, P3-004
P3-004                                   -> P3-005
P3-005                                   -> P3-006, P3-007
P3-006                                   -> P3-008, P3-009
P3-005, P3-006, P3-007, P3-008, P3-009    -> P3-010
P3-003                                   -> P3-011
P3-009, P3-011                           -> P3-012
P3-010, P3-011, P3-012                   -> P3-013
P3-013                                   -> P3-014
P3-012, P3-013                           -> P3-015
P3-004, P3-010, P3-011                   -> P3-016
P3-013, P3-014, P3-015, P3-016           -> P3-017
P3-017                                   -> P3-018
```

## P3 task index

| ID | Title | Depends on |
|---|---|---|
| P3-001 | P3 package skeletons + harness wiring | P2-018 |
| P3-002 | `ports` P3 contracts | P3-001 |
| P3-003 | P3 DDL migrations | P3-002 |
| P3-004 | Prompt Program contract artifacts + instruction model | P3-002 |
| P3-005 | Instruction resolver + trust metadata | P3-004 |
| P3-006 | Context layers / retention / budget | P3-005 |
| P3-007 | Skills surface + progressive disclosure | P3-005 |
| P3-008 | Compaction ProviderTurn protocol | P3-006 |
| P3-009 | Model-family compiler + `ModelContextManifest` | P3-006 |
| P3-010 | `prepareTurn` assembly | P3-005..P3-009 |
| P3-011 | ProviderRuntime + fake provider + failure model | P3-003 |
| P3-012 | `decodeTurn` + `AgentDirective` + Output Contract | P3-009, P3-011 |
| P3-013 | Real `ExecutionDriverPort` + control loop + safety gating | P3-010..P3-012 |
| P3-014 | Bounded `ModelOutputContractViolation` repair | P3-013 |
| P3-015 | `DecisionStale` / freshness | P3-012, P3-013 |
| P3-016 | Behavioral-eval harness + P3 program eval cases | P3-004, P3-010, P3-011 |
| P3-017 | P3 integration + architecture tests | P3-013..P3-016 |
| P3-018 | P3 convergence & result record | P3-017 |
