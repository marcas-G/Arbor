# Submitted DecisionEpisode closure requalification — 2026-10-24

Tested source: `eece5de33dfed3af631ab4da10d45e3a74fff1f2`.

Status: **PASS for the accepted P41 Submitted DecisionEpisode mismatch
disposition.** This is not a full release qualification.

The accepted P41 contract already supersedes the historical orphan-state RED:
an exact Workspace or Manifest mismatch writes one immutable P9 fact/event,
projects one path-safe `SubmittedDecisionBindingFailure` ActionRequired row,
replays no Provider or SelectCurrentWork effect, and permits only the accepted
fact-first authorized Stop close. The old pending reproduction remains
historical evidence and is not a current unresolved semantics choice.

Command, one worker and zero retry:

```text
pnpm exec vitest run --config vitest.functional.config.ts --no-file-parallelism --maxWorkers=1 --retry=0 tests/functional/process/agent-loop-ah10-submitted-decision-binding-takeover.functional.test.ts
```

Result: **1 file / 4 tests PASS** in 225.01 seconds. Workspace and Manifest
mismatch each passed on both sides of the P9 fact transaction commit. No real
Provider, Native sandbox or preserved database was used.

This result closes the stale RC board item for the accepted P41 scope. Full
release gates and unrelated recovery boundaries remain separate.
