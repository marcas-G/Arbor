# P11 — 13 P8 Verdict Consumer Integration (GQ4)

**Authority:** GQ4 裁决; P8 `01` §1/`04` §3 (binding rules frozen); P8 result notes.
**Status:** DRAFT.

## 1. Unchanged bindings

`targetEnvironmentRevision` (executable missions — from the anchor counter, which now truly moves), `observedEnvironmentRevision` on evidence, artifact-version binding — all consume exactly as P8 froze.

## 2. Stale overlay (new consumption, non-mutating)

The P8 verdict query surfaces gain the derived Freshness overlay (`07`); re-verify flows through normal StartVerification (new identity; one-Open-per-(workId, targetWorkRevision) honored (P8-frozen scope) — an Open verification on the same revision must conclude first, Unknown(Orphaned) available as the explicit path).

## (mapping: CI-5, CI-2)
