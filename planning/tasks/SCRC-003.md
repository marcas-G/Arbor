# SCRC-003 — Steer / Queue Safe-Boundary Input Drain

## Source

- SD v1.4 §7.4–§7.5; DID v1.22 §8.2; P3 `02` §1, `03` §2; T10–T12

## Depends On

- SCRC-002

## Objective

Replace every-turn `listUnconsumed` prompt assembly with a durable input drain:
Steer promotes at the next safe sampling boundary; Queue promotes FIFO only
when the current drain would end, one item before continuation re-evaluation.

## Outputs

- safe-boundary input queue/drain module;
- Agent driver integration;
- removal/deprecation of `InboxContextAssembler` production path;
- `scrc-input-promotion` ordering/retry tests.

## Must Hold

- one entryKey → one Session Input across provider repair/retry/restart;
- ordinary queue input does not preempt; Stop/Critical Steer quiescence wins;
- source trust remains DataOnly unless canonical Runtime says otherwise.

## Must Not Decide

- No Inbox business kind/lifecycle change, UI behavior or scheduler redesign.

## Acceptance

- T10–T12 pass; production driver contains no per-turn bulk Inbox injection.

## Verification

```bash
pnpm test scrc-input-promotion
pnpm test p10-inbox-view
pnpm test p14-conversation
```
