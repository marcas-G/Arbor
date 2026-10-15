# AH7 Reconcilable shell recovery with public Executable approval

Date: 2026-10-16
Base candidate: `ecb0d93e14c046d990601807eb17cc2ecd057c72`
Scope: test/support only; no production or design changes.

## Public approval precondition

All three scenarios in `tests/functional/process/agent-action-ah7-reconcilable.functional.test.ts`
now select the sole exact `eap:<approvalId>:<revision>` entry from the root
Workspace's public Inbox after SteerWork. The test verifies that this EAP is
distinct from the already-approved Work Control approval and that the durable
Executable binding names the exact project/workspace, `WorkEpisode`/Work id
and revision, `shell` tool/version, `Reconcilable` or `NonIdempotent` semantics,
action/call/ToolInvocation identities, exact arguments/input hash, and nonempty
resource-space target. Only after those checks does the test publicly approve
the EAP and wait for the selected P4 intent/effect probe.

The shared public-client helper requires exactly one pending Executable Inbox
entry; the P38 approval setup uses the same selector. After recovery, the test
asserts the original invocation's `approval_id`, exactly one matching consumed
approval, exact Work/action/provider identity, no duplicate invocation, and the
original effect/reconciliation outcome.

The NonIdempotent `MayHaveStarted` case's prior oracle incorrectly required the
P4 invocation itself to settle `OutcomeUnknown`. The frozen P4/P9 contract
keeps that ambiguous invocation unsettled and carries the exact
`OutcomeUnknown(ReconciliationRequired([invocationId]))` on Execution. The test
now proves that form, a single typed P3 `OutcomeUnknown` ToolResult/Observation
with no executor/canonical result or Artifact refs, exactly one external
marker, and no second provider/executor attempt. Reconcilable behavior is
unchanged.

## Verification

- AH7 Reconcilable file, first complete run — PASS, 3/3.
- AH7 Reconcilable file, second consecutive complete run — PASS, 3/3.
- `tests/functional/process/p4-ah7-effect-admission-takeover.functional.test.ts` — PASS, 3/3 (one run).
- P38 public approval Approve representative, filtered to
  `approves over the public API and resumes the same Execution/AgentLoopStep` —
  PASS, 1/1; the five other tests were intentionally filtered/skipped.
- `pnpm typecheck` — PASS.
- Targeted Biome and `git diff --check` — PASS.
- No full functional suite was run.
