# Executable Work Breakdown

## W0 — mechanical hygiene

| ID | Task | Owner | Status | Acceptance |
|---|---|---|---|---|
| PP-W001 | Remove the StopExecution `false as unknown as true` escape | Web form | DONE | Web command-form tests, typecheck, Biome |
| PP-W002 | Replace production command-registry casts with named erasure | Execution Runtime | DONE | Registry contract tests + single-package typecheck + Biome |
| PP-W003 | Replace Web error casts with a typed transport-error decoder | Web transport | DONE | Web command tests + typecheck + Biome |
| PP-W004 | Add an architecture/lint check for new production type escapes | Architecture tests | DONE | Regression guard caps production escape count at the reviewed baseline |

## W1 — effect and boundary discipline

| ID | Task | Owner | Status | Acceptance |
|---|---|---|---|---|
| PP-W101 | Inventory ambient time/environment/network access | Cross-cutting | DONE | Inventory checked against approved adapter list |
| PP-W102 | Route existing application/runtime time through Clock/Time ports | Runtime/Application | DONE | Application consumers use event time/ports; remaining Date calls are pure calculations over explicit `now` |
| PP-W103 | Inject provider network boundary and configuration | Provider Runtime | DONE | Provider contract tests with injected fake transport |
| PP-W104 | Reject Domain imports of infrastructure services | Architecture tests | DONE | Architecture suite catches forbidden dependency |

## W2 — state-machine decomposition

| ID | Task | Owner | Status | Acceptance |
|---|---|---|---|---|
| PP-W201 | Map `runModelDecision` reads, decisions, writes, and failure exits | Agent Runtime | DONE | Module map with one owner per transition |
| PP-W202 | Extract Session projection as a pure interpreter | Model Context | DONE | Existing pure projector plus frontier/native projection tests |
| PP-W203 | Extract recovery decision from provider execution | Agent Runtime | DONE | Pure interpreter wired; AH18 ContextLimit evidence recovery and AH18/AH19 focused matrix pass |
| PP-W204 | Extract step/action transition interpreter | Agent Runtime | DONE | Pure seam/action wiring green; AH7 isolated probe and Agent Runtime suite pass; C2 is G-01 provenance, not transition logic |
| PP-W205 | Keep settlement commit at Application boundary | Application | DONE | Existing Execution Runtime→SettleExecution Gateway owner verified; proposal seam and P2/P9 acceptance pass |

## W3 — transaction and testing practice

| ID | Task | Owner | Status | Acceptance |
|---|---|---|---|---|
| PP-W301 | Declare transaction ownership per Application service | Application | DONE | Boundary table + P1 rollback/idempotency tests |
| PP-W302 | Replace high-value invalid fixtures with valid builders | Testkit | DONE | Domain ADT fixture scan is clear in the reviewed high-value test scope; service fakes are tracked separately |
| PP-W303 | Label tests by proof level | Test infrastructure | DONE | Proof-level manifest makes pure/port/application/process/public suites discoverable |
| PP-W304 | Add claim-to-evidence review template | Planning | DONE | Result records include scope-matched command output |

## W4 — context and provenance (governance-gated)

| ID | Task | Owner | Status | Acceptance |
|---|---|---|---|---|
| PP-W401 | Define Work/Root/Execution Session provenance | Manual governance | ACCEPTED / IN_PROGRESS | Accepted proposal; causal binding, migration 0037 after remote P36, SQLite round-trip, Work write paths, and fail-closed projection added; legacy write paths remain |
| PP-W402 | Define durable Work admission handoff | Manual governance | GOVERNANCE | Accepted state machine and recovery predecessor/successor |
| PP-W403 | Implement Work context frontier | Agent/Application Runtime | GOVERNANCE | Cross-episode pollution regression + restart proof |
| PP-W404 | Implement admission recovery | Application/daemon | GOVERNANCE | Root failure still admits exact Work once |
| PP-W405 | Define blocked Work public disposition | Manual governance | GOVERNANCE | Accepted Attention/Work Detail/resume/clear semantics |

## Order

`PP-W001 → PP-W002..004 → PP-W101..104 → PP-W201..205 → PP-W301..304`.

`PP-W401..405` may run as a separate governance stream, but implementation
must not begin before its contracts are accepted.
