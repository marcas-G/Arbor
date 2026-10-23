# Sandbox Policy V6 Fresh Work Diagnostic — 2026-10-23

Status: **DIAGNOSTIC RUN REACHED FRESH WORK; EAP TIMEOUT ROOT CAUSE IDENTIFIED AS FIXTURE PROFILE/OWNERSHIP MISMATCH; POST-FIX FULL RUN NOT RUN**

## Run and retained evidence

At merged source `46d811b7` plus isolated test instrumentation, production and
Web dist were built once. One full-file Vitest run was executed with retry 0.
It failed after 72.71 seconds at the existing assertion for the first
Execution's `P4ExecutableToolRuntimeOutcome(ExpectedFailure)` event. The
failure fixture and SQLite database were archived through the existing helper:

`.test-results/2026-10-23T18-05-v6-fresh-work-diagnostic/sandbox-policy-v6-fresh-work-8f570caa-57b3-4725-9ece-f88eebd742d3`

## What the run established

- The actual provider requests showed the expected routing for the primary
  journey. Request 1 exposed RootConversation tools and selected `assign_work`.
  Request 2 remained RootConversation, contained the exact `WorkAssigned(`
  tool result, and correctly selected the scripted fallback text. Request 3
  exposed WorkspaceWork tools including `shell`, `wait`, `claim_completion`
  and `assign_work`; the marker was present and the fake provider selected
  `workspace-shell`. The BaseLoop v2 wait/claim wording did not misroute this
  Work request. The proposed full-text keyword-routing cause is not supported
  for the observed requests.
- The first P4 invocation settled as `ExpectedFailure`. Its matching
  `P4ExecutableToolRuntimeOutcome` probe was in the retained daemon output and
  database state was P9 terminal: Action `TerminalRejected`, Step
  `StepEffectsCommitted`, invocation settlement `ExpectedFailure`, and the
  exact `ProviderVersionMismatch` unavailable disposition. The assertion ran
  before the probe reached the test's stdout callback and before the same
  durable snapshot had advanced from invocation settlement to the Action/Step
  terminal state. The existing poll predicate waited only for invocation
  settlement, so it could enter the nonterminal branch on a partial P4/P3
  transition. The test now waits for the settled Action/Step pair and the
  matching P4 probe before choosing that branch. Independent review found that
  this still read the latest Step, which could be a legal successor. The
  current oracle instead takes invocation, Actions and Steps in one read
  transaction and selects the exact source Action/Step from the P4 probe's
  recovery-binding identity. The source Step accepts `StepEffectsCommitted`,
  `NextStepReady`, or `SettlementProposed`; a successor cannot replace it.
  Only an exact P4 `ExpectedFailure` whose stored observation includes
  `sandboxProviderUnavailable`, whose same Action is `TerminalRejected`, and
  whose same source Step is in a legal post-action state is classified as the
  P9 unavailable terminal. A generic `ExpectedFailure` with an Applied Action
  remains nonterminal.
- A later single full-file run reached the fresh EAP wait and retained the
  public views, exact Execution/Step/Action/approval/invocation snapshot, and
  provider route trace. The fresh Workspace had no active `resource_ownership`
  claim; the only active filesystem claim belonged to the original Workspace
  at the base Profile root. The test had selected that same host Profile for a
  second project but manually inserted a nested `GitWorktree` path. P4 resolved
  the shell region to that nested path and correctly returned
  `ResourceAdmissionDenied` before creating an Executable approval. The
  public Inbox therefore contained only the still-unconsumed HumanConversation
  and no `eap:` entry. The earlier fresh `waitForExecutableApproval` timeout
  had the same lack of retained DB/request evidence, but this later run now
  provides the matching concrete failure mode.
- The scripted provider then returned `shell` again on every WorkspaceWork
  request despite the preceding exact `[Denied] tool denied:` result. That
  produced 22 repeated no-effect denial Actions/Steps and ended in
  `SessionContextBlocked:ContradictoryTimeline`. The test now stops selecting
  another shell action after a prior exact tool denial, so a future diagnostic
  failure remains bounded and attributable to the first denied action.
- The fixture now creates a distinct fresh Project root, restarts the daemon
  with that path as the host Profile root before public CreateProject, and
  gives the Project its primary GitWorktree at the same path. The later
  registry-drift restart keeps that Profile root. The failure snapshot's
  transcript request omitted required `limit` and returned 400; it now sends
  `limit: 40` so `responseStatus` can be captured on a future EAP failure.

The run and synthetic D2 source do not qualify any real or `OSSupported`
provider. No production or design file changed.

## Verification

- Initial diagnostic full-file run: **FAIL** at the P9 state/probe race above;
  it did not reach the fresh Work branch.
- `pnpm build` and `pnpm --filter @arbor/web build`: PASS at merged `46d811b7`
  before the test-only diagnostic patch; these built dist files were used by
  the diagnostic run.
- Targeted Biome and `git diff --check` after the test-poll correction: PASS.
- Small oracle unit tests after the identity-bound correction: PASS, 2/2. One
  simulates the source Step already at `NextStepReady` with a newer `Prepared`
  successor; the other ensures a generic ExpectedFailure is not classified as
  the P9 unavailable terminal.
- Fresh-work full-file run: **2 oracle tests passed, process case failed** at
  `waitForExecutableApproval` after P4 `ResourceAdmissionDenied`; it is not a
  V6-E drift/reapproval qualification.
- After correcting the fixture Profile root, the full functional file was not
  rerun under the one-run limit.

