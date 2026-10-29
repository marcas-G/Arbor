# SCRC-006 — Summary Compaction Coordinator

## Source

- SD v1.4 §5.6; DID v1.22 §8.13/§9.10; P2/P3 compaction contracts; T19–T22

## Depends On

- SCRC-005

## Objective

Implement explicit Summary Compaction ProviderTurn, structured rolling
checkpoint, token-bounded recent frontier, atomic checkpoint/epoch commit,
fresh control reinjection and same-AgentLoopStep resume.

## Outputs

- CompactionCoordinator Summary path;
- versioned compaction request/result validation and prompt/eval updates;
- Session checkpoint/epoch integration;
- removal of `NeedsCompaction → CompactionRequired` settlement;
- `scrc-summary-compaction` suite.

## Must Hold

- incomplete compact leaves old epoch active; completed compact is atomic;
- same logical step/repair identity survives; completed effects do not replay;
- summary preserves objective/requirements/decisions/progress/blockers/next refs;
- fixed mandatory overflow returns ContextUnsatisfiable without compaction loop.

## Must Not Decide

- No ProviderNative endpoint, new Work/settlement state or permission persistence.

## Acceptance

- T19–T22 pass including both sides of checkpoint/epoch fault injection.

## Verification

```bash
pnpm test scrc-summary-compaction
pnpm test p3-provider-failure-repair
pnpm test p17-agent-loop-step
```
