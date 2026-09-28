# Arbor Capability Report

- Run: `2026-09-27T20-03-10.924Z-9644ad7e-f35f-4aa5-9f6b-120b139dcf1f`
- Mode: `real-provider`
- Started: 2026-09-27T20:03:10.924Z
- Node / Vitest: v24.21.0 / 5.0.1
- Provider ready: False
- JSON evidence: `planning/testing/core-capability/reports/capability-real-provider-2026-09-27T20-03-10.924Z-9644ad7e-f35f-4aa5-9f6b-120b139dcf1f.json`

| Capability | L1 | L2 | L3 | Provider mode | Blocking reason |
|---|---|---|---|---|---|
| B01 Basic Human Conversation | PASS | PASS | NOT_RUN | RECORDING, REAL | B01-L3-REAL: Real provider configuration missing: ARBOR_CAPABILITY_PROVIDER_URL, ARBOR_CAPABILITY_MODEL, ARBOR_CAPABILITY_SERVER_BUILD_ID, ARBOR_CAPABILITY_AUTH |
| B02 Executable Tool Use | PASS | PASS | NOT_RUN | NONE, REAL | B02-L3-REAL: Real provider configuration missing: ARBOR_CAPABILITY_PROVIDER_URL, ARBOR_CAPABILITY_MODEL, ARBOR_CAPABILITY_SERVER_BUILD_ID, ARBOR_CAPABILITY_AUTH |
| B03 Control Action | PASS | BLOCKED_BY_IMPLEMENTATION | BLOCKED_BY_IMPLEMENTATION | NONE, REAL | B03-L2: The legacy/direct SendMessage Application path is not the adopted ControlToolRegistry → AgentAction → Application route; DID v1.18 does not authorize that implementation.; B03-L3-REAL: DID v1.18 does not authorize ControlToolRegistry implementation or qualification; adopted control route is not implemented.; B03-L2: The legacy/direct SendMessage Application path is not the adopted ControlToolRegistry → AgentAction → Application route; DID v1.18 does not authorize that implementation. |
| B04 Multi-turn Memory / Cognitive Continuity | PASS | PASS | NOT_RUN | RECORDING, REAL | B04-L3-REAL: Real provider configuration missing: ARBOR_CAPABILITY_PROVIDER_URL, ARBOR_CAPABILITY_MODEL, ARBOR_CAPABILITY_SERVER_BUILD_ID, ARBOR_CAPABILITY_AUTH |
| B05 Human Steer | PASS | PASS | NOT_RUN | NONE, REAL | B05-L3-REAL: Real provider configuration missing: ARBOR_CAPABILITY_PROVIDER_URL, ARBOR_CAPABILITY_MODEL, ARBOR_CAPABILITY_SERVER_BUILD_ID, ARBOR_CAPABILITY_AUTH |
| B06 Parent / Child Communication | PASS | PASS | BLOCKED_BY_IMPLEMENTATION | NONE, REAL | B06-L3-REAL: The adopted model-facing control route and BlobStore-to-Message body path are not integrated. |
| B07 Responsibility Delegation | PASS | PASS | BLOCKED_BY_IMPLEMENTATION | NONE, REAL | B07-L3-REAL: Model-driven proposal requires the unimplemented and unauthorized adopted control route; ResponsibilityHandoff remains deferred. |
| B08 Specialist Delegation | PASS | PASS | BLOCKED_BY_IMPLEMENTATION | NONE, REAL | B08-L3-REAL: Model-selected specialist action requires the unimplemented and unauthorized adopted control route. |
| B09 Dependency / Deliverable | PASS | PASS | BLOCKED_BY_IMPLEMENTATION | NONE, REAL | B09-L3-REAL: The current composition has no adopted model-facing dependency/deliverable action route. |
| B10 Verification | PASS | PASS | BLOCKED_BY_DESIGN_GAP | NONE, REAL | B10-L3-REAL: Existing G-V2-2, G-V2-3, and G-V2-4 verification-reference/lifecycle gaps remain open. |
| B11 Completion / Acceptance | PASS | PASS | BLOCKED_BY_IMPLEMENTATION | NONE, REAL | B11-L3-REAL: Producer judgment through the adopted model-facing action route is not implemented/authorized; deterministic lifecycle gates are L2. |
| B12 Restart / Continuation | PASS | PASS | BLOCKED_BY_IMPLEMENTATION | NONE, REAL | B12-L3-REAL: Existing recovery coverage rebuilds a layer in-process; a process-level daemon restart and real cognition continuation sentinel is not implemented. |
| B13 Failure Recovery | PASS | PASS | NOT_RUN | NONE, REAL | B13-L3-REAL: Real provider configuration missing: ARBOR_CAPABILITY_PROVIDER_URL, ARBOR_CAPABILITY_MODEL, ARBOR_CAPABILITY_SERVER_BUILD_ID, ARBOR_CAPABILITY_AUTH |
| B14 Web / Product Projection | PASS | PASS | NOT_RUN | NONE, REAL | B14-L3-REAL: Real provider configuration missing: ARBOR_CAPABILITY_PROVIDER_URL, ARBOR_CAPABILITY_MODEL, ARBOR_CAPABILITY_SERVER_BUILD_ID, ARBOR_CAPABILITY_AUTH |

## Executed suites

Run 1: 232/232 tests passed; 0 failed.
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
- `apps/single-workspace/test/p14-conversation-history-pagination.test.ts`
- `apps/single-workspace/test/p14-real-provider-conversation.test.ts`
- `apps/single-workspace/test/p5-restart-continuity.test.ts`
- `apps/single-workspace/test/p5-session-continuity.test.ts`
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

Run 2: 31/31 tests passed; 0 failed.
- `apps/web/test/conversation-tab.test.tsx`
- `apps/web/test/views-render.test.tsx`

No failing test assertions were reported.

REAL provider cases were not launched; missing configuration: ARBOR_CAPABILITY_PROVIDER_URL, ARBOR_CAPABILITY_MODEL, ARBOR_CAPABILITY_SERVER_BUILD_ID, ARBOR_CAPABILITY_AUTH
B03 direct/legacy Application suites passed as supporting evidence; the adopted control-route case is BLOCKED_BY_IMPLEMENTATION.
