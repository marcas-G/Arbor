# Arbor Capability Report

- Run: `2026-09-28T01-09-06.411Z-3ebde7f2-4702-47b8-82d2-17ef0f4b41c4`
- Mode: `real-provider`
- Started: 2026-09-28T01:09:06.411Z
- Node / Vitest: v24.21.0 / 5.0.1
- Provider ready: true
- JSON evidence: `planning/testing/core-capability/reports/capability-real-provider-2026-09-28T01-09-06.411Z-3ebde7f2-4702-47b8-82d2-17ef0f4b41c4.json`

| Capability | L1 | L2 | L3 | Provider mode | Blocking reason |
|---|---|---|---|---|---|
| B01 Basic Human Conversation | PASS | FAIL | FAIL | NONE, RECORDING, REAL | B01-L2: One or more mapped suites failed: tests/capability/gray-box/b01-public-conversation.test.ts; B01-L3-REAL: Real-provider stability oracle: 0/3 PASS, 1/3 FAIL. |
| B02 Executable Tool Use | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B02-L1: Not selected in this qualification batch.; B02-L2: Not selected in this qualification batch.; B02-L3: Not selected in this qualification batch. |
| B03 Control Action | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B03-L1: Not selected in this qualification batch.; B03-L2: Not selected in this qualification batch.; B03-L3: Not selected in this qualification batch. |
| B04 Multi-turn Memory / Cognitive Continuity | PASS | PASS | FAIL | NONE, RECORDING, REAL | B04-L3-REAL: Real-provider stability oracle: 0/3 PASS, 1/3 FAIL. |
| B05 Human Steer | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B05-L1: Not selected in this qualification batch.; B05-L2: Not selected in this qualification batch.; B05-L3: Not selected in this qualification batch. |
| B06 Parent / Child Communication | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B06-L1: Not selected in this qualification batch.; B06-L2: Not selected in this qualification batch.; B06-L3: Not selected in this qualification batch. |
| B07 Responsibility Delegation | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B07-L1: Not selected in this qualification batch.; B07-L2: Not selected in this qualification batch.; B07-L3: Not selected in this qualification batch. |
| B08 Specialist Delegation | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B08-L1: Not selected in this qualification batch.; B08-L2: Not selected in this qualification batch.; B08-L3: Not selected in this qualification batch. |
| B09 Dependency / Deliverable | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B09-L1: Not selected in this qualification batch.; B09-L2: Not selected in this qualification batch.; B09-L3: Not selected in this qualification batch. |
| B10 Verification | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B10-L1: Not selected in this qualification batch.; B10-L2: Not selected in this qualification batch.; B10-L3: Not selected in this qualification batch. |
| B11 Completion / Acceptance | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B11-L1: Not selected in this qualification batch.; B11-L2: Not selected in this qualification batch.; B11-L3: Not selected in this qualification batch. |
| B12 Restart / Continuation | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B12-L1: Not selected in this qualification batch.; B12-L2: Not selected in this qualification batch.; B12-L3: Not selected in this qualification batch. |
| B13 Failure Recovery | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B13-L1: Not selected in this qualification batch.; B13-L2: Not selected in this qualification batch.; B13-L3: Not selected in this qualification batch. |
| B14 Web / Product Projection | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B14-L1: Not selected in this qualification batch.; B14-L2: Not selected in this qualification batch.; B14-L3: Not selected in this qualification batch. |

## Executed suites

Run 1: 13/14 tests passed; 1 failed.
- `tests/capability/harness.test.ts`
- `apps/single-workspace/test/p5-session-continuity.test.ts`
- `packages/domain/test/session.test.ts`
- `packages/model-context/test/p3-context.test.ts`
- `tests/capability/gray-box/b01-public-conversation.test.ts`

Run 2: 0/2 tests passed; 1 failed.
- `tests/capability/real-provider/b01-b04-conversation.test.ts`

Run 3: 0/2 tests passed; 1 failed.
- `tests/capability/real-provider/b01-b04-conversation.test.ts`

Failing assertions:
- `tests/capability/gray-box/b01-public-conversation.test.ts`: B01 L2 — public Human Input to durable transcript [B01-L2] submits through HTTP, runs the production daemon, and reads one Assistant turn
- `tests/capability/real-provider/b01-b04-conversation.test.ts`: real-provider capability sentinels [B01-L3-REAL] B01: external Human submission yields one durable Assistant transcript turn
- `tests/capability/real-provider/b01-b04-conversation.test.ts`: real-provider capability sentinels [B04-L3-REAL] B04: real-model recall uses same-root history and isolates another root

B01 real-provider behavioral sentinel failed or was unstable.
B04 real-provider behavioral sentinel failed or was unstable.
