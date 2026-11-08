# Arbor Capability Report

- Run: `2026-10-02T20-34-42.518Z-d032ee6a-4796-4603-82bb-6dc788454b3a`
- Mode: `real-provider`
- Started: 2026-10-02T20:34:42.518Z
- Node / Vitest: v24.21.0 / 5.0.1
- Provider ready: true
- JSON evidence: `planning/testing/core-capability/reports/capability-real-provider-2026-10-02T20-34-42.518Z-d032ee6a-4796-4603-82bb-6dc788454b3a.json`

| Capability | L1 | L2 | L3 | Provider mode | Blocking reason |
|---|---|---|---|---|---|
| B01 Basic Human Conversation | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B01-L1: Not selected in this qualification batch.; B01-L2: Not selected in this qualification batch.; B01-L3-REAL: Not selected in this qualification batch. |
| B02 Executable Tool Use | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B02-L1: Not selected in this qualification batch.; B02-L2: Not selected in this qualification batch.; B02-L3-REAL: Not selected in this qualification batch. |
| B03 Control Action | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B03-L1: Not selected in this qualification batch.; B03-L2: Not selected in this qualification batch.; B03-L3-REAL: Not selected in this qualification batch. |
| B04 Multi-turn Memory / Cognitive Continuity | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B04-L1: Not selected in this qualification batch.; B04-L2: Not selected in this qualification batch.; B04-L3-REAL: Not selected in this qualification batch. |
| B05 Human Steer | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B05-L1: Not selected in this qualification batch.; B05-L2: Not selected in this qualification batch.; B05-L3-REAL: Not selected in this qualification batch. |
| B06 Parent / Child Communication | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B06-L1: Not selected in this qualification batch.; B06-L2: Not selected in this qualification batch.; B06-L3-REAL: Not selected in this qualification batch. |
| B07 Responsibility Delegation | PASS | PASS | PASS | NONE, REAL |  |
| B08 Specialist Delegation | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B08-L1: Not selected in this qualification batch.; B08-L2: Not selected in this qualification batch.; B08-L3-REAL: Not selected in this qualification batch. |
| B09 Dependency / Deliverable | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B09-L1: Not selected in this qualification batch.; B09-L2: Not selected in this qualification batch.; B09-L3-REAL: Not selected in this qualification batch. |
| B10 Verification | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B10-L1: Not selected in this qualification batch.; B10-L2: Not selected in this qualification batch.; B10-L3-REAL: Not selected in this qualification batch. |
| B11 Completion / Acceptance | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B11-L1: Not selected in this qualification batch.; B11-L2: Not selected in this qualification batch.; B11-L3-REAL: Not selected in this qualification batch. |
| B12 Restart / Continuation | PASS | PASS | PASS | NONE, REAL |  |
| B13 Failure Recovery | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B13-L1: Not selected in this qualification batch.; B13-L2: Not selected in this qualification batch.; B13-L3-REAL: Not selected in this qualification batch. |
| B14 Web / Product Projection | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B14-L1: Not selected in this qualification batch.; B14-L2: Not selected in this qualification batch.; B14-L3-REAL: Not selected in this qualification batch. |

## Executed suites

Run 1: 58/58 tests passed; 0 failed.
- `tests/p6-acceptance.test.ts`
- `tests/p6-formation-consumer.test.ts`
- `tests/p6-formation-governance.test.ts`
- `tests/p9-provider-disconnect.test.ts`
- `tests/p9-tool-outcome-unknown.test.ts`
- `tests/p9-worker-crash.test.ts`
- `tests/capability/harness.test.ts`
- `apps/single-workspace/test/p5-restart-continuity.test.ts`
- `packages/domain/test/execution.test.ts`
- `packages/domain/test/workspace.test.ts`

Run 2: 1/1 tests passed; 0 failed.
- `tests/capability/real-provider/b07-responsibility-delegation.test.ts`

Run 3: 0/1 tests passed; 1 failed.
- `tests/capability/real-provider/b12-restart-continuation.test.ts`

Failing assertions:
- `tests/capability/real-provider/b12-restart-continuation.test.ts`: B12 L3 — daemon process restart continues cognition without replay [B12-L3-REAL] B12: a killed daemon process restarts, completes the pending turn, and never replays the completed one

provider config file: none (env only)
B12 real-provider behavioral sentinel failed or was unstable.
