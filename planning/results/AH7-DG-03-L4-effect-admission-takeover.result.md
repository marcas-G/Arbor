# AH7-DG-03 L4 effect-admission takeover qualification

Status: **admission boundary wave PASS; L4 remains OPEN**.

This wave uses a public Work approval only to admit the Work. The tool is the
production `shell` Executor running an allowed append command for which
`requiresApproval` is false. The test asserts the persisted executable intent
has `approval_id = NULL` and no Executable approval row exists; no approval id
is injected. This does not qualify the unconnected approved-Executable
handoff.

## RED and repair

The first production RED at `AH7BeforeEffectAdmission` killed the old daemon
after the P4 intent committed but before `admitEffect`. A second daemon acquired
generation 1. The exact invocation correctly remained `NotAdmitted`, but
ToolRuntime returned `OutcomeUnknown`, AgentLoop marked the action
`ReconciliationPending`, and neither effect nor ToolResult existed. Inspection
showed the existing-replay branch treated every `Reconcilable` /
`NonIdempotent` record as ambiguous without distinguishing `NotAdmitted` from
`MayHaveStarted`.

The minimal repair in `packages/tool-runtime/src/runtime.ts` now applies that
fail-closed branch only after effect admission. A `NotAdmitted` exact invocation
continues through the ordinary fresh authority, stop, full-fence and admission
checks; `MayHaveStarted` remains reconciliation/OutcomeUnknown and never
starts a new Executor call. This matches P4 `02` §2/§8 and P4 `06` §1, which
place the `MayHaveStarted` marker before Sandbox/Executor and define that
marker as the state where the effect may have begun. No design document or
production API contract changed.

## Evidence

- `pnpm --filter @arbor/tool-runtime build`: PASS.
- `pnpm --filter @arbor/single-workspace build`: PASS.
- `pnpm --filter @arbor/web build`: PASS; required because this isolated
  checkout did not yet have `apps/web/dist`. The initial fixture-start timeout
  before this build is a missing build artifact, not a production RED.
- `pnpm exec vitest run packages/tool-runtime/test/p4-pipeline.test.ts`:
  **15/15 PASS**.
- `pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/p4-ah7-effect-admission-takeover.functional.test.ts --testTimeout 180000`:
  **2/2 PASS**, 34.34s total. The real daemon tests use two separate daemon
  processes, freeze old-generation lease renewal, expire generation 0, pause
  generation 1 after lease acquisition, SIGKILL generation 0, then release the
  current worker. The before-admission scenario took 17.230s; the after-
  admission scenario took 16.633s.
- Before-admission kill snapshot: same `ExecutionId`, `ToolInvocationId`,
  `ProviderTurnId`, `callRef` and `LogicalActionId`; generation 0 intent stays
  `NotAdmitted` with no effect or executor-origin result and null executable
  approval. (The earlier query keyed ToolResult by `invocationId`, so it did
  not count later P3 terminal projections that carry only the `callRef`.)
  Generation 1 passes the admission gate, writes exactly one safe shell marker,
  settles Success and converges one ToolResult/Applied action. Work control
  approval stays the exact consumed Control approval; executable approval
  count is zero.
- After-admission-commit kill snapshot: same identities and generation
  takeover; `MayHaveStarted` is durable before the old daemon is killed, but
  the shell marker is absent. Recovery does not invoke the Executor; the
  invocation remains unsettled, the action is `ReconciliationPending`, and the
  Execution is `OutcomeUnknown`. P3 persists one typed unresolved terminal
  ToolResult/Observation projection for that action; there is no executor
  result/effect, and the marker remains absent.
- `node --check`, Biome on touched code, and `git diff --check`: PASS. No full
  suite was run.

## Boundary

The original real-daemon pre/post effect-admission wave covered a no-approval
`Reconcilable` shell call. The follow-up below adds the exact public
Executable-approval precondition for this test path. This evidence does not
qualify an actual external effect followed by settlement crash, old-generation
post-effect fencing, or P4 settlement/Observation/Action-cursor transaction
boundaries. Existing P4 post-effect fencing evidence remains separate and its
current candidate qualification must not be inferred from this result. AH7
remains OPEN.

