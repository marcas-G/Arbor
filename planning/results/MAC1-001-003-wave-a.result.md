# MAC-P1 Wave A — Contract Landing and Root Work Initiation Surface

**Date:** 2026-10-04
**Status:** COMPLETE FOR THIS SLICE — MAC-P1 remains OPEN

## Scope completed

- accepted MAC governance landed as Problem & Goals v1.3, Scenarios v1.3,
  System Design v1.9, DID v1.31 and `docs/design/implementation/MAC/**`;
- P2/P3/P6/P7/P8/P12/P17 indices record the MAC successor;
- MAC-P1 implementation entry gate satisfied;
- RootConversation now exposes exactly `assign_work`, with zero executable
  tools;
- Root prompt asset upgraded to version 4 and differentiates ordinary text from
  a bounded durable outcome;
- explicit prohibitions must be preserved in Work constraints;
- Runtime rejects a ConversationResponseEpisode assigning to any Workspace
  other than its current root Workspace;
- Root-assigned Work has null predecessor and Runtime-bound IDs/revisions;
- MAC-P1 WorkEpisode control surface is reduced to wait/update_plan/
  claim_completion (when registered); later-phase formation, messaging,
  dependency and legacy specialist controls are hidden;
- WorkspaceInput and historical ExecutionBoundSpecialist new-write action
  surfaces fail closed;
- generic Agent Loop tests now inject a test TurnProfile rather than relying on
  a production universal control surface.

## TDD evidence

New/updated proofs:

- `tests/architecture/crac-architecture.test.ts`
- `tests/architecture/control-action-permission.test.ts`
- `packages/model-context/test/p17-turn-profile.test.ts`
- `apps/single-workspace/test/p14-real-provider-conversation.test.ts`
- `apps/single-workspace/test/wave2-claim-completion.test.ts`
- `apps/single-workspace/test/i0-send-message-durable.test.ts`
- `tests/p3-driver.test.ts`

The direct Root handler proof asserts current target, null predecessor and
verbatim `do not place real orders` constraint.

## Full verification

```text
pnpm check PASS
Biome             868 files
Architecture       27 files / 147 tests
Core              293 files / 1649 passed / 3 skipped
Web                31 files / 216 tests
Build              PASS; existing >500KB chunk warning only
```

Skipped tests:

- two historical WorkspaceWork AssignWork CAPA integration tests are explicitly
  superseded by the Root MAC-P1 route and must be replaced by the Root
  conversation approval/rejection black-box test before MAC1-003 closes;
- one existing Windows-conditional P11 resolver test.

## Remaining MAC-P1 work

- Root Conversation exact approval/rejection/resume/restart black-box path;
- LocalPlan move from core Domain vocabulary to cognition/runtime contract;
- common ActionCall facade beyond the current shared output contract;
- typed golden-path consumer/recovery errors;
- Verification/Acceptance end-to-end closure;
- WorkspaceKnowledgeView;
- real-provider G1–G15 qualification and formal phase closure.
