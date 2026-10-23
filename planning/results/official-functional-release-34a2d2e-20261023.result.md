# Official release functional run at `34a2d2e`

Date: 2026-10-23 (UTC)

The official release profile was run once on clean `34a2d2ecc89d7245e179d6f1f5a064e2a43589ed` with `pnpm test:functional`. The TypeScript build and Web production build completed; Vite emitted the existing large-chunk warning. The runner stopped in `functionalVitest` at its first failing test. No retry was made. The Playwright/browser group did not run, so this is not a release qualification pass.

The first failing case was `AH10/P10 Attention materialization > fails closed when P9 event envelope field event_version conflicts with its fact` in `tests/functional/process/ah10-p10-attention-materialization.functional.test.ts`. It failed after 25 ms with a `PersistenceCorruption` from `DomainEventJournal` / `read-event-version-pair`: `stored event type/version pair is not registered`. The remaining cases in that file were skipped, and the runner exited with code 1.

Eleven complete Vitest files passed before the failure:

- `ah19-provider-native-binding-recovery.functional.test.ts`
- `agent-action-ah7-reconcilable.functional.test.ts`
- `agent-loop-ah10-direct-child-assign-work-receipt-binding.functional.test.ts`
- `agent-loop-ah10-send-message-takeover.functional.test.ts`
- `agent-loop-ah10-generation-takeover.functional.test.ts`
- `p38-executable-approval-public.functional.test.ts`
- `ah18-overflow-linked-compaction-resume.functional.test.ts`
- `p4-ah7-live-lease-acquisition.functional.test.ts`
- `agent-loop-ah10-select-current-work-takeover.functional.test.ts`
- `f21-open3-activation-recovery.functional.test.ts` (**7/7**, including the quiescent trigger-removal restart seam)
- `p37-delivermessage-process-crash.functional.test.ts`

The release runner summary reports 62 selected files, 56 files in the functional Vitest group, 158 passed tests, one failed test, and exit code 1. Full machine-readable evidence is retained in the ignored run directory:
`.test-results/2026-10-22T22-30-05-073Z-23972/` (`summary.md`, `functionalVitest.json`, and `result-manifest.json`; runner PID 23972).

Release checkpoint: **NOT QUALIFIED** at `34a2d2e`. The first failure is preserved as evidence; do not infer coverage of the remaining Vitest files or any browser journey from the eleven completed files. No production source or frozen design document changed in this run.
