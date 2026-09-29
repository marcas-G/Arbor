# Arbor Capability Report

- Run: `2026-09-29T00-42-28.473Z-58cb797d-a02c-4c54-8063-4d67789b18ad`
- Mode: `real-provider`
- Started: 2026-09-29T00:42:28.473Z
- Node / Vitest: v26.0.0 / 5.0.1
- Provider ready: true
- JSON evidence: `planning/testing/core-capability/reports/capability-real-provider-2026-09-29T00-42-28.473Z-58cb797d-a02c-4c54-8063-4d67789b18ad.json`

| Capability | L1 | L2 | L3 | Provider mode | Blocking reason |
|---|---|---|---|---|---|
| B01 Basic Human Conversation | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B01-L1: Not selected in this qualification batch.; B01-L2: Not selected in this qualification batch.; B01-L3-REAL: Not selected in this qualification batch. |
| B02 Executable Tool Use | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B02-L1: Not selected in this qualification batch.; B02-L2: Not selected in this qualification batch.; B02-L3-REAL: Not selected in this qualification batch. |
| B03 Control Action | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B03-L1: Not selected in this qualification batch.; B03-L2: Not selected in this qualification batch.; B03-L3-REAL: Not selected in this qualification batch. |
| B04 Multi-turn Memory / Cognitive Continuity | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B04-L1: Not selected in this qualification batch.; B04-L2: Not selected in this qualification batch.; B04-L3-REAL: Not selected in this qualification batch. |
| B05 Human Steer | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B05-L1: Not selected in this qualification batch.; B05-L2: Not selected in this qualification batch.; B05-L3-REAL: Not selected in this qualification batch. |
| B06 Parent / Child Communication | PASS | PASS | FAIL | NONE, REAL | B06-L3-REAL: Real-provider stability oracle: 0/3 PASS, 4/3 FAIL (evidence-counted). |
| B07 Responsibility Delegation | PASS | PASS | FAIL | NONE, REAL | B07-L3-REAL: Real-provider stability oracle: 0/3 PASS, 4/3 FAIL (evidence-counted). |
| B08 Specialist Delegation | PASS | PASS | FAIL | NONE, REAL | B08-L3-REAL: Real-provider stability oracle: 0/3 PASS, 4/3 FAIL (evidence-counted). |
| B09 Dependency / Deliverable | PASS | PASS | FAIL | NONE, REAL | B09-L3-REAL: Real-provider stability oracle: 0/3 PASS, 4/3 FAIL (evidence-counted). |
| B10 Verification | NOT_RUN | NOT_RUN | BLOCKED_BY_DESIGN_GAP | NONE, REAL | B10-L1: Not selected in this qualification batch.; B10-L2: Not selected in this qualification batch.; B10-L3-REAL: Existing G-V2-2, G-V2-3, and G-V2-4 verification-reference/lifecycle gaps remain open. |
| B11 Completion / Acceptance | PASS | PASS | FAIL | NONE, REAL | B11-L3-REAL: Real-provider stability oracle: 0/3 PASS, 4/3 FAIL (evidence-counted). |
| B12 Restart / Continuation | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B12-L1: Not selected in this qualification batch.; B12-L2: Not selected in this qualification batch.; B12-L3-REAL: Not selected in this qualification batch. |
| B13 Failure Recovery | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B13-L1: Not selected in this qualification batch.; B13-L2: Not selected in this qualification batch.; B13-L3-REAL: Not selected in this qualification batch. |
| B14 Web / Product Projection | NOT_RUN | NOT_RUN | NOT_RUN | NONE, REAL | B14-L1: Not selected in this qualification batch.; B14-L2: Not selected in this qualification batch.; B14-L3-REAL: Not selected in this qualification batch. |

## Executed suites

Run 1: 114/114 tests passed; 0 failed.
- `tests/p6-acceptance.test.ts`
- `tests/p6-formation-consumer.test.ts`
- `tests/p6-formation-governance.test.ts`
- `tests/p6-inbox-promotion.test.ts`
- `tests/p6-send-message.test.ts`
- `tests/p6-specialist-settlement.test.ts`
- `tests/p6-specialist-spawn.test.ts`
- `tests/p7-acceptance.test.ts`
- `tests/p7-produce-deliverable.test.ts`
- `tests/p7-satisfy-dependency.test.ts`
- `tests/p8-acceptance-commands.test.ts`
- `tests/p8-acceptance.test.ts`
- `tests/capability/harness.test.ts`
- `packages/domain/test/dependency.test.ts`
- `packages/domain/test/events.test.ts`
- `packages/domain/test/execution.test.ts`
- `packages/domain/test/work.test.ts`
- `packages/domain/test/workspace.test.ts`
- `tests/capability/gray-box/b06-blob-message-inbox.test.ts`

Run 2: 0/1 tests passed; 1 failed.
- `tests/capability/real-provider/b06-parent-child-communication.test.ts`

Run 3: 0/1 tests passed; 1 failed.
- `tests/capability/real-provider/b07-responsibility-delegation.test.ts`

Run 4: 0/1 tests passed; 1 failed.
- `tests/capability/real-provider/b08-specialist-delegation.test.ts`

Run 5: 0/1 tests passed; 1 failed.
- `tests/capability/real-provider/b09-dependency-deliverable.test.ts`

Run 6: 0/1 tests passed; 1 failed.
- `tests/capability/real-provider/b11-completion-acceptance.test.ts`

Failing assertions:
- `tests/capability/real-provider/b06-parent-child-communication.test.ts`: B06 L3 — parent/child communication through the adopted route [B06-L3-REAL] B06: a real model in a child workspace sends a durable Report to the parent
- `tests/capability/real-provider/b07-responsibility-delegation.test.ts`: B07 L3 — responsibility delegation through the adopted route [B07-L3-REAL] B07: a real model proposes a child workspace; governance decision remains human
- `tests/capability/real-provider/b08-specialist-delegation.test.ts`: B08 L3 — specialist delegation through the adopted route [B08-L3-REAL] B08: a real model spawns a temporary specialist; no durable responsibility escapes
- `tests/capability/real-provider/b09-dependency-deliverable.test.ts`: B09 L3 — dependency declaration through the adopted route [B09-L3-REAL] B09: a real model declares a dependency; only the matcher may ever satisfy it
- `tests/capability/real-provider/b11-completion-acceptance.test.ts`: B11 L3 — completion claim through the adopted route [B11-L3-REAL] B11: a real model claims completion; verification gates the lifecycle, not the claim

provider config file in effect: /home/lgao/work/web/arbor/capability.config.json
B06 real-provider behavioral sentinel failed or was unstable.
B07 real-provider behavioral sentinel failed or was unstable.
B08 real-provider behavioral sentinel failed or was unstable.
B09 real-provider behavioral sentinel failed or was unstable.
B11 real-provider behavioral sentinel failed or was unstable.
