# Effect conventions — E01–E12

Status: adopted 2026-11-25 as the long-term development standard proposed by
the architecture-evolution plan (`architecture-evolution.md`). These are
engineering conventions: they organize implementation, tests and runtime
composition, and never override a frozen product contract. Where a
convention and an existing transaction/recovery/settlement contract
disagree, the contract wins and the disagreement is raised as a Design Gap.

## The twelve principles

| # | Principle |
|---|---|
| E01 | Prefer pure functions for logic that needs no side effects. |
| E02 | A Service corresponds to one complete, cohesive capability — not a technical slice of one. |
| E03 | Layers own dependency construction and composition; consumers never assemble a capability's internals. |
| E04 | Service state is privately owned by its owning service; no external read/write of another service's mutable state. |
| E05 | Do not propagate dependencies through giant `Dependencies` objects; depend on the capability Service instead. |
| E06 | Required dependencies are expressed in the type (`R` channel / `yield*` of a required Service), not hidden as optional `serviceOption` lookups. |
| E07 | Every resource carries an explicit Scope and a release obligation. |
| E08 | Background tasks run under supervised structured concurrency. |
| E09 | Error types preserve failure semantics and the responsibility to handle them. |
| E10 | Effect runtime execution boundaries are confined to controlled entry points. |
| E11 | Every capability is independently testable through its Layer. |
| E12 | Prefer Effect's existing mechanisms; do not rebuild infrastructure Effect already provides. |

New code is reviewed against these. Existing violations are inventory, not
emergencies; each architectural seam migration closes its own violations.

## Code roles

| Role | Responsibility | Effect expression |
|---|---|---|
| Domain | Business semantics, pure computation, invariants | Plain functions, Schema |
| Service | A complete business capability | `Context.Service` |
| Layer | Capability construction and dependency binding | `Layer.effect` |
| Adapter | External-system interaction | Effect Platform, SQL bindings |
| Runtime | Lifecycle and capability composition | `Scope`, `ManagedRuntime` |

Dependency injection answers *how to obtain* a dependency; information
hiding answers *why it is known at all*. Using `Context.Service` without
removing the consumer's need to know the provider's internals is DI without
encapsulation. The target: the Agent Loop orchestrates the execution flow
and does not know how each capability persists, authorizes or recovers.

A capability module may organize as `service.ts` / `layer.ts` / `domain.ts`
/ `errors.ts` / `state.ts` / `index.ts` when its complexity warrants it;
simple services stay in one file. Directory structure reflects actual
complexity and never manufactures extra of it.

## Error handling ownership

| Error class | Handling principle |
|---|---|
| Expected failure | Explicit typed error in the `E` channel |
| Invalid configuration | Blocked at the earliest verifiable boundary |
| Domain rejection | Explicit domain result or failure |
| External failure | Normalized per protocol at the adapter |
| Defect | Defect information preserved, never converted to a result |
| Interruption | Interruption semantics preserved |
| Outcome unknown | Enters the durable recovery / human-attention mechanism |

Never collapse distinct failures (permission denial, model rate limit,
network loss, unknown tool outcome) into one generic failure: they carry
different recovery obligations. Only expected failures are converted;
broad capture that erases interruption or defect semantics is prohibited.
The existing `Effect<void, unknown>` signatures are inventory against E09.

## Effect-runtime vs business semantics

| Effect layer | Arbor business layer |
|---|---|
| Fiber interruption | Execution interrupted (process) |
| Scope close | Runtime resources released |
| Effect failure | One computation failed |
| Execution Settlement | Durable execution settlement |
| Recovery | Recovery from durable facts |
| Work Cancellation | User/business-authorized task cancellation |

The two layers must interlock correctly and are never conflated: a
cancelled fiber does not cancel a Work; a closed Scope does not roll back an
external side effect. A Workspace is a long-lived responsibility holder —
it is not an Effect Scope. Scopes manage a Workspace's runtime resources,
not its persisted identity.

## Testing pyramid

| Level | Real part | Substituted part |
|---|---|---|
| Domain | Domain logic | none |
| Service | Full business Service | external dependencies |
| Adapter | Actual adapter | external environment isolated as needed |
| Contract | Competing implementations against one contract | unrelated capabilities |
| Integration | Several real business Services | non-essential external systems |
| E2E | Complete product | as little as possible |
| Qualification | Real release environment | no fake substitutions |

Every capability gets Service-level tests through its Layer, so a change
does not require booting the single-workspace daemon.

## Test authoring (`@effect/vitest`)

Adopted 2026-11-26 (owner decision: full migration) on
`@effect/vitest@4.0.0-rc.115` — the same release line as the pinned
`effect`. The `it.effect` / `it.layer` / `it.prop` helpers are the
repository canon for Effect-based tests; plain `it` remains correct for
non-Effect code (raw adapters, codemods, scripts).

Rules:

- An Effect test returns the Effect from `it.effect(name, () => effect)`
  — no `Effect.runPromise` scaffolding, no manual scope management (the
  runner provides a fresh `Scope` per test and closes it).
- Wall-clock waits are forbidden in Effect tests: time-dependent
  behavior advances via `TestClock.adjust`; a test that needs live time
  says so explicitly with `it.live`.
- Layers shared by a suite are declared once with `it.layer` blocks
  instead of rebuilt per test; the TestKit driver assembly
  (`agentDriverTestDependencies`) is consumed inside an `it.layer`.
- `it.flakyTest` is not a repair tool: a flaky test is a defect (see
  the test-effectiveness program, B2).
- Property tests for derivation functions use `it.prop` with Schema
  arbitraries.

Migration order: new tests write in canon immediately; existing files
migrate when touched (B3 capability landing, B5 splits) — wave one
(adapters/persistence-sqlite migration tests, environment-local,
tool-runtime resolve) landed in the same PR as the dependency.
