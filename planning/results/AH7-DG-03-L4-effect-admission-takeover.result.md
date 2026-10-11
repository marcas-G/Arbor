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
  `NotAdmitted` with no effect, no ToolResult and null executable approval.
  Generation 1 passes the admission gate, writes exactly one safe shell marker,
  settles Success and converges one ToolResult/Applied action. Work control
  approval stays the exact consumed Control approval; executable approval
  count is zero.
- After-admission-commit kill snapshot: same identities and generation
  takeover; `MayHaveStarted` is durable before the old daemon is killed, but
  the shell marker is absent. Recovery does not invoke the Executor; the
  invocation remains unsettled, the action is `ReconciliationPending`, the
  Execution is `OutcomeUnknown`, there is no ToolResult, and the marker remains
  absent.
- `node --check`, Biome on touched code, and `git diff --check`: PASS. No full
  suite was run.

## Boundary

This closes only the real-daemon pre/post effect-admission wave for a no-
approval `Reconcilable` shell call. It does not qualify an actual external
effect followed by settlement crash, old-generation post-effect fencing,
P4 settlement/Observation/Action-cursor transaction boundaries, or
approved-Executable production routing. Existing P4 post-effect fencing
evidence remains separate and its current candidate qualification must not be
inferred from this result. AH7 remains OPEN.
