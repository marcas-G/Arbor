# Functional Test Wave 2 Result

**Date:** 2026-10-04
**Status:** F10–F20 COMPLETE / F21 BLOCKED BY DESIGN GAP

## New functional coverage

```text
F10 approval rejection             PASS
F11 transient provider recovery    PASS
F12 Verification Fail              PASS
F13 Verification Unknown           PASS
F14 browser exact approval         PASS
F15 browser PASS acceptance        PASS
F16 crash/restart answer dedup      PASS
F17 third transcript page          PASS
F18 child result parent acceptance PASS
F19 Artifact/Deliverable/Dependency PASS
F20 clean committed checkout       PASS
```

## Product defects found and fixed

1. Child PASS only woke the child Workspace. The unified signal consumer now
   admits one exact parent Inbox item and wake.
2. There was no production admission path for `InboxEpisode`. Idle wake
   processing now admits only agent-eligible Message/SpecialistSettled input;
   HumanConversation and Governance remain excluded.
3. WorkspaceInput had no normal text-only settlement and looped to the turn
   ceiling. It now settles as `InboxInputHandled(entryKey)`.
4. `ArtifactServiceLive` was not composed and ToolRuntime successes exposed no
   Artifact ref. Successful observations now become valid, idempotent
   `art_<uuid-v7>` records.
5. OpenAI-compatible lowering dropped ToolResult artifact refs and
   ControlResult canonical refs. It now preserves them in bounded structured
   suffixes.
6. The cross-Work test was renamed from ambiguous “coordination” terminology
   to `cross-work-delivery`.

## Batch evidence

```text
pnpm test:functional
  public-process tests  13 / 13 PASS
  Playwright tests       2 / 2 PASS
  retries                0
```

## Remaining

F21 is governed by
`planning/gaps/FT-DG-01-ui-project-resource-boundary.md`.
