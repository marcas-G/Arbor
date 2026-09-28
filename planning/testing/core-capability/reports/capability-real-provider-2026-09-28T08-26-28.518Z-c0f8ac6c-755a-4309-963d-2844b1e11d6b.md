# Arbor Capability Report

- Run: `2026-09-28T08-26-28.518Z-c0f8ac6c-755a-4309-963d-2844b1e11d6b`
- Mode: `real-provider`
- Started: 2026-09-28T08:26:28.518Z
- Node / Vitest: v26.0.0 / 5.0.1
- Provider ready: true
- JSON evidence: `planning/testing/core-capability/reports/capability-real-provider-2026-09-28T08-26-28.518Z-c0f8ac6c-755a-4309-963d-2844b1e11d6b.json`

| Capability | L1 | L2 | L3 | Provider mode | Blocking reason |
|---|---|---|---|---|---|
| B01 Basic Human Conversation | PASS | PASS | PASS | NONE, RECORDING, REAL |  |
| B02 Executable Tool Use | PASS | PASS | FAIL | NONE, REAL | B02-L3-REAL: Real-provider stability oracle: 0/3 PASS, 4/3 FAIL (evidence-counted). |
| B03 Control Action | PASS | PASS | FAIL | NONE, FAKE, REAL | B03-L3-REAL: Real-provider stability oracle: 0/3 PASS, 4/3 FAIL (evidence-counted). |
| B04 Multi-turn Memory / Cognitive Continuity | PASS | PASS | FAIL | NONE, RECORDING, REAL | B04-L3-REAL: Real-provider stability oracle: 0/3 PASS, 4/3 FAIL (evidence-counted). |
| B05 Human Steer | PASS | PASS | FAIL | NONE, REAL | B05-L3-REAL: Real-provider stability oracle: 0/3 PASS, 4/3 FAIL (evidence-counted). |
| B06 Parent / Child Communication | PASS | PASS | BLOCKED_BY_IMPLEMENTATION | NONE, REAL | B06-L3-REAL: The adopted model-facing control route and BlobStore-to-Message body path are not integrated. |
| B07 Responsibility Delegation | PASS | PASS | BLOCKED_BY_IMPLEMENTATION | NONE, REAL | B07-L3-REAL: Model-driven proposal requires the unimplemented and unauthorized adopted control route; ResponsibilityHandoff remains deferred. |
| B08 Specialist Delegation | PASS | PASS | BLOCKED_BY_IMPLEMENTATION | NONE, REAL | B08-L3-REAL: Model-selected specialist action requires the unimplemented and unauthorized adopted control route. |
| B09 Dependency / Deliverable | PASS | PASS | BLOCKED_BY_IMPLEMENTATION | NONE, REAL | B09-L3-REAL: The current composition has no adopted model-facing dependency/deliverable action route. |
| B10 Verification | PASS | PASS | BLOCKED_BY_DESIGN_GAP | NONE, REAL | B10-L3-REAL: Existing G-V2-2, G-V2-3, and G-V2-4 verification-reference/lifecycle gaps remain open. |
| B11 Completion / Acceptance | PASS | PASS | BLOCKED_BY_IMPLEMENTATION | NONE, REAL | B11-L3-REAL: Producer judgment through the adopted model-facing action route is not implemented/authorized; deterministic lifecycle gates are L2. |
| B12 Restart / Continuation | PASS | PASS | FAIL | NONE, REAL | B12-L3-REAL: Real-provider stability oracle: 0/3 PASS, 4/3 FAIL (evidence-counted). |
| B13 Failure Recovery | PASS | PASS | FAIL | NONE, REAL | B13-L3-REAL: Real-provider stability oracle: 0/3 PASS, 4/3 FAIL (evidence-counted). |
| B14 Web / Product Projection | PASS | PASS | FAIL | NONE, REAL | B14-L3-REAL: Real-provider stability oracle: 0/3 PASS, 4/3 FAIL (evidence-counted). |

## Executed suites

