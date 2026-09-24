# Task Contracts

Task contracts are projections of the frozen design into directly
implementable work. They are the unit a Coding Agent claims and executes.
They may narrow implementation work but may **not** override design
semantics.

Phases: **P0–P12** (complete). Task contracts reference
`docs/design/implementation/<phase>/**`.

## Web Product UI execution plans

| Scope | Plan | Status | Result |
|---|---|---|---|
| D-1 Contract Closure | `D1-product-ui-contract-closure` | COMPLETE | `planning/results/D1-product-ui-contract-closure.result.md` |
| D0–D3 Foundation | `D0-D3-web-product-ui-foundation` | COMPLETE | `planning/results/D0-D3-web-product-ui-foundation.result.md` |
| D4–D6 Core Workbench | `D4-D6-web-product-ui-core-workbench` | COMPLETE / PHASE-BOUNDARY CLOSED at `master@88744c5ac2d856044bb231e8c6abbd684dd0fded` | `planning/results/D4-D6-web-product-ui-core-workbench.result.md` |
| D7–D9 Governance, Usage, Settings, and Product Hardening | `D7-D9-web-product-ui-surfaces` | COMPLETE / PHASE-BOUNDARY CLOSED at `master@2420da771cdf8a1db8f2d5043f55b0391c817a80` | `planning/results/D7-D9-web-product-ui-surfaces.result.md` |
| D10 Final Convergence | — | NOT AUTHORIZED | No D10 implementation started |

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
`DID v1.7` plus the P3 phase contracts in `docs/design/implementation/P3/**`. P5 tasks project `DID v1.9`
plus `docs/design/implementation/P5/**`. P6 tasks project `DID v1.9` plus
the frozen P6 phase contracts in `docs/design/implementation/P6/**`
(manual governance adoption of D1–D4 with binding constraints). P7 tasks
project `DID v1.10` plus the frozen P7 phase contracts in
`docs/design/implementation/P7/**` (contract review Blocking=0; governed by
the GQ1–GQ7 / v1.10 G1–G6 decisions). P8 tasks project `DID v1.11` plus the
frozen P8 phase contracts in `docs/design/implementation/P8/**` (contract
review Blocking=0 after two independent rounds; governed by the GQ1–GQ8 /
v1.11 G1–G6 decisions). P9 tasks project `DID v1.11` plus the frozen P9
phase contracts in `docs/design/implementation/P9/**` (contract review
Blocking=0; governed by the GQ1–GQ5 decisions recorded in
`P9/00-contract-index.md` — no DID catalog changes). P10 tasks project
`DID v1.13` plus the frozen P10 phase contracts in
`docs/design/implementation/P10/**` (contract review Blocking=0; governed
by the GQ1–GQ7 + GAP-01 decisions recorded in `P10/00-contract-index.md`
under DID v1.13 G1–G8).
`Problem & Goals v1.2` / `Scenarios v1.2` / `System Design v1.3` are unchanged.

## Entry blocker

P0-001 owned the frozen technical baseline (§14.1). It is satisfied via the
pinned image `arbor-node24:24.21.0` (Node 24.21.0 + pnpm 12.4.2) and the
project `env.sh` wrapper; `pnpm check` is green. **P0–P12 are COMPLETE**;
all `DG-*` / `P1-DG-*` / `P5-DG-*` are RESOLVED; no open P6/P7/P8/P9 Design
Gap (see `planning/results/P6.result.md`, `planning/results/P7.result.md`,
`planning/results/P8.result.md`, `planning/results/P9.result.md`).
**P10–P12 are COMPLETE**. P7-GAP-01 was CLOSED at P10 (WaitingOnVacantProducer
derived view). P12 is COMPLETE and FORMALLY CLOSED (14/14 exit criteria;
nine completion blockers evidenced). See `planning/results/` and
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

## P4 dependency graph

Authoritative edge list (`X -> Y` means Y depends on X):

```text
P3-018                            -> P4-001
P4-001                            -> P4-002
P4-002                            -> P4-003, P4-004, P4-005, P4-009, P4-010
P4-003                            -> P4-007, P4-010, P4-011
P4-004, P4-005                    -> P4-006
P4-006                            -> P4-007
P4-005                            -> P4-008
P4-004..P4-011                    -> P4-012
P4-012                            -> P4-013, P4-014, P4-015
P4-011                            -> P4-016
P4-012, P4-013, P4-014, P4-015, P4-016 -> P4-017
P4-017                            -> P4-018
```

## P4 task index

