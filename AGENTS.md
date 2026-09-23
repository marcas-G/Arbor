# Arbor — Agent Guide

Arbor is a multi-agent work system organized around long-lived Responsibilities, not chat sessions. Read `docs/design/00-problem-goals.md` first; the rest of the chain explains HOW.

## Document chain (ownership)

| Doc | Owns | Status |
|---|---|---|
| `docs/design/00-problem-goals.md` | WHY/WHAT: P1–P8, G1–G8, mission, success criteria | FROZEN |
| `docs/design/01-scenarios.md` | Observable end-to-end behavior S1–S4 | FROZEN |
| `docs/design/02-system-design.md` | Domain semantics, Runtime boundaries, 60 system invariants | FROZEN |
| `docs/design/03-detailed-implementation-design.md` | Executable contracts: ADT/Command/Event/Ports/SQL/Package DAG/phases | TOP-LEVEL FROZEN |

These four files are the latest frozen baselines (Problem & Goals v1.2, Scenarios v1.2, System Design v1.3, DID v1.14).

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

Current authorization state: **P0–P13 COMPLETE; P13 FORMALLY CLOSED**.
**SYSTEM IMPLEMENTATION COMPLETE** — **FINAL CLOSURE PASS**
(`planning/final-system-closure.md`; `planning/results/ARBOR_FINAL.result.md`).
P13 (Product Web Client — post-core product-surface phase, DID v1.15 G1–G4):
design closure + planning + implementation COMPLETE and FORMALLY CLOSED
(`planning/results/P13.result.md`; 14/14 exit criteria PASS; no open Design
Gap; recorded deviations: tree depth-field TR deferred, external
AdmitExecution + chat-first deferred to P14+).
(P7-GAP-01 dispositioned: DEFERRED to P10, non-blocking). P6 result:
`planning/results/P6.result.md`; P7 result: `planning/results/P7.result.md`
(11/11 exit criteria PASS; no open implementation Design Gap).
P8 is COMPLETE and FORMALLY CLOSED: `planning/results/P8.result.md`
(11/11 exit criteria PASS; no open Design Gap; migrations M-1..M-4
landed as frozen contracts). P9 is COMPLETE and FORMALLY CLOSED: `planning/results/P9.result.md`
(11/11 exit criteria PASS; no open Design Gap; GQ1–GQ5 fidelity
held; three closure deviations reconciled under DID v1.12 G1/G2).
P10 is COMPLETE and FORMALLY CLOSED: `planning/results/P10.result.md`
(11/11 exit criteria PASS; P7-GAP-01 CLOSED as the
WaitingOnVacantProducer derived view; DID v1.13 G1–G8 fidelity
held). P11 is COMPLETE: `planning/results/P11.result.md` (11/11 exit
criteria PASS; CI-1..CI-5 mechanically proven; no open Design Gap;
three P12 convergence items recorded). P12 design closure COMPLETE (DID v1.14
governance rulings GQ1–GQ8 landed; P12 contracts FROZEN, Blocking=0) and P12
planning COMPLETE (planning review Blocking=0). P12 implementation COMPLETE and
FORMALLY CLOSED: `planning/results/P12.result.md` (14/14 exit criteria PASS; all
nine completion blockers mechanically evidenced; no open P12 Design Gap).

```text
P12 design closure COMPLETE (contracts FROZEN; four-way review Blocking=0)
P12 planning COMPLETE (phase plan + task contracts; planning review Blocking=0)
P12 implementation COMPLETE; P12 FORMALLY CLOSED
```

P12 completion blockers (must remain explicit throughout closure):
region-encoding correctness fix; ToolCatalogPort inherited contract correction;
full §8.16A Runtime Safety closure; Authority Resolver production plane;
SecretStorePort / SecretRef + real adapter; observability / health / usage plane;
StorageScaleAssessment + DurabilityEnvelope; Remote Worker transport / identity
boundary; Plugin SDK / compatibility / trust model.

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
