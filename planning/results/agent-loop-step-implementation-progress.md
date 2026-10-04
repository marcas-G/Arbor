# AgentLoopStep Implementation Progress

## Status

**IN PROGRESS — core handoff path implemented; AH3 process-crash two-sided
qualification PASS; full AH1–AH14 closure pending.**

## Implemented

- DID v1.21 terminology (`AgentLoop` / `AgentLoopStep`) and ALS-I1 authorization.
- Migration `0017_agent_loop_step_handoff`:
  - `agent_loop_steps` / `agent_loop_step_actions`;
  - sourced `session_entries` with all-null/all-present CHECK + unique source;
  - `provider_attempts.success_evidence_version`;
  - health/readiness baseline 17.
- Fenced `AgentLoopStepStore` with idempotent Prepared creation, state/revision
  CAS, successor creation and ordered action ledger.
- Sourced/idempotent Session append with typed same-source/different-hash
  conflict.
- Atomic ProviderAttempt Success + ProviderTurn settlement and validated
  settled-result replay.
- AgentLoop integration:
  - Prepared → ProviderResultAvailable → OutputAccepted → ActionsInProgress;
  - per-action LogicalActionId/input hash;
  - sourced Observation + Applied + step cursor in one transaction;
  - direct settlement + remaining SkippedEarlySettlement +
    SettlementProposed in one transaction;
  - StepEffectsCommitted → persisted unique NextStepReady successor;
  - no-action conversation SettlementProposed before driver return.
- Recovery already proven for:
  - crash/fence after successful Provider result but before Session acceptance;
  - v16 legacy complete no-action success adopted after migration;
  - settled failed ProviderTurn without a repeat Provider request.
- Output rejection/retry, DecisionStale/SkippedStale, and
  OutcomeUnknown/ReconciliationPending are now persisted and regression-tested.
- A temporary copy of the preserved quant-research database completed the real
  two-tick recovery drill: one historical Provider attempt, one sourced output,
  no active Execution, and an Answered HumanMessage. The source database was
  untouched.
- DeepSeek Flash uses an independent `model-deepseek-v4-flash` 128K/8K
  profile; the qualified shared `model-openai` fingerprint remains unchanged.

## Verification

- lint: PASS (748 files)
- typecheck: PASS
- architecture: PASS (19 files / 115 tests)
- full core suite: PASS (242 files / 1,459 passed / 1 skipped), run with a
  no-secret fake-provider config to avoid external API use
- Web: typecheck PASS; build PASS; 31 files / 210 tests PASS
- focused AgentLoop/Provider/conversation suites: PASS
- `git diff --check`: PASS except pre-existing working-copy line-ending warnings

## Remaining before closure

- AH1–AH2、AH4–AH14 kill-before/kill-after matrix as individually named evidence.
- AH3 both sides now have real-process crash/restart evidence in
  `planning/results/AH3-process-crash-qualification.result.md`; it found and
  fixed missing production pre-dispatch lease fencing on conversation and
  bound-execution recovery paths.

2026-10-04 AH3 增量验证：`pnpm check` PASS（架构 155、核心 1677 + 3 skipped、
Web 216）；AH3 两侧单独及合并 2/2 PASS。此增量不追溯改写上文历史基线数。
- evidence-insufficient legacy fixture → durable Attention.
- final crash-injection run against the migration/recovery paths; the original
  database remains read-only.

No claim of full AgentLoopStep implementation closure is made by this record.
