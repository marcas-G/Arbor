# SCRC — Session / Context Runtime Convergence

## Authority

- `docs/design/02-system-design.md` v1.4（system invariants 61–68）
- `docs/design/03-detailed-implementation-design.md` v1.22
- `docs/design/implementation/P2/{02,04,06}*`
- `docs/design/implementation/P3/{00,01,02,03,04,06,08}*`
- `docs/design/implementation/P4/{00,02}*`
- `docs/design/implementation/P9/{00,04,07}*`
- `docs/design/implementation/P12/{00,08,12}*`
- `planning/results/session-context-runtime-convergence-design-closure.result.md`
- `AGENTS.md`

Authority order: System Design / DID > phase-owned contracts > this plan > task
contracts. Any newly discovered semantic gap stops the affected task.

## Status

```text
Design:          CLOSED — SD v1.4 / DID v1.22
Design Gap:      SCRC-DG-01 RESOLVED
Planning:        COMPLETE — 8 tasks; review Blocking = 0
Implementation:  AUTHORIZED — SCRC-001…004 COMPLETE; next SCRC-005
Migration:       0019 authorized only within SCRC-002 and its TDD/migration gates
```

## Goal

Replace ad-hoc per-turn text assembly with a durable typed Session Timeline,
safe input promotion, callRef-paired tool/control results, consistent
AgentStepContext projection, explicit in-loop Summary/ProviderNative
compaction and provider-aware budget/overflow recovery—without changing Domain
truth, Work lifecycle, Verification/Acceptance, authority or package DAG.

## Included

- `PortableInputItem` / `SessionItem` types and adapter capability contracts;
- migration 0019 + typed Session repository/frontier/checkpoint operations;
- source-key Inbox promotion and Steer/Queue safe-boundary drain;
- ToolCall/ToolResult/ControlResult timeline closure;
- AgentStepContext + ContextProjector + Manifest evolution;
- Summary Compaction Coordinator and same-step resume;
- ProviderNative checkpoint binding/fallback;
- budget evidence hierarchy + one overflow-triggered recovery;
- AH15–AH19 fault injection, migration re-entry, qualification and convergence.

## Excluded

- new Domain Aggregate or Work/Execution settlement variant;
- CanonicalProviderEvent extension;
- new package/dependency edge;
- permission reconstruction from context;
- modifying historical migrations 0001–0018;
- destructive migration of unresolved legacy Observation text;
- new provider family, UI redesign, streaming UI or Memory policy;
- changing the four still-open G-V2 field-source gaps.

## Dependency graph

```text
SCRC-001
   └─ SCRC-002
        ├─ SCRC-003
        └─ SCRC-004
             └─ SCRC-005
                  ├─ SCRC-006
                  └─ SCRC-007
SCRC-002..SCRC-007
   └─ SCRC-008
```

Additional edges:

```text
SCRC-003 → SCRC-005
SCRC-004 → SCRC-005
SCRC-006 → SCRC-007
```

## Task index

| ID | Title | Depends on |
|---|---|---|
| SCRC-001 | Typed Session/Provider item protocol | — |
| SCRC-002 | Migration 0019 + Session store + durable input promotion | SCRC-001 |
| SCRC-003 | Steer/Queue safe-boundary input drain | SCRC-002 |
| SCRC-004 | Tool/Control timeline closure | SCRC-002 |
| SCRC-005 | AgentStepContext + ContextProjector + Manifest | SCRC-003, SCRC-004 |
| SCRC-006 | Summary Compaction Coordinator | SCRC-005 |
| SCRC-007 | ProviderNative compaction + budget/overflow evidence | SCRC-005, SCRC-006 |
| SCRC-008 | Recovery, qualification, migration proof and closure | SCRC-002…SCRC-007 |

## Exit criteria

1. `PortableMessage` is only a Message variant; adapters reject unsupported
   structured items rather than textifying them.
2. Migration 0019 is forward-only, re-entrant, preserves legacy rows, and never
   infers callRef from text.
3. Same Inbox source promotes exactly once; Session append + consumed converge
   atomically across crash/retry.
4. Steer/Queue ordering and safe-boundary behavior are mechanically proven.
5. Every new ToolResult/ControlResult is paired by callRef and complete
   invocation settlement is never re-executed to repair Session history.
6. ContextProjector is deterministic for the same StepContext/frontier and
   permissions remain fresh-checked at effect admission.
7. Summary compaction atomically advances epoch and resumes the same logical
   step without replaying completed effects.
8. ProviderNative checkpoint is binding-scoped and falls back portably on
   mismatch; CanonicalProviderEvent remains unchanged.
9. Budget evidence hierarchy and one-overflow recovery are observable; second
   overflow/no-gain compaction terminates safely.
10. AH15–AH19 pass on both sides of every commit boundary.
11. All existing tests plus SCRC suites and `pnpm check` are green.
12. Result record proves every acceptance-matrix row; no open SCRC Design Gap.

## Verification

```bash
pnpm test scrc-item-protocol
pnpm test scrc-session-migration
pnpm test scrc-input-promotion
pnpm test scrc-tool-timeline
pnpm test scrc-context-projector
pnpm test scrc-summary-compaction
pnpm test scrc-native-budget
pnpm test scrc-recovery-qualification
pnpm test scrc-acceptance
pnpm architecture
pnpm check
```

## Planning review

| Pass | Result |
|---|---|
| Design fidelity | SCRC-1…12 and SD invariants 61–68 each have an owning task |
| Dependency/coverage | DAG acyclic; migration has one owner; recovery/closure depends on every implementation slice |
| Executability | every exit criterion maps to a named suite and acceptance row |
| Risk/gaps | negative boundaries cover authority, legacy data, provider portability, side-effect replay and package DAG |

**Blocking = 0.** Implementation remains gated by explicit authorization.