| ID | Title | Depends on |
|---|---|---|
| P4-001 | P4 package skeletons + harness wiring | P3-018 |
| P4-002 | `ports` P4 contracts | P4-001 |
| P4-003 | P4 DDL migrations | P4-002 |
| P4-004 | Tool catalog + definitions (read/patch/shell schemas) | P4-002 |
| P4-005 | Canonical resource resolution wiring | P4-002 |
| P4-006 | Trusted `InvocationAuthority` + capability ceiling | P4-004, P4-005 |
| P4-007 | `InvocationApproval` + atomic consumption | P4-003, P4-006 |
| P4-008 | Validate-only resource admission | P4-005 |
| P4-009 | `SandboxPort` + local adapter | P4-002 |
| P4-010 | Blob/Artifact service + adapter | P4-002, P4-003 |
| P4-011 | `ToolInvocationStore` + intent-before-effect | P4-003 |
| P4-012 | `ToolRuntimePort` pipeline | P4-004..P4-011 |
| P4-013 | `read` tool | P4-012 |
| P4-014 | `patch` tool | P4-012 |
| P4-015 | `shell` tool + policy enforcement | P4-012 |
| P4-016 | P2 `ReconciliationSource` + Stop/quiescence | P4-011 |
| P4-017 | P4 integration + architecture tests | P4-012..P4-016 |
| P4-018 | P4 convergence & result record | P4-017 |

## P5 dependency graph

Authoritative edge list (`X -> Y` means Y depends on X):

```text
P4-018                       -> P5-001
P5-001                       -> P5-002, P5-003, P5-004, P5-010
P5-002, P5-003, P5-004       -> P5-005
P5-005                       -> P5-006
P5-006                       -> P5-007
P5-007                       -> P5-008
P5-008                       -> P5-009
P5-009, P5-010               -> P5-011
```

## P5 task index

| ID | Title | Depends on |
|---|---|---|
| P5-001 | `apps/single-workspace` composition root | P4-018 |
| P5-002 | Provisional `RunnableWorkSource` implementation | P5-001 |
| P5-003 | `DirectiveUnsupported` + slice directive dispatch | P5-001 |
| P5-004 | Slice command handler registry wiring | P5-001 |
| P5-005 | Multi-turn Session continuity | P5-002, P5-003, P5-004 |
| P5-006 | Yield → WorkWait → wake → continuation | P5-005 |
| P5-007 | CompletionClaim → Execution settlement (Work Open) | P5-006 |
| P5-008 | Restart continuity (dispose/reconstruct) | P5-007 |
| P5-009 | Full vertical-slice acceptance story | P5-008 |
| P5-010 | Architecture tests for `apps/*` | P5-001 |
| P5-011 | P5 convergence & result record | P5-009, P5-010 |

## P6 dependency graph

Authoritative edge list (`X -> Y` means Y depends on X):

```text
P5-011                                  -> P6-001
P6-001                                  -> P6-002, P6-005, P6-007, P6-009, P6-011
P6-002                                  -> P6-003
P6-003                                  -> P6-004
P6-005                                  -> P6-006
P6-002, P6-007                          -> P6-008
P6-009                                  -> P6-010
P6-011                                  -> P6-012
P6-004, P6-006, P6-008, P6-010, P6-012  -> P6-013
P6-013                                  -> P6-014
P6-014                                  -> P6-015
```

## P6 task index

| ID | Title | Depends on |
|---|---|---|
| P6-001 | P6 payload ADTs + ports | P5-011 |
| P6-002 | P6 DDL migrations | P6-001 |
| P6-003 | FormationProposal governance + revision-bound RecordDecision (D1) | P6-002 |
| P6-004 | Approve consumer → CreateChildWorkspace/AssignWork (D1) | P6-003 |
| P6-005 | Deep-layer formation + authority fact projection | P6-001 |
| P6-006 | Capability-ceiling validate-only checks | P6-005 |
| P6-007 | SpawnSpecialist → ExecutionBound admission | P6-001 |
| P6-008 | SpecialistSettled → Inbox dedup, no Parent Session writes (D3) | P6-002, P6-007 |
| P6-009 | SendMessage + Communicate + MessageStore | P6-002 |
| P6-010 | Inbox promotion/consumption + correlation + wake + governance routing (D2) | P6-009 |
| P6-011 | SteerWork handler | P6-001 |
| P6-012 | Critical Steer quiescence wiring | P6-011 |
| P6-013 | Prompt Programs v1 + dual versioning + eval gate (D4) | P6-004, P6-006, P6-008, P6-010, P6-012 |
| P6-014 | Acceptance stories A–F + architecture + P5 guard | P6-013 |
| P6-015 | P6 convergence & result record | P6-014 |

## P7 dependency graph

