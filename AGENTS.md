# Arbor — Agent Guide

Arbor is a multi-agent work system organized around long-lived Responsibilities, not chat sessions. Read `docs/design/00-problem-goals.md` first; the rest of the chain explains HOW.

## Document chain (ownership)

| Doc | Owns | Status |
|---|---|---|
| `docs/design/00-problem-goals.md` | WHY/WHAT: P1–P8, G1–G8, mission, success criteria | FROZEN |
| `docs/design/01-scenarios.md` | Observable end-to-end behavior S1–S4 | FROZEN |
| `docs/design/02-system-design.md` | Domain semantics, Runtime boundaries, 60 system invariants | FROZEN |
| `docs/design/03-detailed-implementation-design.md` | Executable contracts: ADT/Command/Event/Ports/SQL/Package DAG/phases | TOP-LEVEL FROZEN |

These four files are the latest frozen baselines (Problem & Goals v1.2, Scenarios v1.2, System Design v1.3, DID v1.9).

## Design governance (docs/design/**)

```text
docs/design/** = manually governed source of truth
               = MUST NOT be modified by the Planning Agent
               = MUST NOT be modified by the Coding Agent
```

Only manual governance changes design documents, and only in the document that owns the semantics. Never silently rewrite upstream semantics from implementation code or planning artifacts.

If a code implementation discovers a design gap: **stop implementation and raise a Design Gap** (with failure evidence: failing test, concurrency counterexample, or recovery failure) for manual governance — do not edit the design directly.

## Planning

- `planning/phases/` — one file per phase P0–P12 (see DID §11)
- `planning/tasks/` — task breakdown per phase
- `planning/results/` — completion evidence, verification output per phase

Current authorization state: **P0–P7 COMPLETE; P7 FORMALLY CLOSED**
(P7-GAP-01 dispositioned: DEFERRED to P10, non-blocking). P6 result:
`planning/results/P6.result.md`; P7 result: `planning/results/P7.result.md`
(11/11 exit criteria PASS; no open implementation Design Gap).
P8 is COMPLETE and FORMALLY CLOSED: `planning/results/P8.result.md`
(11/11 exit criteria PASS; no open Design Gap; migrations M-1..M-4
landed as frozen contracts). P9 design closure is complete (GQ1–GQ5
decisions; `docs/design/implementation/P9/**` contracts at Blocking=0;
no DID catalog changes) and P9 planning is frozen
(`planning/phases/P9.md`, 14 tasks) pending implementation
authorization. P10–P12 are not authorized.

P5 result: `planning/results/P5.result.md` (11/11 exit criteria PASS; no open Design Gap). P5-DG-01 was resolved by the decision/execution split: the scheduler evaluator owns the selection decision, the Application owns the `SelectCurrentWork` canonical mutation (P5 `01` §3.1).

## Technical baseline (versioned, from DID §14)

```text
Node 24.21.0 | TypeScript 7.0.2 | effect 4.0.0-rc.115 (exact pin) | pnpm 12.4.2
Vitest 5.0.1 | Biome 2.5.14 | ESM only | tsc -b build
```

Commands: `pnpm build` / `typecheck` / `test` / `lint` / `format` / `architecture` / `check`.
`pnpm check` = lint + typecheck + architecture + test. All must be green before a phase is done.

## Hard engineering rules

1. `Effect<A, E, R>` is an architecture contract: A = success semantics, E = narrow typed failure, R = exact capabilities. No `Effect<A, Error, AppEnv>`, no service locators, no catch-all errors.
2. Domain is pure: `R = never` in domain transitions; no infrastructure imports in `domain`.
3. Port = Effect service; Adapter = Layer. Adapter-specific errors never cross a semantic boundary.
4. Hard invariants are enforced by code (Domain/Command/Persistence/Runtime/Sandbox/Projection, DID-6), never by prompt text.
5. Package dependency follows the allowed-edge matrix in DID §10.4.1; enforce with architecture tests in `tests/architecture/`.
6. Prompt/Model Context changes are behavior code: version them, keep provenance, regression-test them.
7. TDD: write the failing test from design-doc requirements (not from existing code) before implementation.

## Key concepts (do not confuse)

```text
Workspace  = long-lived responsible identity (not folder/session/process)
Work       = phase outcome requirement (Open | Completed | Cancelled)
Execution  = recoverable execution episode (one active main per Workspace)
Agent      = runtime execution role, not a long-term entity (no AgentId)
Verification PASS != Parent Acceptance != Work Completed
```
