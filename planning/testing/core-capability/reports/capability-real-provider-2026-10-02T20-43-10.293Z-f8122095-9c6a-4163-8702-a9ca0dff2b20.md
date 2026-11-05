# Arbor Capability Report

- Run: `2026-10-02T20-43-10.293Z-f8122095-9c6a-4163-8702-a9ca0dff2b20`
- Mode: `real-provider`
- Started: 2026-10-02T20:43:10.293Z
- Node / Vitest: v24.21.0 / 5.0.1
- Provider ready: true
- JSON evidence: `planning/testing/core-capability/reports/capability-real-provider-2026-10-02T20-43-10.293Z-f8122095-9c6a-4163-8702-a9ca0dff2b20.json`

| Capability | L1 | L2 | L3 | Provider mode | Blocking reason |
|---|---|---|---|---|---|
| B01 Basic Human Conversation | PASS | PASS | PASS | NONE, RECORDING, REAL |  |
| B02 Executable Tool Use | PASS | PASS | PASS | NONE, REAL |  |
| B03 Control Action | PASS | PASS | PASS | NONE, FAKE, REAL |  |
| B04 Multi-turn Memory / Cognitive Continuity | PASS | PASS | PASS | NONE, RECORDING, REAL |  |
| B05 Human Steer | PASS | PASS | PASS | NONE, REAL |  |
| B06 Parent / Child Communication | PASS | PASS | PASS | NONE, REAL |  |
| B07 Responsibility Delegation | PASS | PASS | PASS | NONE, REAL |  |
| B08 Specialist Delegation | PASS | PASS | PASS | NONE, REAL |  |
| B09 Dependency / Deliverable | PASS | PASS | PASS | NONE, REAL |  |
| B10 Verification | PASS | PASS | PASS | NONE, RECORDING, REAL |  |
| B11 Completion / Acceptance | PASS | PASS | PASS | NONE, REAL |  |
| B12 Restart / Continuation | PASS | PASS | PASS | NONE, REAL |  |
| B13 Failure Recovery | PASS | PASS | PASS | NONE, REAL |  |
| B14 Web / Product Projection | PASS | PASS | PASS | NONE, REAL |  |

## Executed suites

Run 1: 246/246 tests passed; 0 failed.
- `tests/p10-humanintervention.test.ts`
- `tests/p12-providers-tools.test.ts`
- `tests/p14-transcript.test.ts`
- `tests/p4-integration.test.ts`
- `tests/p6-acceptance.test.ts`
- `tests/p6-critical-steer.test.ts`
- `tests/p6-formation-consumer.test.ts`
- `tests/p6-formation-governance.test.ts`
- `tests/p6-inbox-promotion.test.ts`
- `tests/p6-send-message.test.ts`
- `tests/p6-specialist-settlement.test.ts`
- `tests/p6-specialist-spawn.test.ts`
- `tests/p6-steer.test.ts`
- `tests/p7-acceptance.test.ts`
- `tests/p7-produce-deliverable.test.ts`
- `tests/p7-satisfy-dependency.test.ts`
- `tests/p8-acceptance-commands.test.ts`
- `tests/p8-acceptance.test.ts`
- `tests/p8-conclude.test.ts`
- `tests/p8-start-verification.test.ts`
- `tests/p9-acceptance.test.ts`
- `tests/p9-provider-disconnect.test.ts`
- `tests/p9-tool-outcome-unknown.test.ts`
- `tests/p9-worker-crash.test.ts`
- `tests/capability/harness.test.ts`
- `apps/single-workspace/test/i0-send-message-durable.test.ts`
- `apps/single-workspace/test/i0-send-message.test.ts`
- `apps/single-workspace/test/p14-conversation-history-pagination.test.ts`
- `apps/single-workspace/test/p5-restart-continuity.test.ts`
- `apps/single-workspace/test/p5-session-continuity.test.ts`
- `apps/single-workspace/test/p5-slice-acceptance.test.ts`
- `apps/single-workspace/test/p5-yield-wake.test.ts`
- `packages/agent-runtime/test/i0-control-registry.test.ts`
- `packages/domain/test/dependency.test.ts`
- `packages/domain/test/events.test.ts`
- `packages/domain/test/execution.test.ts`
- `packages/domain/test/session.test.ts`
- `packages/domain/test/verification.test.ts`
- `packages/domain/test/work.test.ts`
- `packages/domain/test/workspace.test.ts`
- `packages/model-context/test/p3-context.test.ts`
- `packages/model-context/test/p3-decode.test.ts`
- `packages/tool-runtime/test/p4-read.test.ts`
- `tests/capability/black-box/s1-s4-public-api.test.ts`
- `tests/capability/gray-box/b01-public-conversation.test.ts`
- `tests/capability/gray-box/b06-blob-message-inbox.test.ts`

Run 2: 34/34 tests passed; 0 failed.
- `apps/web/test/conversation-tab.test.tsx`
- `apps/web/test/views-render.test.tsx`

Run 3: 1/2 tests passed; 0 failed.
- `tests/capability/real-provider/b01-b04-conversation.test.ts`

Run 4: 1/1 tests passed; 0 failed.
- `tests/capability/real-provider/b02-s01e-executable.test.ts`

Run 5: 1/1 tests passed; 0 failed.
- `tests/capability/real-provider/b03-s01c-control.test.ts`

Run 6: 1/2 tests passed; 0 failed.
- `tests/capability/real-provider/b01-b04-conversation.test.ts`

Run 7: 1/1 tests passed; 0 failed.
- `tests/capability/real-provider/b05-human-steer.test.ts`

Run 8: 1/1 tests passed; 0 failed.
- `tests/capability/real-provider/b06-parent-child-communication.test.ts`

Run 9: 1/1 tests passed; 0 failed.
- `tests/capability/real-provider/b07-responsibility-delegation.test.ts`

Run 10: 1/1 tests passed; 0 failed.
- `tests/capability/real-provider/b08-specialist-delegation.test.ts`

Run 11: 1/1 tests passed; 0 failed.
- `tests/capability/real-provider/b09-dependency-deliverable.test.ts`

Run 12: 1/1 tests passed; 0 failed.
- `tests/capability/real-provider/b10-verification.test.ts`

Run 13: 1/1 tests passed; 0 failed.
- `tests/capability/real-provider/b11-completion-acceptance.test.ts`

Run 14: 1/1 tests passed; 0 failed.
- `tests/capability/real-provider/b12-restart-continuation.test.ts`

Run 15: 1/1 tests passed; 0 failed.
- `tests/capability/real-provider/b13-failure-recovery.test.ts`

Run 16: 1/1 tests passed; 0 failed.
- `tests/capability/real-provider/b14-web-projection.test.ts`

No failing test assertions were reported.

provider config file: none (env only)
