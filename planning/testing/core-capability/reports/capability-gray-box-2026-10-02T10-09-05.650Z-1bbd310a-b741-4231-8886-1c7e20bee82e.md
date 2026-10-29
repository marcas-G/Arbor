# Arbor Capability Report

- Run: `2026-10-02T10-09-05.650Z-1bbd310a-b741-4231-8886-1c7e20bee82e`
- Mode: `gray-box`
- Started: 2026-10-02T10:09:05.650Z
- Node / Vitest: v24.21.0 / 5.0.1
- Provider ready: false
- JSON evidence: `planning/testing/core-capability/reports/capability-gray-box-2026-10-02T10-09-05.650Z-1bbd310a-b741-4231-8886-1c7e20bee82e.json`

| Capability | L1 | L2 | L3 | Provider mode | Blocking reason |
|---|---|---|---|---|---|
| B01 Basic Human Conversation | PASS | PASS | NOT_RUN | NONE, RECORDING, REAL | B01-L3-REAL: Real-provider cases run only with pnpm test:capability:real. |
| B02 Executable Tool Use | PASS | PASS | NOT_RUN | NONE, REAL | B02-L3-REAL: Real-provider cases run only with pnpm test:capability:real. |
| B03 Control Action | PASS | PASS | NOT_RUN | NONE, FAKE, REAL | B03-L3-REAL: Real-provider cases run only with pnpm test:capability:real. |
| B04 Multi-turn Memory / Cognitive Continuity | PASS | PASS | NOT_RUN | NONE, RECORDING, REAL | B04-L3-REAL: Real-provider cases run only with pnpm test:capability:real. |
| B05 Human Steer | PASS | PASS | NOT_RUN | NONE, REAL | B05-L3-REAL: Real-provider cases run only with pnpm test:capability:real. |
| B06 Parent / Child Communication | PASS | PASS | NOT_RUN | NONE, REAL | B06-L3-REAL: Real-provider cases run only with pnpm test:capability:real. |
| B07 Responsibility Delegation | PASS | PASS | NOT_RUN | NONE, REAL | B07-L3-REAL: Real-provider cases run only with pnpm test:capability:real. |
| B08 Specialist Delegation | PASS | PASS | NOT_RUN | NONE, REAL | B08-L3-REAL: Real-provider cases run only with pnpm test:capability:real. |
| B09 Dependency / Deliverable | PASS | PASS | NOT_RUN | NONE, REAL | B09-L3-REAL: Real-provider cases run only with pnpm test:capability:real. |
| B10 Verification | PASS | PASS | BLOCKED_BY_DESIGN_GAP | NONE, REAL | B10-L3-REAL: Existing G-V2-2, G-V2-3, and G-V2-4 verification-reference/lifecycle gaps remain open. |
| B11 Completion / Acceptance | PASS | PASS | NOT_RUN | NONE, REAL | B11-L3-REAL: Real-provider cases run only with pnpm test:capability:real. |
| B12 Restart / Continuation | PASS | PASS | NOT_RUN | NONE, REAL | B12-L3-REAL: Real-provider cases run only with pnpm test:capability:real. |
| B13 Failure Recovery | PASS | PASS | NOT_RUN | NONE, REAL | B13-L3-REAL: Real-provider cases run only with pnpm test:capability:real. |
| B14 Web / Product Projection | PASS | PASS | NOT_RUN | NONE, REAL | B14-L3-REAL: Real-provider cases run only with pnpm test:capability:real. |

## Executed suites

Run 1: 242/242 tests passed; 0 failed.
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
- `tests/capability/gray-box/b01-public-conversation.test.ts`
- `tests/capability/gray-box/b06-blob-message-inbox.test.ts`

Run 2: 34/34 tests passed; 0 failed.
- `apps/web/test/conversation-tab.test.tsx`
- `apps/web/test/views-render.test.tsx`

No failing test assertions were reported.
