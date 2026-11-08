# Arbor Programming Paradigm Governance

This package turns the programming-habit review into an executable project
discipline. It is intentionally separate from `docs/design/**`: it describes
how implementation must be written and reviewed, while frozen design remains
the authority for domain semantics.

## Documents

- `00-rules.md` — durable rules that apply to every future change.
- `01-work-breakdown.md` — executable work items, dependencies, and status.
- `02-governance-gates.md` — questions that require manual semantic approval.
- `07-test-proof-levels.md` — proof-level labels and claim limits for tests.
- `08-phase-closure-matrix.md` — completed baseline versus next-phase work.
- `09-runtime-refactoring-plan.md` — detailed R1–R3 implementation plan and
  grouped validation schedule.

## Status vocabulary

- `DONE` — implemented and verified by the named evidence.
- `READY` — implementation may begin without new domain semantics.
- `IN_PROGRESS` — implementation has started but its exit evidence is missing.
- `GOVERNANCE` — semantic decision is required before code changes.
- `BLOCKED` — a concrete external dependency prevents progress.

## Change rule

Every implementation change covered by this package must identify:

1. the rule or work-item ID it advances;
2. the owning module/boundary;
3. the smallest public or port-level regression proving it;
4. the result record and command output used for acceptance.

No task may be marked complete from a narrow unit test when its stated scope
is a process, recovery, or public-contract behavior.