Authoritative edge list (`X -> Y` means Y depends on X):

```text
P6-015                          -> P7-001
P7-001                          -> P7-002
P7-002                          -> P7-003, P7-004, P7-005, P7-006, P7-007, P7-008
P7-003                          -> P7-005
P7-004                          -> P7-007
P7-005                          -> P7-009, P7-011
P7-008                          -> P7-010
P7-003..P7-011                  -> P7-012
P7-012                          -> P7-013
```

## P7 task index

| ID | Title | Depends on |
|---|---|---|
| P7-001 | Domain evolution (kinds, specs, event payloads) | P6-015 |
| P7-002 | P7 DDL + Dependency/Deliverable repositories | P7-001 |
| P7-003 | DeclareDependency handler + directive | P7-002 |
| P7-004 | ProduceDeliverable handler + directive | P7-002 |
| P7-005 | SatisfyDependency handler (exact-bound authority, matcher, wake production) | P7-002, P7-003 |
| P7-006 | Withdraw / MarkUnfulfillable / Revise handlers | P7-002 |
| P7-007 | Deliver primitive (SendMessage kind, ChildDelivered wake, directive) | P7-002, P7-004 |
| P7-008 | Classification single authority (supersedes P5 source; blocking rule; inherited evolution) | P7-002 |
| P7-009 | Event-driven coordinator (lookup, single command face) | P7-005 |
| P7-010 | Wait-for graph + DeadlockAttentionRequested | P7-008 |
| P7-011 | Wake consumption pipeline + composition P7_MIGRATIONS | P7-005 |
| P7-012 | Acceptance stories A–F + architecture + guards | P7-003..P7-011 |
| P7-013 | P7 convergence & result record | P7-012 |

## P8 dependency graph

Authoritative edge list (`X -> Y` means Y depends on X):

```text
P7-013                          -> P8-001
P8-001                          -> P8-002
P8-002                          -> P8-003, P8-004, P8-005
P8-003                          -> P8-006, P8-008
P8-004                          -> P8-009
P8-005                          -> P8-007
P8-006, P8-007, P8-008, P8-009, P8-010 -> P8-011
P8-011                          -> P8-012
```

## P8 task index

| ID | Title | Depends on |
|---|---|---|
| P8-001 | Domain evolution (M-1 wake shape, M-2 mission schema, Orphaned conclusion, enums, event payloads) | P7-013 |
| P8-002 | P8 DDL (four tables) + repositories + M-4 settlement workId | P8-001 |
| P8-003 | StartVerification handler (one-Open, owner snapshot, preallocated verifier id) | P8-002 |
| P8-004 | Record / Conclude handlers (verifier-only, aggregation, Orphaned path) | P8-002 |
| P8-005 | AcceptWorkOutcome + CompleteWork handlers (double uniqueness, seven-fold precondition) | P8-002 |
| P8-006 | Consumer A: CompletionClaimed → StartVerification (M-4 enrichment) | P8-003 |
| P8-007 | Consumer B: WorkOutcomeAccepted → CompleteWork (re-validation) | P8-005 |
| P8-008 | Verifier spawn & drive (M-3 optional parent, WorkerDispatch Verifier, Yield, Attention) | P8-003 |
| P8-009 | Dual-channel wake wiring (channel-1 release + VerificationReturned routing) | P8-004 |
| P8-010 | P9 + P14 Program v1 + dual versioning + eval gates + M-2 placeholder migration | P8-008 |
| P8-011 | Acceptance stories A–G + architecture + guards | P8-006..P8-010 |
| P8-012 | P8 convergence & result record | P8-011 |

## P9 dependency graph

Authoritative edge list (`X -> Y` means Y depends on X):

```text
P8-012                     -> P9-001
P9-001                     -> P9-002, P9-004, P9-009, P9-010
P9-002                     -> P9-003, P9-009
P9-003                     -> P9-005, P9-006, P9-007, P9-008, P9-012
P9-004                     -> P9-007
P9-010                     -> P9-011, P9-012
P9-002 .. P9-012           -> P9-013
P9-013                     -> P9-014
```

## P9 task index

