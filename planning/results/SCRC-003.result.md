# SCRC-003 — Steer / Queue Safe-Boundary Input Drain Result

## Status

**COMPLETE / VERIFIED — 2026-10-01.**

## Delivered

- Added deterministic safe-boundary selection: every HumanInput is Steer;
  continuation admits no Queue; fresh drain admits exactly one FIFO Queue.
- Wired production AgentLoopDriver to InputPromotionService before sampling.
- Production composition supplies the promotion service; legacy test layers
  without it retain the bounded compatibility path.
- Promoted typed UserMessage entries enter Session context; P14
  HumanConversation summaries are retained but skipped by the compatibility
  assembler because the exact claimed human body is already supplied.
- Provider repair/retry and later continuation cannot re-inject a consumed
  Inbox source.

## Evidence

```text
Focused: 4 files / 23 tests passed
Architecture: 20 files / 121 tests passed
Root: 256 files / 1505 passed / 1 skipped
Web: 31 files / 211 tests passed
pnpm check: PASS
git diff --check: PASS
```

T10–T12 are covered by `scrc-safe-input-drain` plus the transactional promotion
suite. No Scheduler, Inbox kind, Work or quiescence semantics changed.

Next task: **SCRC-004 — Tool / Control Timeline Closure**.
