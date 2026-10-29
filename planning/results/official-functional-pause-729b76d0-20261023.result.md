# Official release functional pause at `729b76d0`

Date: 2026-10-23 (UTC)

The official release profile was started once from clean
`729b76d0fafd5c76f00808fce3edd647c912e0b7` with `pnpm test:functional`.
The root TypeScript build and Web production build passed; Vite printed its
existing large-chunk warning. The release runner selected 62 files, including
56 Vitest files. No tests were run concurrently with this command.

This run was deliberately paused before the full release suite completed.
The Vitest progress record contains 42 passed case entries in
`tests/functional/process/ah19-provider-native-binding-recovery.functional.test.ts`.
The next recorded case,
`AH19 restart binding qualification > fails closed when the P20 source link has a mismatched predecessor`,
was marked `running` when the runner stopped. The file did not complete. No
other Vitest file started, and the Playwright/browser group did not run.

The stop was requested immediately after the previous case reported passed,
but Vitest had already started the predecessor case. The runner exited with
code 1 after interruption. This exit is neither an assertion failure nor a
successful qualification result. Do not infer a full AH19 file pass or release
pass from the 42 completed cases. The next qualification attempt must rerun the
interrupted case and the complete official `pnpm test:functional` suite from a
fresh clean checkpoint.

Run ID: `2026-10-23T05-09-27-743Z-15700`. The ignored evidence is retained in
`.test-results/2026-10-23T05-09-27-743Z-15700/`, including the Vitest log,
progress JSON/Markdown, summary, and result manifest. The manifest was still in
`running` state at interruption and does not contain a final aggregate result.

The interrupted run left `.arbor-functional-schema44-lJnshd/` in the workspace.
Its plain directory tree and files were verified read-only and moved intact to
`C:\Users\ThinkPad\AppData\Local\Temp\arbor-functional-schema44-lJnshd-20261023-0540`.
Process inspection found no test-runner, daemon, or other non-Codex Node process
associated with this worktree after the stop. No production or design files
were changed by this qualification run.

Release checkpoint: **NOT QUALIFIED — PAUSED WITH INCOMPLETE EVIDENCE** at
`729b76d0`. The full release functional requirement remains open.
