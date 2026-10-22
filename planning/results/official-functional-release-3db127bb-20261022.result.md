# Official release functional run at `3db127bb`

Date: 2026-10-22 (UTC)

The official release profile was run once on clean `3db127bb56d1fea11da31426041512d5aa124466` with `pnpm test:functional`. The runner completed TypeScript build and Web production build, then stopped in the `functionalVitest` group at the first failing test. No retry was made. The Playwright/browser group did not run, so this is not a release qualification pass.

The first failing case was `P12 startup restores Pending Attention below retention floor and clears it after exact replay` in `tests/functional/process/f21-open3-activation-recovery.functional.test.ts`. It failed with `Error: database is locked` at test line 998. The runner skipped the subsequent case in that file and exited with code 1.

Nine complete Vitest files passed before the failure:

- `ah19-provider-native-binding-recovery.functional.test.ts`
- `agent-action-ah7-reconcilable.functional.test.ts`
- `agent-loop-ah10-direct-child-assign-work-receipt-binding.functional.test.ts`
- `agent-loop-ah10-send-message-takeover.functional.test.ts`
- `agent-loop-ah10-generation-takeover.functional.test.ts`
- `p38-executable-approval-public.functional.test.ts`
- `ah18-overflow-linked-compaction-resume.functional.test.ts`
- `p4-ah7-live-lease-acquisition.functional.test.ts`
- `agent-loop-ah10-select-current-work-takeover.functional.test.ts`

The release runner summary reports 62 selected files, 56 files in the functional Vitest group, 140 passed tests, one failed test, and exit code 1. Full machine-readable evidence is retained in the ignored run directory:
`.test-results/2026-10-22T20-34-55-134Z-8644/` (`summary.md`, `functionalVitest.json`, and `result-manifest.json`; runner PID 8644).

Release checkpoint: **NOT QUALIFIED** at `3db127bb`. The first failure is preserved as evidence; do not infer coverage of the remaining Vitest files or any browser journey from the nine completed files. No production source or frozen design document changed in this run.