Run 1: 233/233 tests passed; 0 failed.
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
- `packages/domain/test/dependency.test.ts`
- `packages/domain/test/events.test.ts`
- `packages/domain/test/execution.test.ts`
- `packages/domain/test/session.test.ts`
- `packages/domain/test/verification.test.ts`
- `packages/domain/test/work.test.ts`
- `packages/domain/test/workspace.test.ts`
- `packages/agent-runtime/test/i0-control-registry.test.ts`
- `packages/model-context/test/p3-context.test.ts`
- `packages/model-context/test/p3-decode.test.ts`
- `packages/tool-runtime/test/p4-read.test.ts`
- `tests/capability/gray-box/b01-public-conversation.test.ts`
- `tests/capability/gray-box/b06-blob-message-inbox.test.ts`

Run 2: 31/31 tests passed; 0 failed.
- `apps/web/test/conversation-tab.test.tsx`
- `apps/web/test/views-render.test.tsx`

Run 3: 1/2 tests passed; 0 failed.
- `tests/capability/real-provider/b01-b04-conversation.test.ts`

Run 4: 0/1 tests passed; 1 failed.
- `tests/capability/real-provider/b02-s01e-executable.test.ts`

Run 5: 0/1 tests passed; 1 failed.
- `tests/capability/real-provider/b03-s01c-control.test.ts`

Run 6: 0/2 tests passed; 1 failed.
- `tests/capability/real-provider/b01-b04-conversation.test.ts`

Run 7: 0/1 tests passed; 1 failed.
- `tests/capability/real-provider/b05-human-steer.test.ts`

Run 8: 0/1 tests passed; 1 failed.
- `tests/capability/real-provider/b12-restart-continuation.test.ts`

Run 9: 0/1 tests passed; 1 failed.
- `tests/capability/real-provider/b13-failure-recovery.test.ts`

Run 10: 0/1 tests passed; 1 failed.
- `tests/capability/real-provider/b14-web-projection.test.ts`

Failing assertions:
- `tests/capability/real-provider/b02-s01e-executable.test.ts`: B02 L3 — real-model executable tool use (S01-E) [B02-L3-REAL] B02: a real model selects the shell tool, ToolRuntime executes it, and the observation returns to the model
- `tests/capability/real-provider/b03-s01c-control.test.ts`: B03 L3 — real-model control action (S01-C) [B03-L3-REAL] B03: a real model requests arbor_wait and the durable Wait effect is observable
- `tests/capability/real-provider/b01-b04-conversation.test.ts`: real-provider capability sentinels [B04-L3-REAL] B04: real-model recall uses same-root history and isolates another root
- `tests/capability/real-provider/b05-human-steer.test.ts`: B05 L3 — human steer reaches durable state and the next cognition [B05-L3-REAL] B05: a durable steer is visible in Work state and in the next real provider request
- `tests/capability/real-provider/b12-restart-continuation.test.ts`: B12 L3 — daemon process restart continues cognition without replay [B12-L3-REAL] B12: a killed daemon process restarts, completes the pending turn, and never replays the completed one
- `tests/capability/real-provider/b13-failure-recovery.test.ts`: B13 L3 — transient provider failure recovers without duplicated effects [B13-L3-REAL] B13: one injected transient provider failure stays visible and bounded and the turn still completes exactly once
- `tests/capability/real-provider/b14-web-projection.test.ts`: B14 L3 — web/product projection with real generated replies [B14-L3-REAL] B14: real-model turns project to the public transcript with correct pagination and no internal output

provider config file in effect: /home/lgao/work/web/arbor/capability.config.json
B02 real-provider behavioral sentinel failed or was unstable.
B03 real-provider behavioral sentinel failed or was unstable.
B04 real-provider behavioral sentinel failed or was unstable.
B05 real-provider behavioral sentinel failed or was unstable.
B12 real-provider behavioral sentinel failed or was unstable.
B13 real-provider behavioral sentinel failed or was unstable.
B14 real-provider behavioral sentinel failed or was unstable.
