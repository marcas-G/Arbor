# Sandbox Policy V6 Fresh Work Diagnostic — 2026-10-23

Status: **DIAGNOSTIC RUN FAILED BEFORE THE FRESH WORK BRANCH; P9 TEST RACE IDENTIFIED; FRESH EAP TIMEOUT ROOT CAUSE STILL OPEN**

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
  matching P4 probe before choosing that branch.
- This run did not reach the new fresh-project/EAP section, so it does not
  explain the earlier fresh `waitForExecutableApproval` timeout. That earlier
  run retained no provider request capture or runtime database. The new
  instrumentation is set to preserve those facts if a scheduled run reaches
  that section.

The run and synthetic D2 source do not qualify any real or `OSSupported`
provider. No production or design file changed.

## Verification

- Diagnostic full-file run: **FAIL** at the P9 state/probe race above; it is
  not a fresh-work drift qualification.
- `pnpm build` and `pnpm --filter @arbor/web build`: PASS at merged `46d811b7`
  before the test-only diagnostic patch; these built dist files were used by
  the diagnostic run.
- Targeted Biome and `git diff --check` after the test-poll correction: PASS.
- No run was performed after the correction.

