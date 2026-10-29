# F23 F07 / AH8 public Work seed

## Scope and baseline

Worktree: `C:\Users\ThinkPad\.codex\worktrees\f23-fixture-app\Arbor`

Baseline: `2c0a92ba6dc5a0f17ed6bee45a83033857273f84`, clean and detached.
Source AH7 public-seed commit `6c88a2ae87ffaf76bcc68cb7333100290ed29af5` was
confirmed patch-equivalent in `C:\Arbor` (`git cherry` marked it `-`). Only
`human-steer.functional.test.ts`,
`agent-loop-ah8-action-b-stale-after-restart.functional.test.ts`, and this
result record are changed. No production code, design docs, or shared
`production-fixture.ts` was changed.

Both fixtures now use the public path: Root `SubmitHumanMessage` → Root Agent
`assign_work` → exact CAPA approval from Governance Inbox → public
`ResolveControlApproval` → Open `current-work`. The fake provider identifies
Root seed calls by the Root-only `assign_work` surface and identifies Work
Provider turns separately by Work tools. No direct `/commands` AssignWork is
used.

F07 verifies the Work is Open at revision 0, receives a legal Manual wait turn
without steer guidance, and has no active execution before public `SteerWork`.
The public steer advances revision 0→1, and a later Work-tool Provider call
contains the exact guidance marker; the fixture separately counts Work turns
so the Root seed ProviderTurn cannot satisfy the assertion.

AH8 keeps the first Work Provider turn outside the probe by returning a legal
Manual wait, not an HTTP failure or ToolCall. It waits for public Work to be
idle, snapshots the seed executions and verifies none is Failed, then installs
the crash-child probe and uses public `SteerWork` revision 0→1 to start the
measured A/B batch. The hit ExecutionId must not exist in the seed snapshot.
The original measured path remains: Action A (`update_plan`) commits under the
hit ProviderTurn, the public post-A steer advances revision 1→2, and stale B
is persisted as `SkippedStale` with `DecisionStale`; Work count stays one and
the final Work revision is 2. Durable step/action checks are scoped to the
measured ExecutionId so Root seed facts cannot satisfy them. The provider-call
limit counts only measured Work-tool calls after the probe start.

## RED / verification

- Before migration, focused F07 and AH8 runs each failed at the original
  external `/commands` AssignWork setup with HTTP 403
  `authority/denied` / `UnsupportedOrigin:AssignWork`.
- Revised F07 focused run: 1/1 PASS.
- Revised AH8 focused run: 1/1 PASS, including the seed snapshot/non-Failed
  and distinct probe ExecutionId assertions, A Applied, B SkippedStale, and
  post-restart Work/provider assertions.
- Biome on both changed tests: PASS.
- `pnpm typecheck`: PASS.
- Full functional suite and `pnpm check` were not run.

No unresolved contract gap was found. No unsafe provider failure was injected
to bridge the seed and probe phases.
