# AH7 NonIdempotent effect-before-settlement process qualification

Date: 2026-10-08

Status: **PASS for the qualified boundary; AH7 remains PARTIAL.**

## Contract and boundary

The frozen DID §6A.7 / System Design invariants 35 and 54, P2 `06` §5,
P9 `02` T4 and P9 `07` §2/§4 specify that an ambiguous NonIdempotent effect
must not be automatically replayed or converted into ordinary Execution
completion. Recovery may settle `OutcomeUnknown(ReconciliationRequired)` or
remain in reconciliation. No design change was needed.

The daemon process test uses the existing
`AH7AfterToolEffectBeforeSettlement` ToolRuntime probe. The test child changes
the imported builtin shell definition only inside its own daemon process, so
the ordinary production composition has no tool-definition override input.
The shell writes one marker into the fixture's temporary workspace; no real
external service is contacted.

## RED evidence

Before the recovery change, the isolated process test reached the exact crash
boundary with a persisted NonIdempotent intent and marker already written.
After restart, Agent action was `ReconciliationPending` and Execution was
`OutcomeUnknown`, but the P4 `tool_invocations` row remained
`settled_at = NULL` / `settlement_kind = NULL`. The test failed at the durable
P4 row assertion. This exposed missing canonical P4 OutcomeUnknown settlement.

## Implementation and GREEN evidence

On an exact retry of a dangling `NonIdempotent` invocation, ToolRuntime now
atomically settles the existing invocation as `OutcomeUnknown` with its own
invocation reference and returns the matching typed observation. It does not
execute the tool again. A dangling `Reconcilable` invocation remains unsettled
and in reconciliation until its owning tool can reconcile external reality;
it is not converted by this fallback into a P4 `OutcomeUnknown` settlement.

The real daemon test now proves:

- Before kill: one matching NonIdempotent P4 intent, unsettled; one marker line
  already exists in the isolated temporary workspace.
- After restart: one P4 invocation with the same ID, settled as
  `OutcomeUnknown` and `reconciliationRefs: [invocationId]`.
- The same Agent action is `ReconciliationPending`.
- The same Execution is `OutcomeUnknown` with
  `ReconciliationRequired(invocationRefs: [invocationId])`; it is not ordinary
  Completed, Interrupted or Failed.
- ProviderTurn records are unchanged and the marker-bearing Provider request
  occurred once.
- The marker file is byte-for-byte unchanged after restart, proving the
  external effect was not replayed.

Targeted process suite:

```text
tests/functional/process/agent-action-ah7-reconcilable.functional.test.ts
3 passed (intent-before-effect Reconcilable, effect-before-settlement
Reconcilable, effect-before-settlement NonIdempotent)
```

The NonIdempotent case was rerun after strengthening assertions to inspect the
durable P4 and Execution `settlement_json`; it passed 1/1.

The two Reconcilable cases also assert their P4 invocation remains unsettled
after recovery; both pass without replay.

Review-corrected full `pnpm check`: **PASS** — Biome checked 963 files with
one pre-existing warning, typecheck passed, architecture 158/158, core 1738
passed + 3 skipped, Web typecheck/build passed, Web tests 223/223.

This evidence closes only the NonIdempotent effect-before-settlement boundary.
It does not close other AH7 crash/concurrency/approval branches or AH7-DG-01…03.
