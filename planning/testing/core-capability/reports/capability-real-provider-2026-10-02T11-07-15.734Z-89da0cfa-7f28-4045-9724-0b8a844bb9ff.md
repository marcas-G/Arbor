# Arbor Capability Report

- Run: `2026-10-02T11-07-15.734Z-89da0cfa-7f28-4045-9724-0b8a844bb9ff`
- Mode: `real-provider`
- Started: 2026-10-02T11:07:15.734Z
- Node / Vitest: v24.21.0 / 5.0.1
- Provider ready: true
- JSON evidence: `planning/testing/core-capability/reports/capability-real-provider-2026-10-02T11-07-15.734Z-89da0cfa-7f28-4045-9724-0b8a844bb9ff.json`

| Capability | L1 | L2 | L3 | Provider mode | Blocking reason |
|---|---|---|---|---|---|
| B01 Basic Human Conversation | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B01-L1: Not selected in this qualification batch.; B01-L2: Not selected in this qualification batch.; B01-L3-REAL: Not selected in this qualification batch. |
| B02 Executable Tool Use | PASS | PASS | FAIL | NONE, REAL | B02-L3-REAL: Real-provider stability oracle: 0/3 PASS, 3/3 FAIL (evidence-counted). |
| B03 Control Action | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B03-L1: Not selected in this qualification batch.; B03-L2: Not selected in this qualification batch.; B03-L3-REAL: Not selected in this qualification batch. |
| B04 Multi-turn Memory / Cognitive Continuity | PASS | PASS | FAIL | NONE, RECORDING, REAL | B04-L3-REAL: Real-provider stability oracle: 0/3 PASS, 3/3 FAIL (evidence-counted). |
| B05 Human Steer | PASS | PASS | FAIL | NONE, REAL | B05-L3-REAL: Real-provider stability oracle: 0/3 PASS, 3/3 FAIL (evidence-counted). |
| B06 Parent / Child Communication | PASS | PASS | PASS | NONE, REAL |  |
| B07 Responsibility Delegation | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B07-L1: Not selected in this qualification batch.; B07-L2: Not selected in this qualification batch.; B07-L3-REAL: Not selected in this qualification batch. |
| B08 Specialist Delegation | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B08-L1: Not selected in this qualification batch.; B08-L2: Not selected in this qualification batch.; B08-L3-REAL: Not selected in this qualification batch. |
| B09 Dependency / Deliverable | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B09-L1: Not selected in this qualification batch.; B09-L2: Not selected in this qualification batch.; B09-L3-REAL: Not selected in this qualification batch. |
| B10 Verification | NOT_RUN | NOT_RUN | BLOCKED_BY_DESIGN_GAP | NONE, REAL | B10-L1: Not selected in this qualification batch.; B10-L2: Not selected in this qualification batch.; B10-L3-REAL: Existing G-V2-2, G-V2-3, and G-V2-4 verification-reference/lifecycle gaps remain open. |
| B11 Completion / Acceptance | PASS | PASS | FAIL | NONE, REAL | B11-L3-REAL: Real-provider stability oracle: 2/3 PASS, 1/3 FAIL (evidence-counted). |
| B12 Restart / Continuation | PASS | PASS | PASS | NONE, REAL |  |
| B13 Failure Recovery | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B13-L1: Not selected in this qualification batch.; B13-L2: Not selected in this qualification batch.; B13-L3-REAL: Not selected in this qualification batch. |
| B14 Web / Product Projection | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B14-L1: Not selected in this qualification batch.; B14-L2: Not selected in this qualification batch.; B14-L3-REAL: Not selected in this qualification batch. |

## Executed suites

Run 1: 119/119 tests passed; 0 failed.
- `tests/p10-humanintervention.test.ts`
- `tests/p12-providers-tools.test.ts`
- `tests/p4-integration.test.ts`
- `tests/p6-critical-steer.test.ts`
- `tests/p6-inbox-promotion.test.ts`
- `tests/p6-send-message.test.ts`
- `tests/p6-steer.test.ts`
- `tests/p8-acceptance-commands.test.ts`
- `tests/p8-acceptance.test.ts`
- `tests/p9-provider-disconnect.test.ts`
- `tests/p9-tool-outcome-unknown.test.ts`
- `tests/p9-worker-crash.test.ts`
- `tests/capability/harness.test.ts`
- `apps/single-workspace/test/p5-restart-continuity.test.ts`
- `apps/single-workspace/test/p5-session-continuity.test.ts`
- `packages/domain/test/events.test.ts`
- `packages/domain/test/execution.test.ts`
- `packages/domain/test/work.test.ts`
- `packages/model-context/test/p3-context.test.ts`
- `packages/model-context/test/p3-decode.test.ts`
- `packages/tool-runtime/test/p4-read.test.ts`
- `tests/capability/gray-box/b06-blob-message-inbox.test.ts`

Run 2: 0/1 tests passed; 1 failed.
- `tests/capability/real-provider/b02-s01e-executable.test.ts`

Run 3: 0/2 tests passed; 1 failed.
- `tests/capability/real-provider/b01-b04-conversation.test.ts`

Run 4: 0/1 tests passed; 1 failed.
- `tests/capability/real-provider/b05-human-steer.test.ts`

Run 5: 1/1 tests passed; 0 failed.
- `tests/capability/real-provider/b06-parent-child-communication.test.ts`

Run 6: 0/1 tests passed; 1 failed.
- `tests/capability/real-provider/b11-completion-acceptance.test.ts`

Run 7: 0/1 tests passed; 1 failed.
- `tests/capability/real-provider/b12-restart-continuation.test.ts`

Failing assertions:
- `tests/capability/real-provider/b02-s01e-executable.test.ts`: B02 L3 — real-model executable tool use (S01-E) [B02-L3-REAL] B02: a real model selects the shell tool, ToolRuntime executes it, and the observation returns to the model
- `tests/capability/real-provider/b01-b04-conversation.test.ts`: real-provider capability sentinels [B04-L3-REAL] B04: real-model recall uses same-root history and isolates another root
- `tests/capability/real-provider/b05-human-steer.test.ts`: B05 L3 — human steer reaches durable state and the next cognition [B05-L3-REAL] B05: a durable steer is visible in Work state and in the next real provider request
- `tests/capability/real-provider/b11-completion-acceptance.test.ts`: B11 L3 — completion claim through the adopted route [B11-L3-REAL] B11: a real model claims completion; verification gates the lifecycle, not the claim
- `tests/capability/real-provider/b12-restart-continuation.test.ts`: B12 L3 — daemon process restart continues cognition without replay [B12-L3-REAL] B12: a killed daemon process restarts, completes the pending turn, and never replays the completed one

provider config file: none (env only)
B02 real-provider behavioral sentinel failed or was unstable.
B04 real-provider behavioral sentinel failed or was unstable.
B05 real-provider behavioral sentinel failed or was unstable.
B11 real-provider behavioral sentinel failed or was unstable.
B12 real-provider behavioral sentinel failed or was unstable.
