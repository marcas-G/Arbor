# Planning

Execution tracking for the Arbor implementation phases defined in
`docs/design/03-detailed-implementation-design.md` §11 (DID-10).

## Layout

```text
planning/
├── phases/    # one file per phase: P0 — P12
├── tasks/     # task breakdown per phase, derived from the phase file
├── gaps/      # Design Gaps: questions the frozen design does not answer
└── results/   # completion evidence per phase: verification output, test runs, review notes
```

## Conventions

- A phase file states: scope, entry authorization, exit criteria (from DID), and out-of-scope items.
- A task file references the phase, the design sections it implements, and its verification command(s).
- A result file is only written after `pnpm check` is green for that phase and records the actual evidence (command + output summary).
- Never mark a phase done from intent; only from executed verification.
- `docs/design/**` is manually governed: planning artifacts MUST NOT modify it. A discovered design gap stops work and is raised as a Design Gap for manual governance.

## Design Gaps

A Design Gap is recorded in `planning/gaps/` when the frozen design does not
answer a question that implementation needs (domain semantics, state
transition, authority, transaction/concurrency, recovery, idempotency,
ownership, or failure semantics).

- Planning and implementation MUST NOT invent an answer.
- Only manual governance edits the owning design document.
- Affected tasks are marked blocked until the gap is `RESOLVED`.

See `planning/gaps/README.md` for the index and resolution process.

## Current status

| Phase | Scope (from DID-10) | Status |
|---|---|---|
| P0 | Functional Domain Kernel | IN PROGRESS — P0-001–P0-005, P0-007, P0-010, P0-011 complete; environment baseline via pinned container |
| P1 | Persistence + Command Core | blocked on P1 exact contracts/DDL closure |
| P2–P12 | see DID-10 | not authorized |

Design Gaps `DG-01` … `DG-06` (`planning/gaps/`) are `RESOLVED`. P0 planning
is frozen. The environment baseline (Node 24.21.0 / pnpm 12.4.2) is provided
via the pinned image `arbor-node24:24.21.0` and the project `env.sh` wrapper.
P0-001–P0-005, P0-007, P0-010, and P0-011 are complete (`planning/results/`).
