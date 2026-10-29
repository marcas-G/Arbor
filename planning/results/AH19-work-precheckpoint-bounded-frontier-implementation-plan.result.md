# AH19 Work Pre-Checkpoint Bounded Frontier — Implementation Plan Result

Status: **Fixed planning package prepared; implementation and qualification are not authorized or performed.**

## Provenance

- Preparation baseline HEAD: `58aae35b08738019749ba5bba17a26f564f0cd57`.
- Governing design: System Design v1.18 / DID v1.50.
- Accepted governance token: `ACCEPT_AH19_WORK_PRECHECKPOINT_BOUNDED_FRONTIER_V1`.
- Accepted proposal raw SHA-256:
  `4692895A2C9CF92DB1308507F29ED288FD3149F944AAC4F3D8BAE23635F5D663`.
- Independent post-landing review: Blocking = 0.
- Fixed plan: `planning/proposals/AH19-work-precheckpoint-bounded-frontier-implementation-plan.md`.
- Fixed plan raw SHA-256:
  `C4A0775DA83AE9623D46639E760A4A45E372B5A380AF44B5FE699E068D374957`.
- Requested, not yet granted, implementation token:
  `AUTHORIZE_AH19_WORK_PRECHECKPOINT_BOUNDED_FRONTIER_IMPLEMENTATION`.

## Current-code evidence and fixed scope

`packages/model-context/src/projector.ts` defines the 64-row context limit.
`adapters/persistence-sqlite/src/session-repository.ts` selects the latest
bounded rows before a checkpoint, but the pre-checkpoint `listRecentEntries`
path can expand backward to close ToolCall/ToolResult causality. The Work plan
requires a narrow Work frontier selection that does not exceed the frozen
latest-64 window; existing P3 causal blocking remains fail-closed. The
post-checkpoint checkpoint-plus-all-later-entries behavior is preserved.
Canonical C0/C1 pinned source/revision fragments and current user input remain
independent of that row window.

The fixed qualification matrix covers exact 64-row selection/no refill,
separately bound pinned facts on each request, a post-checkpoint frontier over
64 rows, a filtered row through real compaction and restart, pre-checkpoint
restart consistency, and the exact causal-gate result when an older ToolCall
is not backfilled: `Blocked/ContradictoryTimeline`, the orphaned `callRef`, and
`closedFrontier` with nullable `firstSequence` / `lastSequence` ending strictly
before the contradictory ToolResult. No alternate result is permitted.

## Verification and boundary

- Whitespace-only `git diff --no-index --check -- /dev/null <plan>` reported no
  whitespace errors. Exit 1 is expected because the plan is new; Git emitted
  only the LF-to-CRLF normalization advisory.
- No tests, builds, migrations, or database operations were run.
- No design, production, test, or migration file was changed for this plan.
  No file was staged or committed.
- The requested token is a separate gate; no implementation work may start
  under this plan alone. No migration is required for Work.
- Independent review correction: causal-boundary case 6 is pinned to the
  current `decideSessionProjection` result shape and its precise orphaned
  ToolResult outcome; `Ready` or alternative projection outcomes are excluded.
