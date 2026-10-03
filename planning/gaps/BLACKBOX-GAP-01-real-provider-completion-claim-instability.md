# BLACKBOX-GAP-01 — Real-provider CompletionClaim instability

**Status:** CLOSED — official DeepSeek Flash qualification 3/3 PASS

**Discovered:** 2026-10-02 S1–S4 black-box qualification

**Owner:** Work Agent cognition / provider tool-call delivery / completion-claim control route

## Failure evidence

The deterministic public-process black-box completes the full path:

```text
AssignWork → arbor_claim_completion → Verification → Parent Acceptance
→ CompleteWork
```

The real DeepSeek B11 sentinel remains unstable. In the latest three-run batch:

```text
PASS: 1
FAIL: 2
```

The passing run settled `Completed(CompletionClaimed)`. Failed runs ended before
a durable claim; captured provider traces include output repair/protocol failure
rather than a false completion. Runtime therefore fails closed, but autonomous
progress is not reliable enough for release qualification.

Evidence report:

```text
C:/Arbor/planning/testing/core-capability/reports/capability-real-provider-2026-10-02T11-22-45.176Z-6c4f46e7-d677-42d2-b28e-f51902ac3042.json
```

## Safety disposition

- No Work was falsely completed.
- No Verification or Acceptance boundary was bypassed.
- The failure is availability/progress reliability, not canonical-state
  corruption.

## Required follow-up

1. Preserve the exact failing provider wire trace and replace `[object Object]`
   capture with typed/safe failure taxonomy.
2. Distinguish model non-compliance, incomplete tool-call wire output and
   Session frontier reconstruction.
3. Decide whether the completion-oriented TurnProfile needs a stronger
   versioned instruction or an explicit provider tool-choice policy.
4. Re-run B11 three times; closure requires 3/3 PASS with no false completion.

This gap does not reopen Verification/Acceptance semantics.

## 2026-10-03 post-convergence rerun

After the production renderer/client, model-facing names, Session/Context
boundary and WorkflowSignalConsumer convergence, B11 was rerun three times
through the production OpenAI-compatible path.

```text
L1 PASS
L2 PASS
L3 0/3 PASS — all three calls rejected before inference
```

All three requests advertised the expected unbranded `claim_completion` tool
and carried no prior malformed tool history. The endpoint returned the same
provider error on every call:

```text
invalid_request_error: Insufficient Balance
```

Evidence report:

```text
planning/testing/core-capability/reports/
capability-real-provider-2026-10-02T15-57-22.390Z-9e8107b5-ea3f-41d5-8a4e-fbabc27ab8ea.json
```

This run provides no evidence for or against model completion-claim behavior:
the model was never invoked. Closure now requires a funded/reachable deployment
and a fresh 3/3 run. No code retry can remediate provider account balance.

The evidence harness now serializes typed Effect failures safely instead of
`[object Object]`, with credential-shaped fields redacted.

## 2026-10-03 closure

The funded official DeepSeek endpoint exposed two harness defects rather than
a remaining `claim_completion` protocol defect:

1. the real-provider Vitest layer imposed an unrelated 120-second deadline on
   top of the Provider Runtime's progress-aware phase deadlines; and
2. the B11 Work had placeholder goal `g`, no criteria and no deliverable, while
   ordering the model to assert that all criteria had passed without checking.

The first defect caused false timeout plus Windows SQLite teardown races. The
second made refusal the correct agent behavior; occasional compliance was not
valid completion evidence.

The qualified B11 case now creates an isolated temporary Git worktree, binds
both `FileTree` and `GitWorktree`, writes a unique completion-evidence file,
and supplies matching Work objective, completion expectation and structured
Verification criterion. The model must read that file before invoking the
unbranded `claim_completion` control tool. Provider Runtime owns execution
timeouts; the test framework no longer preempts a progressing Agent Loop.

Final official DeepSeek Flash result:

```text
L1 PASS
L2 PASS
L3 PASS — 3/3 repetitions, 0 failures
```

Closure report:

```text
C:/Arbor/planning/testing/core-capability/reports/
capability-real-provider-2026-10-02T16-36-09.651Z-43d54834-8597-4931-8386-8c25f9b53e45.json
```

All three runs preserved the lifecycle boundary: the Execution settled
`Completed(CompletionClaimed)` while Work remained `Open`; Verification and
Parent Acceptance were not bypassed.

### Non-blocking observation

The invalid predecessor sentinel also showed that a non-conversation Work
response containing text but no action can consume the remaining Agent Loop
budget before `Failed(max turns reached)`. That run remained bounded and
fail-closed, and the frozen design currently treats accepted ModelOutput /
AgentLoopStep persistence as durable progress. It therefore does not establish
a design contradiction or reopen B11. A different actionless-Work settlement
or behavioral-repair policy would be a new product semantic and requires a
separate governance request backed by a legitimate Work scenario, not this
invalid completion sentinel.
