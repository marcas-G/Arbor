# Arbor Capability Report

- Run: `2026-09-28T08-13-30.663Z-7bebcfca-1a11-4fd1-a2a4-738d958b6fcd`
- Mode: `real-provider`
- Started: 2026-09-28T08:13:30.663Z
- Node / Vitest: v26.0.0 / 5.0.1
- Provider ready: true
- JSON evidence: `planning/testing/core-capability/reports/capability-real-provider-2026-09-28T08-13-30.663Z-7bebcfca-1a11-4fd1-a2a4-738d958b6fcd.json`

| Capability | L1 | L2 | L3 | Provider mode | Blocking reason |
|---|---|---|---|---|---|
| B01 Basic Human Conversation | PASS | PASS | FAIL | NONE, RECORDING, REAL | B01-L3-REAL: Real-provider stability oracle: 0/3 PASS, 1/3 FAIL. |
| B02 Executable Tool Use | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B02-L1: Not selected in this qualification batch.; B02-L2: Not selected in this qualification batch.; B02-L3-REAL: Not selected in this qualification batch. |
| B03 Control Action | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B03-L1: Not selected in this qualification batch.; B03-L2: Not selected in this qualification batch.; B03-L3-REAL: Not selected in this qualification batch. |
| B04 Multi-turn Memory / Cognitive Continuity | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B04-L1: Not selected in this qualification batch.; B04-L2: Not selected in this qualification batch.; B04-L3-REAL: Not selected in this qualification batch. |
| B05 Human Steer | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B05-L1: Not selected in this qualification batch.; B05-L2: Not selected in this qualification batch.; B05-L3-REAL: Not selected in this qualification batch. |
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

Run 1: 10/10 tests passed; 0 failed.
- `tests/capability/harness.test.ts`
- `packages/domain/test/session.test.ts`
- `tests/capability/gray-box/b01-public-conversation.test.ts`

Run 2: 0/2 tests passed; 1 failed.
- `tests/capability/real-provider/b01-b04-conversation.test.ts`

Failing assertions:
- `tests/capability/real-provider/b01-b04-conversation.test.ts`: real-provider capability sentinels [B01-L3-REAL] B01: external Human submission yields one durable Assistant transcript turn

provider config file in effect: /home/lgao/work/web/arbor/capability.config.json
B01 real-provider behavioral sentinel failed or was unstable.
