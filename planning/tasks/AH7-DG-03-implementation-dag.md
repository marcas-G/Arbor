# AH7-DG-03 implementation DAG

Status: **Authorized to implement after accepted design landing; Layer 1 active**  
Design authority: accepted proposal SHA-256
`E818CC208F6A3B233FEF213E54E02AA30A1E96D6147313870C75FDE38DC94CBE`  
Design landing: `34ed1c597c02d677d87f4fa9435d8339641ea3d6`

This plan is limited to AH7-DG-03 on the isolated
`codex/ah7-approval-settlement-governance` worktree. It does not authorize work
in another checkout, push, or merge.

## Layers and gates

| Layer | Scope | Required RED/GREEN evidence | Gate |
|---|---|---|---|
| L1 — P4 ADT, SQL migration and SQLite adapter | Add `Denied` reason-code ADT; `effect_admission_state`; forward migration from the prior schema with existing rows mapped to `LegacyUnknown`; atomic fenced intent+approval claim; fenced no-effect Denied/Interrupted; effect-admission and settlement fences. | Deterministic P4/SQLite tests: legacy backfill and migration idempotence; claim commit/rollback atomicity; exact one-consume; stale-generation rejection for each write; NotAdmitted Denied/Interrupted; LegacyUnknown cannot be rewritten no-effect; stop/effect-gate commit order. | All focused adapter/unit tests and required package typecheck pass before L2. No process matrix yet. |
| L2 — ToolRuntime orchestration | Match before admission; route exact denials to terminal records; use one fenced claim transaction; recheck current authority/stop/lease at effect admission; no executor on denial/stop/fencing rejection; side-effect behavior after `MayHaveStarted`. | ToolRuntime unit tests with executor call counters and injected authorities/stop state; exact same/different invocation replay and no-effect outcomes. | Runtime module tests pass before L3. |
| L3 — AgentLoop / P3 action convergence | Project P4 Denied and Interrupted to sourced ToolResult; mark current action `TerminalRejected`; advance cursor once; skip remaining actions and persist `Interrupted(StopRequested)` at stop. Preserve `ReconciliationPending` after `MayHaveStarted`. | AgentLoop unit/SQLite tests for repeated result, source uniqueness, cursor and remainder disposition. | Focused Agent Runtime/P3 suites pass before L4. |
| L4 — P9 real-process qualification | Two daemons/processes over one SQLite DB; kill before/after claim, Denied/Interrupted, effect-admission, effect, settlement and action/cursor commit; takeover and Stop races. | Real process crash/restart matrix; one approval consumption, one invocation identity, no effect before `MayHaveStarted`, no stale durable write, no blind replay after marker, exact Action/cursor convergence. Separate from SQLite concurrency tests. | Only after L1–L3 focused gates pass. No full functional suite in this task. |

## Current execution

L1 begins with the smallest deterministic REDs in the SQLite adapter tests. Add
tests before changing the P4 types/migration/adapter. Run only those tests;
then add the migration and adapter behavior, rerun the same focused tests and
the package typecheck. Any new semantic requirement not entailed by the
accepted proposal stops implementation and is reported for governance.

Full `pnpm check`, `pnpm test:functional`, real-process L4, push and merge are
outside this current authorization slice.
