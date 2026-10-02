# Arbor Capability Report

- Run: `2026-10-02T11-29-21.885Z-e3b4f8bb-33b6-45b5-8a89-a654f6674c9d`
- Mode: `real-provider`
- Started: 2026-10-02T11:29:21.885Z
- Node / Vitest: v24.21.0 / 5.0.1
- Provider ready: true
- JSON evidence: `planning/testing/core-capability/reports/capability-real-provider-2026-10-02T11-29-21.885Z-e3b4f8bb-33b6-45b5-8a89-a654f6674c9d.json`

| Capability | L1 | L2 | L3 | Provider mode | Blocking reason |
|---|---|---|---|---|---|
| B01 Basic Human Conversation | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B01-L1: Not selected in this qualification batch.; B01-L2: Not selected in this qualification batch.; B01-L3-REAL: Not selected in this qualification batch. |
| B02 Executable Tool Use | PASS | PASS | PASS | NONE, REAL |  |
| B03 Control Action | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B03-L1: Not selected in this qualification batch.; B03-L2: Not selected in this qualification batch.; B03-L3-REAL: Not selected in this qualification batch. |
| B04 Multi-turn Memory / Cognitive Continuity | PASS | PASS | PASS | NONE, RECORDING, REAL |  |
| B05 Human Steer | PASS | PASS | PASS | NONE, REAL |  |
| B06 Parent / Child Communication | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B06-L1: Not selected in this qualification batch.; B06-L2: Not selected in this qualification batch.; B06-L3-REAL: Not selected in this qualification batch. |
| B07 Responsibility Delegation | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B07-L1: Not selected in this qualification batch.; B07-L2: Not selected in this qualification batch.; B07-L3-REAL: Not selected in this qualification batch. |
| B08 Specialist Delegation | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B08-L1: Not selected in this qualification batch.; B08-L2: Not selected in this qualification batch.; B08-L3-REAL: Not selected in this qualification batch. |
| B09 Dependency / Deliverable | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B09-L1: Not selected in this qualification batch.; B09-L2: Not selected in this qualification batch.; B09-L3-REAL: Not selected in this qualification batch. |
| B10 Verification | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B10-L1: Not selected in this qualification batch.; B10-L2: Not selected in this qualification batch.; B10-L3-REAL: Not selected in this qualification batch. |
| B11 Completion / Acceptance | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B11-L1: Not selected in this qualification batch.; B11-L2: Not selected in this qualification batch.; B11-L3-REAL: Not selected in this qualification batch. |
| B12 Restart / Continuation | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B12-L1: Not selected in this qualification batch.; B12-L2: Not selected in this qualification batch.; B12-L3-REAL: Not selected in this qualification batch. |
| B13 Failure Recovery | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B13-L1: Not selected in this qualification batch.; B13-L2: Not selected in this qualification batch.; B13-L3-REAL: Not selected in this qualification batch. |
| B14 Web / Product Projection | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B14-L1: Not selected in this qualification batch.; B14-L2: Not selected in this qualification batch.; B14-L3-REAL: Not selected in this qualification batch. |

## Executed suites

Run 1: 52/53 tests passed; 1 failed.
- `tests/p10-humanintervention.test.ts`
- `tests/p12-providers-tools.test.ts`
- `tests/p4-integration.test.ts`
- `tests/p6-critical-steer.test.ts`
- `tests/p6-steer.test.ts`
- `tests/capability/harness.test.ts`
- `apps/single-workspace/test/p5-session-continuity.test.ts`
- `packages/domain/test/work.test.ts`
- `packages/model-context/test/p3-context.test.ts`
- `packages/model-context/test/p3-decode.test.ts`
- `packages/tool-runtime/test/p4-read.test.ts`

Run 2: 1/1 tests passed; 0 failed.
- `tests/capability/real-provider/b02-s01e-executable.test.ts`

Run 3: 1/2 tests passed; 0 failed.
- `tests/capability/real-provider/b01-b04-conversation.test.ts`

Run 4: 1/1 tests passed; 0 failed.
- `tests/capability/real-provider/b05-human-steer.test.ts`

Failing assertions:
- `tests/capability/harness.test.ts`: Core Capability test harness metadata retains a mechanical blocker for every non-runnable L3 case

provider config file: none (env only)
