# P38 Browser Approval — TrustedLocal UI Qualification (2026-10-23)

Status: **TARGETED PASS — TrustedLocal-only P38 Queue UI case; not OS sandbox qualification**.

## Final run

- Source SHA: `f68d1efc978ced735608d9118a12208269936e36`.
- Run directory: `.test-results/p38-trusted-local-gated-20261023T105139632Z/`.
- Playwright JSON: `.test-results/p38-trusted-local-gated-20261023T105139632Z/playwright.json`.
- Case: `P38 browser approval resumes the same action under explicitly configured TrustedLocal P11 policy`.
- Runner: Playwright `list,json`, one worker, retry 0; 1 test passed (28.4 s; 54.5 s runner total).
- `pnpm --filter @arbor/web typecheck`, targeted Biome, and `git diff --check` passed at the UI change checkpoint. No daemon/full release suite was run after this targeted case.

The test uses the real browser Queue form and asserts the exact
`ResolveExecutableApproval` request and committed `Approved` receipt, then
checks that the same approval-bound P3 Action/P4 invocation/P39 binding reaches
one `Success` and the shell effect occurs exactly once. The fixture explicitly
creates the TrustedLocal authority source and P11 GitWorktree, grants the
execution-bound `DecideSandboxPolicy` permission, and commits the existing
TrustedLocal FullAccess P1 policy before the browser approval. The test title
and assertion name this precondition. It makes no claim that an OS-enforced
provider is available or supported.

## Prior failure evidence retained

- The original six-file desktop run at `0dd2742136feece736688844f4c819a825ce1d40` had 9/10 passing cases. P38's browser approval command itself returned `Committed/Approved`; the subsequent effect counter remained 0. Its retained trace and screenshot are under `.test-results/2026-10-23T10-10-28Z-0dd274-ui-desktop/`.
- The first diagnostic re-run showed the exact approval consumed and a `Bound` P39 invocation left `NotAdmitted`, with the original Action still Pending and no Observation/ToolResult/P50 unavailable fact. The execution had no sandbox-policy decision or configured P11 authority source. This is the existing `SandboxPolicyRequiredInterruption` path: P4 parks the same action before effect admission. It was not an approval rejection, `SandboxProviderUnavailable/ExpectedFailure`, or a production scheduler defect. The fully archived database and diagnostic record are under `.test-results/p38-browser-20261023T103215853Z/p38-browser-approval-23b64954-ea14-4d6b-994e-ba30f0526e15/`.
- A follow-up attempt with the P11 source initially failed before the Work approval: the dedicated V2 daemon child defaults to a 60-second tick. The existing positive P38 process fixture sets `ARBOR_TICK_INTERVAL_MS=25` for this TrustedLocal setup. The isolated fixture was aligned with that existing test precondition; the failed run remains archived under `.test-results/p38-trusted-local-20261023T104545673Z/p38-browser-approval-2e8ff908-a42a-4d6b-994e-ba30f0526e15/`.

These runs are segmented evidence, not a same-SHA six-file UI sweep, P38 closure,
or release qualification. No design or production behavior was changed.
