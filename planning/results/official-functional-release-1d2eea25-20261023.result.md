# Official release functional run at `1d2eea25`

Date: 2026-10-23 (UTC)

The official release profile was run once from clean
`1d2eea25ba4de64a86fd2ef11225ffe792796b0c` with `pnpm test:functional`.
The production TypeScript build and Web build passed. The runner stopped at
the first Vitest failure under `--bail=1`; no retry was made. The Playwright
group did not run. This run is **not a release qualification pass**.

Run ID: `2026-10-23T00-42-23-690Z-23572`. The runner's ignored machine
evidence is in `.test-results/2026-10-23T00-42-23-690Z-23572/`, including
`summary.md`, `functionalVitest.json`, `functionalVitest-progress.md`,
`result-manifest.json`, and the Vitest log. The manifest records
`gitDirty: false`, release profile, 62 selected files, build exit 0, and
functional Vitest exit 1 after 7,016,270 ms: 167 passed, 1 failed. Coverage is
incomplete. Remaining Vitest cases and all six browser files were not
qualified by this run.

The first failure was:

`P4 AH7 effect-admission generation takeover > fences Reconcilable recovery at AH7BeforeEffectAdmission`

The assertion failed at
`tests/functional/process/p4-ah7-effect-admission-takeover.functional.test.ts:705:34`.
It compared the persisted Executable approval row with the expected exact root
Workspace binding after the `AH7BeforeEffectAdmission` boundary. The retained
report says the actual object did not match the expected object and notes 14
matching properties; it does not include the differing field values. Two
following cases were skipped by bail-on-first-failure:

- `fences Reconcilable recovery at AH7AfterEffectAdmissionCommit`
- `fences NonIdempotent recovery at AH7AfterEffectAdmissionCommit`

No production or design files were changed by this qualification run. Do not
infer a pass for the unexecuted Vitest remainder or browser group.