| ID | Title | Depends on |
|---|---|---|
| P9-001 | Fault-injection harness + transaction fault modes + p9 suite skeleton | P8-012 |
| P9-002 | B-1 recovery visibility: ReconciliationSourceLive wiring + durable escalation + I-1..I-3 gate | P9-001 |
| P9-003 | B-2 completion-fact settle + recovery drive triggers T1–T4 (GQ3) + D1/D2/D6 | P9-002 |
| P9-004 | Lease renewal loop (TTL/3) + soft release | P9-001 |
| P9-005 | Durable timer re-drive (fire + clear one tx) + D4 | P9-003 |
| P9-006 | Worker crash + resurrection injection matrix (W1–W5 / R1–R6) | P9-001, P9-003 |
| P9-007 | Lease expiry injection + pre-dispatch T4 proof (L1–L4) | P9-003, P9-004 |
| P9-008 | Provider disconnect + unsettled Turn recovery (PD1–PD4 / I-4..I-7; GQ4) | P9-001, P9-003 |
| P9-009 | Tool four-tier injection (No.35/No.54) + D3 | P9-001, P9-002 |
| P9-010 | Consumer offset wiring + crash/poison matrix (CC-1..CC-6) | P9-001 |
| P9-011 | Generic rebuild (RB-1..RB-5; GQ2) + durability-asserted evidence protocol (GQ5) | P9-010 |
| P9-012 | P7/P8 workflow interruption replay + dispatch failure (WF/DF + D5) | P9-001, P9-003, P9-010 |
| P9-013 | Acceptance stories A–G + architecture + P5–P8 regression guards | P9-002..P9-012 |
| P9-014 | P9 convergence & result record | P9-013 |

## P10 dependency graph

Authoritative edge list (`X -> Y` means Y depends on X):

```text
P9-014                    -> P10-001
P10-001                   -> P10-002, P10-010
P10-002                   -> P10-003
P10-003                   -> P10-004, P10-005, P10-006, P10-007, P10-008
P10-003, P10-004, P10-005, P10-007, P10-008 -> P10-009
P10-002, P10-006, P10-010 -> P10-011
P10-002 .. P10-011        -> P10-012
P10-012                   -> P10-013
```

## P10 task index

| ID | Title | Depends on |
|---|---|---|
| P10-001 | Domain & event-face evolution (HumanInterventionApplied, WorkSteered back-fill, ViewId/status vocabulary) | P9-014 |
| P10-002 | api-contracts package + ProjectionQueryPort signature + freshness types | P10-001 |
| P10-003 | projection-runtime skeleton + Tree/status views (exhaustive label map incl. retired) | P10-002 |
| P10-004 | Attention read-model: six sources / dedup / bubbling + GAP-01 derived view | P10-003 |
| P10-005 | EffectiveFacts materialization + freshness barrier (GQ2/GQ5; no implicit RYW) | P10-003 |
| P10-006 | Workspace Detail / Verification / Dependency / CurrentWork views | P10-003 |
| P10-007 | Transcript production read path + Usage aggregation | P10-003 |
| P10-008 | Inbox view + state-reconciliation audit face | P10-003 |
| P10-009 | Rebuild at-scale orchestration + checkpoints + projection-side retention | P10-003, P10-004, P10-005, P10-007, P10-008 |
| P10-010 | HumanInterventionApplied emission wiring (steer back-fill, governance four, dormant Stop) | P10-001 |
| P10-011 | Message-mediated Query surface + Steer/Stop/Governance action surfaces | P10-002, P10-006, P10-010 |
| P10-012 | Acceptance Stories A–G + architecture + P5–P9 regression guards | P10-002..P10-011 |
| P10-013 | P10 convergence, result record & GAP-01 closure | P10-012 |

## P11 dependency graph

```text
P10-013                 -> P11-001
P11-001                 -> P11-002, P11-003, P11-007, P11-008
P11-002, P11-003        -> P11-004
P11-002                 -> P11-005
P11-005                 -> P11-006
P11-006                 -> P11-011
P11-003, P11-008        -> P11-009
P11-008                 -> P11-010
P11-004..P11-011        -> P11-012
P11-012                 -> P11-013
```

## P11 task index

| ID | Title | Depends on |
|---|---|---|
| P11-001 | Revision algebra + snapshot domain/store migration | P10-013 |
| P11-002 | RecordEnvironmentChange handler + wake | P11-001 |
| P11-003 | Real environment resolver | P11-001 |
| P11-004 | Drift detection + startup seam | P11-002, P11-003 |
| P11-005 | Impact evaluation | P11-002 |
| P11-006 | Staleness overlay + Attention | P11-005 |
| P11-007 | ControlBasis service-internal binding | P11-001 |
| P11-008 | Worktree lifecycle | P11-001 |
| P11-009 | Ownership wiring (fenced) | P11-003, P11-008 |
| P11-010 | Sandbox handoff | P11-008 |
| P11-011 | P8 binding verification | P11-006 |
| P11-012 | Acceptance + CI proofs + architecture | P11-004..P11-011 |
| P11-013 | Convergence & result record | P11-012 |