## Follow-up: public Executable-approval precondition

Candidate `3d197114` failed in the selected full-functional batch at
`tests/functional/process/p4-ah7-effect-admission-takeover.functional.test.ts`
while waiting for the old daemon's `AH7BeforeEffectAdmission` probe directly
after `SteerWork` (`public functional timeout; last=undefined`). That test flow
had admitted the Work and waited for a steer, but shell is separately approval-
gated. Until the exact public Inbox `eap:<approvalId>:<revision>` item is
approved, ToolRuntime returns `ApprovalRequired` before the effect-admission
probe, so the prior wait could not observe the requested boundary. This was a
test precondition gap, not evidence that the lease or effect-admission hook was
skipped after a shell intent.

The qualification now waits for exactly one unconsumed Executable approval in
the root Workspace Inbox, verifies its joined DB binding is the current
WorkEpisode's `shell` action (project/workspace/execution, shell version,
FNV action digest over exact invocation arguments, filesystem target region,
side-effect semantics, and action/call identity), then approves that exact
approval through `ResolveExecutableApproval`. At the AH7 boundary, it verifies
the invocation references this approval, the sole Executable approval is
`Consumed` by the same ToolInvocation, and the original Work Control approval
remains consumed. It also binds old/new fencing generations to the observed
lease probes rather than assuming the resumed, approval-gated Execution is
generation 0.

The first post-approval run exposed two stale test oracles. The original test
assumed the first lease generation remained 0 despite the approval interruption
and reacquisition; it now uses the exact old `AH10AfterLeaseAcquired` probe and
requires the successor to be exactly generation +1. It also expected a
NonIdempotent `MayHaveStarted` invocation to be settled `OutcomeUnknown`. P4/P9
instead require that invocation to remain unsettled absent a reconciliation
fact, while the Execution settles `OutcomeUnknown(ReconciliationRequired)` for
that exact invocation. The test now asserts the exact terminal P3 unresolved
ToolResult/Observation projection (including `OutcomeUnknown`, settlement
disposition, and generic unresolved text), with no executor invocation ID,
artifact, canonical effect, external marker, or second invocation/provider
replay. A terminal P3 projection may be represented in both typed `ToolResult`
and action Observation columns under the same `source_ref`; the assertion
deduplicates that canonical projection instead of counting both storage views
as two results.

Verification after the follow-up:

- `pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/p4-ah7-effect-admission-takeover.functional.test.ts` — PASS, two consecutive full-file rounds, each 3/3 scenarios (~95s each).
- `pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/p38-executable-approval-public.functional.test.ts -t "approves over the public API and resumes the same Execution/AgentLoopStep"` — PASS, 1/1.
- `pnpm typecheck` — PASS (`tsc -b` and `tsc -p tsconfig.test.json`).
- `pnpm lint` — PASS, Biome checked 1177 files.
- `git diff --check` — PASS.

## Review follow-up: subject and control-basis binding

The Executable-approval query now also selects `subject_ref` and
`control_basis_digest`. The qualification joins the exact invocation to its
immutable P39 `RecoveryBindingV1` row, re-canonicalizes and re-digests that
record with the public P39 helpers, and requires the binding's
`controlBasisDigest` to equal the approval row's 64-hex digest. It also requires
the Executable approval `subject_ref` to equal both the frozen binding's
`approvalSubject` and `principalId`; this checks the actual persisted principal
binding for the current Workspace Execution rather than accepting any
non-empty subject string. The canonical binding additionally ties that digest
and subject to this exact execution, invocation, callRef, logical action, and
shell definition.

After these binding assertions:

- `pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/p4-ah7-effect-admission-takeover.functional.test.ts` — PASS, 3/3.
- `pnpm exec tsc -p tsconfig.test.json --noEmit` — PASS.
- Biome on the P4 test and `git diff --check` — PASS.
