# Architecture evolution — Effect-native modular monolith

Status: adopted direction 2026-11-25. This is the sequencing plan for the
capability-oriented evolution of the current technically-layered,
interface-passing organization. It changes implementation organization, not
product semantics; every step that would touch a frozen contract stops and
raises a Design Gap first.

## Goal

Evolve from technical layering with interface passing toward a modular
architecture organized around business capabilities, Effect Services,
resource ownership and composable Layers — so each capability's internal
complexity leaks neither to other capabilities, nor to developers, nor to
the test system. Deployment stays a monolith; ownership, composition and
testing become capability-scoped.

Arbor already uses Effect, but using Effect and exploiting its architectural
power are different things. Effect must constrain complexity propagation,
not merely replace promises, exceptions and manual DI.

## Inputs

- **Effect**: typed dependencies, composable services, structured
  concurrency, resource lifecycle, independent testing
  (`docs/engineering/effect-conventions.md`).
- **OpenCode engineering**: capability module organization, service-private
  state, instance-scoped lifecycles, service composition/replacement
  (studied, not copied — its `LayerNode` graph machinery is deliberately
  not adopted until plain Layer composition is proven insufficient).
- **DeepSeek Harness methodology**: minimally sufficient verification,
  independent review, knowledge retention.

## Preconditions on every step

- State ownership, transaction boundaries and durable-recovery semantics
  are re-verified against the existing frozen contracts before any code
  moves. Capability splits must never turn atomic admission-plus-lease
  operations into two unsafe operations.
- Each seam is one complete capability slice, measured before and after:
  direct dependency count, public interface surface, state ownership, test
  dependencies, verification time.
- No parallel governance system is built (E12): plain Effect Layer until
  proven insufficient.

## Tool-capability ownership audit (prerequisite)

A business concept may cross technical layers but must never have two
competing semantic owners. Before refactoring, each of these gets exactly
one confirmed owner:

| Responsibility | Owner to confirm |
|---|---|
| Tool definition and registration | who owns the valid tool set |
| Invocation identity | who generates and maintains Invocation IDs |
| Permission decision | who decides execution is allowed |
| Tool execution | who produces side effects |
| Result persistence | who records results atomically |
| Interruption and recovery | who decides how unknown outcomes resolve |
| Model-visible result | who constructs the final tool observation |

The audit records the current owner of each (across agent-runtime,
tool-runtime, execution-runtime, application, ports, sandbox adapters,
persistence-sqlite) and any place where ownership is contested.

## Sequenced refactor objects

| Order | Object | Core goal |
|---|---|---|
| 1 | Agent Loop Driver | reduce low-level dependencies and business-knowledge leakage |
| 2 | Agent Loop Action Dependencies | separate business input, service dependencies and runtime state |
| 3 | Composition Root | capability-level Layer composition |
| 4 | Runtime Lifecycle | explicit resource ownership and scopes |
| 5 | Ports | public contracts controlled per capability |
| 6 | TestKit | local Layer-level test construction |
| 7 | Execution Recovery | unified recovery semantics and error-handling ownership |
| 8 | SQLite | persistence detail isolated from business decisions |
| 9 | Scheduler | strengthen the admission boundary on the already-clear structure |
| 10 | CI | verify module boundaries and independent testability |

`scheduler.ts` is the in-repo positive example to build on. The order is
capability-value-driven, not line-count-driven (that is what distinguishes
this from the R5 file-size campaign, which continues independently).

## Measurement discipline

Every seam migration appends to this file: the measured before/after
dependency count and public surface, the contract checks performed, and
the verification commands run. A migration without before-measurements is
invalid.
