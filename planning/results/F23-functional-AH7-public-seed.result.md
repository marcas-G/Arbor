# F23 AH7 functional public seed

## Scope and baseline

Worktree: `C:\Users\ThinkPad\.codex\worktrees\f23-fixture-app\Arbor`

Baseline: `03fe99750fe88edb4b12c1f49e62fff62111c1fa`, detached and clean.
The prior app fixture commits `4eb28f7`, `45a6989`, and `4033860` are
patch-equivalent in `C:\Arbor` (`git cherry` marked each `-`). Only the AH7
functional test and this result record are changed; no production code,
design document, shared tree, or unrelated functional test was edited.

## Change

The old test seeded Work by calling external `/commands` with `AssignWork`;
that correctly receives HTTP 403 `authority/denied` /
`UnsupportedOrigin:AssignWork` under the accepted origin policy. The replacement
uses the public process path:

`SubmitHumanMessage` → Root Agent `assign_work` → exact Governance Inbox
approval → public `ResolveControlApproval` → public `current-work` Open Work.

Only after confirming the public Work exists does the test kill the ordinary
daemon and restart with the selected AH7 crash-probe boundary. Thus the seed
conversation/control action runs without the crash hook. If the ordinary
daemon starts the new Work before it is killed, the fake provider returns HTTP
503 before any ToolCall/P4 effect; after restart it permits the measured `read`
ToolCall. The provider fake distinguishes Root seed calls (assign_work, no
read) from the measured Work call (read available).

The pre-crash and recovered ledgers are filtered to the probed ExecutionId;
ToolResults are matched by exact callRef and Artifacts by invocationId. This
keeps the public seed conversation/trace from masking or satisfying AH7
assertions. Existing crash-state, action-state, ToolInvocation, ToolResult,
Artifact, provider-turn, one pre-effect provider call, and no-daemon-error
assertions remain. The recovery assertion additionally proves that when a
ToolInvocation existed before the crash, its exact `invocation_id` is unchanged
after recovery.

## RED / verification

- Initial focused run, after building this worktree's missing generated
  `apps/web/dist`, reproduced the expected RED at external AssignWork:
  HTTP 403 `UnsupportedOrigin:AssignWork`.
- The revised public seed passed all four crash boundaries:
  `AH7AfterActionIntentCommit`, `AH7AfterToolIntentCommit`,
  `AH7AfterToolSettlementCommit`, and `AH7AfterActionResultCommit`.
- After adding the exact recovered ToolInvocationId equality assertion, the
  affected three cases passed again: 3/3; the unchanged ActionIntent case had
  already passed 1/1. The complete four-boundary file had also passed 4/4
  before that assertion-only strengthening.
- `pnpm typecheck`: PASS.
- Biome on the changed test: PASS.
- `pnpm build` and `pnpm --filter @arbor/web build` were used only to prepare
  this isolated worktree's generated daemon/Web test artifacts; both passed.
- Full functional suite and `pnpm check` were not run.

No unresolved design semantic was discovered. The generated artifacts are
ignored build output, not committed task files.
