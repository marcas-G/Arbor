# S2 Producer Verification Wait Eligibility — Implementation Result

Date: 2026-10-24  
Status: **SCOPED IMPLEMENTATION PASS; no real-provider/daemon qualification claim**  
Design Gap candidate: `S2-WDG-01`  
Implementation commit: `e8c9eb9d2006bed868a0c3d1f42c80dd1410c54b`  
Cursor-assertion commit: `fb08e8b5658ad6310eb610843bbaa1a988c33ec3`
Separate real terminal evidence: [`S2-real-immediate-stop-terminal-self-wait.result.md`](S2-real-immediate-stop-terminal-self-wait.result.md)

## Frozen-contract basis and disposition

The S2 immediate-stop real attempt persisted a WorkEpisode Yielded on
`VerificationChanged` for its exact current Work/revision, although no file
effect, Open Verification, or CompletionClaim source existed. Frozen P2 DID
§8.16 / P2 `05` define Yield as durable waiting on a condition and own
lost-wake protection. Frozen P8 DID v1.58 / P8 `03` define the producer source:
`CompletionClaimed` drives the deterministic StartVerification consumer, and
an exact `VerificationChanged(WorkId, WorkRevision)` Wait is released when
that revision's Verification concludes. P6/P2's existing Work and Wait
bindings already provide exact Work/current-revision identity. The model-facing
control path already has `AgentActionRejected` → `ModelUsable` action
observation → same-loop continuation.

The gate therefore enforces the existing producer/wake relationship; it adds
no WakeCondition, Work/Execution state, settlement tag, public error type,
permission, schema, or migration. The model-visible `wait` name and schema do
not change. ClaimCompletion remains a separate valid producer path and still
atomically registers its own exact `VerificationChanged` Wait before P8's
consumer starts.

## Production change

`makeControlToolRegistry` now honors an explicit application-supplied `Wait`
handler while retaining its previous built-in handler when no override is
registered. The generic `agent-runtime` registry receives no repositories or
P8-specific rules. `single-workspace` supplies the app-owned handler with
Work/Workspace/Verification repositories.

For an active exact WorkEpisode, when the Work is still the Workspace's
current Open Work at the bound revision, the handler checks Work-level
`VerificationChanged` alternatives for that same Work:

- an exact Open Verification is an independent producer and the Wait is
  allowed;
- a matching concluded Verification is already satisfied, so the Wait is
  rejected with a useful ModelUsable result instead of parking;
- with no matching Open/concluded Verification, a Wait whose only
  independently productive condition is that same-Work verification is
  rejected (`AgentActionRejected`, existing `action/precondition`, correction
  `ChooseAlternative`). The response tells the agent to advance the Work or
  wait on an actual external condition; it is not `NeedsAttention` and does
  not write WorkWait or settle Yielded;
- a WorkEpisode that is no longer the exact current Open Work/revision is
  rejected, not parked;
- an `Any` Wait that also contains an independent alternative is preserved
  unchanged. Dependency/Inbox/manual/timer/foreign-Work alternatives are not
  discarded or rewritten. An Open verification source takes precedence over
  concluded history for the same target revision.

The guard intentionally does not scan all historical Executions. The
CompletionClaim action owns its exact durable Wait registration; it is not a
model-issued fallback `wait`. No prompt, tool catalog, command schema, or
database semantics changed.

## RED → GREEN evidence

Before the guard, a new deterministic Application/SQLite regression used the
real `buildSingleWorkspaceLayer` + `runExecution` path and a fresh schema
fixture. Provider turn 1 returned a Work-bound `wait` whose only condition was
the same Work/revision `VerificationChanged`; turn 2 was set to claim
completion if the loop continued. The pre-fix run failed exactly as expected:

```text
pnpm exec vitest run apps/single-workspace/test/wave2-claim-completion.test.ts -t "same-Work VerificationChanged self-wait"
1 selected test failed; 8 skipped
expected Completed(CompletionClaimed), received Completed(Yielded)
```

After implementation the full target file passed **13 passed / 2 skipped**:

```text
pnpm exec vitest run apps/single-workspace/test/wave2-claim-completion.test.ts
```

The added cases prove: (1) absent-source self-wait becomes a ModelUsable
precondition result and the same WorkExecution continues to ClaimCompletion;
(2) a seeded exact unsatisfied Dependency plus Inbox alternative is preserved
in a mixed `Any` Wait; (3) exact Open Verification allows waiting; (4) an
Open row takes precedence over a concluded historical row for the same
revision; (5) a concluded-only target is rejected and the loop continues; (6)
another revision of the same Work does not count as a foreign independent
source; and (7) a stale/non-current WorkEpisode self-wait is rejected while a
subsequent Manual Wait remains available. Existing ClaimCompletion and other
Wave 2 control-action tests also passed in this file.

The self-wait continuation assertion reads the durable
`(logical_step_no, repair_attempt, action_index)` cursor tuple and requires the
later ClaimCompletion action to advance past the rejected Wait. The full target
file passed 13/13 non-skipped tests before this cursor-only strengthening; the
strengthened self-wait case then passed 1/1 with the direct cursor assertion.

Generic registry regressions passed **13/13**:

```text
pnpm exec vitest run packages/agent-runtime/test/control-wait-revision.test.ts packages/agent-runtime/test/i0-control-registry.test.ts
```

Build and static checks passed:

```text
pnpm build
pnpm exec tsc -p tsconfig.test.json --noEmit
git diff --check
pnpm exec biome check apps/single-workspace/src/control-actions.ts apps/single-workspace/test/wave2-claim-completion.test.ts packages/agent-runtime/src/control.ts
```

The fixture/Provider is deterministic and test-owned. These are not public
HTTP/daemon black-box tests, not real-provider tests, and not release
qualification. No daemon, configured model, or user database was touched.

## Relationship to the separate real stop attempt

The real immediate-stop case itself remains
`EARLY_ABORTED_TERMINAL_BUSINESS_SELF_WAIT`; the public StopExecution boundary
was never reached. Its exact retained DB/capture/process cleanup evidence is
recorded separately in `S2-real-immediate-stop-terminal-self-wait.result.md`.
This implementation does not convert that run into PASS or normal Vitest
FAIL, does not rerun it, and does not establish that all real-provider S2
journeys are qualified. No private `.test-results` capture or fixture is
committed by this implementation record.
