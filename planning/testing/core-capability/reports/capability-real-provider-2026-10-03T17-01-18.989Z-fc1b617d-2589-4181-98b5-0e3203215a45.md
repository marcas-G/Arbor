# Arbor Capability Report

- Run: `2026-10-03T17-01-18.989Z-fc1b617d-2589-4181-98b5-0e3203215a45`
- Mode: `real-provider`
- Started: 2026-10-03T17:01:18.989Z
- Node / Vitest: v24.21.0 / 5.0.1
- Provider ready: true
- JSON evidence: `planning/testing/core-capability/reports/capability-real-provider-2026-10-03T17-01-18.989Z-fc1b617d-2589-4181-98b5-0e3203215a45.json`

| Capability | L1 | L2 | L3 | Provider mode | Blocking reason |
|---|---|---|---|---|---|
| B01 Basic Human Conversation | PASS | PASS | PASS | NONE, RECORDING, REAL |  |
| B02 Executable Tool Use | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B02-L1: Not selected in this qualification batch.; B02-L2: Not selected in this qualification batch.; B02-L3-REAL: Not selected in this qualification batch. |
| B03 Control Action | PASS | PASS | PASS | NONE, FAKE, REAL |  |
| B04 Multi-turn Memory / Cognitive Continuity | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B04-L1: Not selected in this qualification batch.; B04-L2: Not selected in this qualification batch.; B04-L3-REAL: Not selected in this qualification batch. |
| B05 Human Steer | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B05-L1: Not selected in this qualification batch.; B05-L2: Not selected in this qualification batch.; B05-L3-REAL: Not selected in this qualification batch. |
| B06 Parent / Child Communication | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B06-L1: Not selected in this qualification batch.; B06-L2: Not selected in this qualification batch.; B06-L3-REAL: Not selected in this qualification batch. |
| B07 Responsibility Delegation | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B07-L1: Not selected in this qualification batch.; B07-L2: Not selected in this qualification batch.; B07-L3-REAL: Not selected in this qualification batch. |
| B08 Specialist Delegation | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B08-L1: Not selected in this qualification batch.; B08-L2: Not selected in this qualification batch.; B08-L3-REAL: Not selected in this qualification batch. |
| B09 Dependency / Deliverable | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B09-L1: Not selected in this qualification batch.; B09-L2: Not selected in this qualification batch.; B09-L3-REAL: Not selected in this qualification batch. |
| B10 Verification | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B10-L1: Not selected in this qualification batch.; B10-L2: Not selected in this qualification batch.; B10-L3-REAL: Not selected in this qualification batch. |
| B11 Completion / Acceptance | PASS | PASS | PASS | NONE, REAL |  |
| B12 Restart / Continuation | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B12-L1: Not selected in this qualification batch.; B12-L2: Not selected in this qualification batch.; B12-L3-REAL: Not selected in this qualification batch. |
| B13 Failure Recovery | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B13-L1: Not selected in this qualification batch.; B13-L2: Not selected in this qualification batch.; B13-L3-REAL: Not selected in this qualification batch. |
| B14 Web / Product Projection | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B14-L1: Not selected in this qualification batch.; B14-L2: Not selected in this qualification batch.; B14-L3-REAL: Not selected in this qualification batch. |

## Executed suites

Run 1: 57/57 tests passed; 0 failed.
- `tests/p6-acceptance.test.ts`
- `tests/p6-send-message.test.ts`
- `tests/p8-acceptance-commands.test.ts`
- `tests/p8-acceptance.test.ts`
- `tests/capability/harness.test.ts`
- `apps/single-workspace/test/i0-send-message-durable.test.ts`
- `apps/single-workspace/test/i0-send-message.test.ts`
- `apps/single-workspace/test/p5-slice-acceptance.test.ts`
- `apps/single-workspace/test/p5-yield-wake.test.ts`
- `packages/agent-runtime/test/i0-control-registry.test.ts`
- `packages/domain/test/events.test.ts`
- `packages/domain/test/session.test.ts`
- `packages/domain/test/work.test.ts`
- `tests/capability/gray-box/b01-public-conversation.test.ts`

Run 2: 1/2 tests passed; 0 failed.
- `tests/capability/real-provider/b01-b04-conversation.test.ts`

Run 3: 1/1 tests passed; 0 failed.
- `tests/capability/real-provider/b03-s01c-control.test.ts`

Run 4: 1/1 tests passed; 0 failed.
- `tests/capability/real-provider/b11-completion-acceptance.test.ts`

No failing test assertions were reported.

provider config file: none (env only)
