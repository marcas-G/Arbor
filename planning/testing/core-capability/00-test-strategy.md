# Arbor Core Capability Test Strategy

**Status:** Initial evidence baseline  
**Audit date:** 2026-09-27  
**Source baseline:** `master@063d40d236ef` plus the pre-existing dirty worktree  
**Scope:** Evidence quality for Arbor user-facing capabilities B01–B14

## Purpose

This strategy separates evidence that code exists from evidence that Arbor can
perform a capability a user relies on. A test name, a phase closure, a persisted
Session row, or a scripted provider response is never sufficient by itself to
claim that the model can perform the corresponding behavior.

The audit does not change production semantics, Prompts, or frozen contracts.
Production failures remain findings. The frozen design files under
`docs/design/**` remain manually governed.

## Evidence levels

| Level | Name | Minimum evidence | Result label |
|---|---|---|---|
| **L1** | WHITE_BOX / COMPONENT | One module, function, schema, repository contract, or state transition is exercised directly. | `COMPONENT_PROVEN` |
| **L2** | GRAY_BOX / INTEGRATION | Multiple real Arbor modules are connected through their intended ports/composition. Persistence and executors are real when they are part of the claim. A fake or recording provider is allowed when model behavior is not the oracle. | `INTEGRATION_PROVEN` |
| **L3** | BLACK_BOX / CAPABILITY | Begins at a user/external entry, follows a production-like path, and asserts the externally observable scenario outcome and its negative oracle. Tests do not call the capability's internal implementation directly. | `CAPABILITY_PROVEN` only for a complete passing case |

Evidence levels are assigned to individual tests, not inherited from words
such as `acceptance`, `e2e`, `real-provider`, or `continuity` in a file name.
A suite may contain tests at different levels.

## Capability proof rule

A capability is `CAPABILITY_PROVEN` only when its complete L3 case passes.
Where the card says a real provider is required, the successful case must use
`provider_mode=REAL`. A passing L1/L2 test can establish implementation or
integration evidence, but cannot be promoted to capability proof.

Every record uses exactly one provider value:

```text
REAL | RECORDING | FAKE | NONE
```

`RECORDING` means a test observes the constructed request and supplies a
scripted response. It is not a real-provider result. `NONE` means the test
does not invoke a provider.

Black-box card statuses are restricted to:

```text
PASS
FAIL
BLOCKED_BY_IMPLEMENTATION
BLOCKED_BY_DESIGN_GAP
NOT_RUN
```

An incomplete scenario is not a partial PASS. A failure remains in the
qualification report and is not weakened, skipped, or deleted to make CI
green.

## Existing test hierarchy

Continue using the repository's Vitest suites under `packages/**/test`,
`adapters/**/test`, `apps/**/test`, and `tests/**`. Keep component and
integration regression tests in their existing locations. Put real-provider
qualification cases in an explicitly selected Vitest project/runner so a
missing provider configuration produces a reported `NOT_RUN`, never a skipped
test presented as a pass. Do not create a duplicate test framework.

Static tests of Prompt text, hashes, or registered programs are component or
contract checks. They do not prove production activation or model behavior.
SQLite reopen/recovery tests prove persistence and recovery seams; they do not
prove cognitive continuation unless a later model turn demonstrates the
expected context and behavior.

## Governance boundary

DID v1.18 Appendix C explicitly leaves ControlToolRegistry implementation,
S01 qualification, and Wave 2 unauthorized. This test strategy does not grant
that authorization. Cases that depend on those paths remain unrun or blocked.
Testing B01/B04 conversation behavior does not authorize tool-selection or
control-action qualification.
