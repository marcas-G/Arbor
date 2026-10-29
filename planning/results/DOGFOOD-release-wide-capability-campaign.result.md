# Arbor Release-wide Dogfooding Campaign

**Date:** 2026-10-03

**Status:** PASS — ALL B01–B14 CAPABILITIES GREEN

**Provider:** official DeepSeek / `deepseek-flash`

## 1. Scope

This campaign combines:

1. the complete real-provider B01–B14 capability matrix for every currently
   authorized L3 case; and
2. one continuous isolated coding Work that had to absorb real shell/test/patch
   failures, modify code, re-test, inspect Git scope and claim completion.

No exchange, brokerage account, order placement or non-test external side
effect was used.

## 2. Real-provider capability matrix

Each selected L3 case ran three independent repetitions. Every repetition
produced its own evidence record.

| Capability | Function | L1 | L2 | L3 | Real stability |
|---|---|---:|---:|---:|---:|
| B01 | Basic Human Conversation | PASS | PASS | PASS | 3/3 |
| B02 | Executable Tool Use | PASS | PASS | PASS | 3/3 |
| B03 | Control Action | PASS | PASS | PASS | 3/3 |
| B04 | Multi-turn Memory / Cognitive Continuity | PASS | PASS | PASS | 3/3 |
| B05 | Human Steer | PASS | PASS | PASS | 3/3 |
| B06 | Parent / Child Communication | PASS | PASS | PASS | 3/3 |
| B07 | Responsibility Delegation | PASS | PASS | PASS | 3/3 |
| B08 | Specialist Delegation | PASS | PASS | PASS | 3/3 |
| B09 | Dependency / Deliverable | PASS | PASS | PASS | 3/3 |
| B10 | Verification | PASS | PASS | PASS | 3/3 |
| B11 | Completion / Acceptance boundary | PASS | PASS | PASS | 3/3 |
| B12 | Restart / Continuation | PASS | PASS | PASS | 3/3 |
| B13 | Failure Recovery | PASS | PASS | PASS | 3/3 |
| B14 | Web / Product Projection | PASS | PASS | PASS | 3/3 |

Totals:

```text
Authorized real L3 capabilities: 14
Real L3 repetitions:            42
PASS:                           42
FAIL:                            0
Assertion failures:              0
L1/L2 mapped tests:             280 PASS
```

Machine report:

```text
C:/Arbor/planning/testing/core-capability/reports/
capability-real-provider-2026-10-02T20-43-10.293Z-f8122095-9c6a-4163-8702-a9ca0dff2b20.json
```

Readable report:

```text
C:/Arbor/planning/testing/core-capability/reports/
capability-real-provider-2026-10-02T20-43-10.293Z-f8122095-9c6a-4163-8702-a9ca0dff2b20.md
```

## 3. Continuous coding Work

The same release campaign included a real isolated Work Agent task:

```text
Provider turns:       9
Tool invocations:    12
ExpectedFailure:      3
Success:              9
initial node --test: exit 1
final node --test:   exit 0
git diff --check:    exit 0
changed scope:       src/drawdown.mjs only
settlement:          Completed(CompletionClaimed)
Work lifecycle:      Open
```

The Agent recovered autonomously from:

- a platform-incompatible shell pipeline;
- the intended failing tests; and
- a non-applicable first patch.

It then repaired the running-peak algorithm, passed all tests, verified Git
scope and claimed completion. The Work remained Open because model completion
never bypasses Verification / Parent Acceptance.

Detailed result:

```text
C:/Arbor/planning/results/DOGFOOD-typed-failure-coding.result.md
```

Evidence:

```text
C:/Arbor/planning/testing/core-capability/evidence/real-provider/
DOGFOOD-CODING-REAL-2026-10-02T19-47-24.503Z-b5391647-5566-4f78-945c-874d7afbbfce.json
```

## 4. Repository regression baseline

Latest full `pnpm check` before the real-provider campaign:

```text
lint PASS
typecheck PASS
architecture 132/132 PASS
core 278 files / 1612 PASS / 1 conditional SKIP
Web typecheck/build PASS
Web 212/212 PASS
git diff --check PASS
```

The real-provider campaign added only test/evidence/result artifacts. Its new
test source passed Biome and TypeScript checks independently.

## 5. B10 governance reconciliation and qualification

The same latest DID contained an old v1.19 ACR-8 checkpoint saying the four
field-source mappings were OPEN and a later, manually accepted v1.26
VDC-1…VDC-8 contract freezing and implementing all four. The old checkpoint,
AGENTS index and gap table were reconciled as historical/superseded state.

The extracted B10-only real-provider sentinel proves:

```text
exact-bound Verifier Execution
→ successful executable ToolResult
→ exact ToolInvocationId + observationRef + executionId + callRef evidence
→ model-authored summary bytes
→ Runtime BlobStore persistence + byte verification
→ ConcludeVerification(Pass)
→ durable Verification summaryRef/event
→ Completed(VerificationConcluded)
```

The target Work remains Open because Verification Pass does not bypass Parent
Acceptance. B10 passed 3/3 both in its focused run and in the unified matrix.

## 6. Security and isolation

- API key and Authorization header are absent from reports/evidence;
- every mutation-capable real case uses an isolated temporary database and/or
  worktree;
- the continuous coding repository was deleted after evidence extraction;
- no push or remote repository mutation occurred;
- no main-repository source file was modified by the Dogfood Agent.

## 7. Verdict

All product capabilities passed real-provider release validation with 42/42
L3 repetitions. The system demonstrated conversation,
memory, executable/control tools, steer, hierarchy, communication, delegation,
specialists, dependencies, completion boundary, restart, recovery and Web
projection under official DeepSeek Flash.

Release-wide verdict is **PASS — B01–B14 ALL GREEN**. No capability remains
blocked or NOT_RUN in this campaign.
