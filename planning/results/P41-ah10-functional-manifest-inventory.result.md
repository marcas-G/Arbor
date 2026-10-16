# P41/AH10 functional manifest inventory addendum

Date: 2026-10-16

The real-process Submitted DecisionEpisode binding/takeover test is now in the
checked `functionalVitest` release inventory and the curated `crashSentinels`
group, ordered between the AH9 terminal-action recovery and AH11 step-effects
crash qualification. The functional Vitest inventory is 49 files; UI remains 6.
The release profile continues to select the full functional Vitest and UI sets.

The first manifest run exposed one additional fixed selected-file count in the
runner startup test (54 → 55); that assertion and the current testing README
inventory count were updated. The manifest validator still derives exact file
coverage from the configured Vitest/Playwright patterns; no functional test was
run as part of this inventory change.

## Verification

- `pnpm test:manifest` — **PASS**.
- Biome on the changed JSON/JavaScript/Markdown files — **PASS**.
- `git diff --check` — **PASS**.

No production or frozen design files changed.
