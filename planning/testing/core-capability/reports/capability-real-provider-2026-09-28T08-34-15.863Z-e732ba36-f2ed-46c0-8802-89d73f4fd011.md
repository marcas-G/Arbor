# Arbor Capability Report

- Run: `2026-09-28T08-34-15.863Z-e732ba36-f2ed-46c0-8802-89d73f4fd011`
- Mode: `real-provider`
- Started: 2026-09-28T08:34:15.863Z
- Node / Vitest: v26.0.0 / 5.0.1
- Provider ready: true
- JSON evidence: `planning/testing/core-capability/reports/capability-real-provider-2026-09-28T08-34-15.863Z-e732ba36-f2ed-46c0-8802-89d73f4fd011.json`

| Capability | L1 | L2 | L3 | Provider mode | Blocking reason |
|---|---|---|---|---|---|
| B01 Basic Human Conversation | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B01-L1: Not selected in this qualification batch.; B01-L2: Not selected in this qualification batch.; B01-L3-REAL: Not selected in this qualification batch. |
| B02 Executable Tool Use | PASS | PASS | FAIL | NONE, REAL | B02-L3-REAL: Real-provider stability oracle: 0/3 PASS, 4/3 FAIL (evidence-counted). |
| B03 Control Action | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B03-L1: Not selected in this qualification batch.; B03-L2: Not selected in this qualification batch.; B03-L3-REAL: Not selected in this qualification batch. |
| B04 Multi-turn Memory / Cognitive Continuity | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B04-L1: Not selected in this qualification batch.; B04-L2: Not selected in this qualification batch.; B04-L3-REAL: Not selected in this qualification batch. |
| B05 Human Steer | PASS | PASS | FAIL | NONE, REAL | B05-L3-REAL: Real-provider stability oracle: 0/3 PASS, 4/3 FAIL (evidence-counted). |
| B06 Parent / Child Communication | NOT_RUN | NOT_RUN | BLOCKED_BY_IMPLEMENTATION | NONE, REAL | B06-L1: Not selected in this qualification batch.; B06-L2: Not selected in this qualification batch.; B06-L3-REAL: The adopted model-facing control route and BlobStore-to-Message body path are not integrated. |
| B07 Responsibility Delegation | NOT_RUN | NOT_RUN | BLOCKED_BY_IMPLEMENTATION | NONE, REAL | B07-L1: Not selected in this qualification batch.; B07-L2: Not selected in this qualification batch.; B07-L3-REAL: Model-driven proposal requires the unimplemented and unauthorized adopted control route; ResponsibilityHandoff remains deferred. |
| B08 Specialist Delegation | NOT_RUN | NOT_RUN | BLOCKED_BY_IMPLEMENTATION | NONE, REAL | B08-L1: Not selected in this qualification batch.; B08-L2: Not selected in this qualification batch.; B08-L3-REAL: Model-selected specialist action requires the unimplemented and unauthorized adopted control route. |
| B09 Dependency / Deliverable | NOT_RUN | NOT_RUN | BLOCKED_BY_IMPLEMENTATION | NONE, REAL | B09-L1: Not selected in this qualification batch.; B09-L2: Not selected in this qualification batch.; B09-L3-REAL: The current composition has no adopted model-facing dependency/deliverable action route. |
| B10 Verification | NOT_RUN | NOT_RUN | BLOCKED_BY_DESIGN_GAP | NONE, REAL | B10-L1: Not selected in this qualification batch.; B10-L2: Not selected in this qualification batch.; B10-L3-REAL: Existing G-V2-2, G-V2-3, and G-V2-4 verification-reference/lifecycle gaps remain open. |
| B11 Completion / Acceptance | NOT_RUN | NOT_RUN | BLOCKED_BY_IMPLEMENTATION | NONE, REAL | B11-L1: Not selected in this qualification batch.; B11-L2: Not selected in this qualification batch.; B11-L3-REAL: Producer judgment through the adopted model-facing action route is not implemented/authorized; deterministic lifecycle gates are L2. |
| B12 Restart / Continuation | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B12-L1: Not selected in this qualification batch.; B12-L2: Not selected in this qualification batch.; B12-L3-REAL: Not selected in this qualification batch. |
| B13 Failure Recovery | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B13-L1: Not selected in this qualification batch.; B13-L2: Not selected in this qualification batch.; B13-L3-REAL: Not selected in this qualification batch. |
| B14 Web / Product Projection | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B14-L1: Not selected in this qualification batch.; B14-L2: Not selected in this qualification batch.; B14-L3-REAL: Not selected in this qualification batch. |

## Executed suites

Run 1: 45/45 tests passed; 0 failed.
- `tests/p10-humanintervention.test.ts`
- `tests/p12-providers-tools.test.ts`
- `tests/p4-integration.test.ts`
- `tests/p6-critical-steer.test.ts`
- `tests/p6-steer.test.ts`
- `tests/capability/harness.test.ts`
- `packages/domain/test/work.test.ts`
- `packages/model-context/test/p3-decode.test.ts`
- `packages/tool-runtime/test/p4-read.test.ts`

Run 2: 0/1 tests passed; 1 failed.
- `tests/capability/real-provider/b02-s01e-executable.test.ts`

Run 3: 0/1 tests passed; 1 failed.
- `tests/capability/real-provider/b05-human-steer.test.ts`

Failing assertions:
- `tests/capability/real-provider/b02-s01e-executable.test.ts`: B02 L3 — real-model executable tool use (S01-E) [B02-L3-REAL] B02: a real model selects the shell tool, ToolRuntime executes it, and the observation returns to the model
- `tests/capability/real-provider/b05-human-steer.test.ts`: B05 L3 — human steer reaches durable state and the next cognition [B05-L3-REAL] B05: a durable steer is visible in Work state and in the next real provider request

provider config file in effect: /home/lgao/work/web/arbor/capability.config.json
B02 real-provider behavioral sentinel failed or was unstable.
B05 real-provider behavioral sentinel failed or was unstable.
