# Agent runtime responsibility audit — first extraction

Baseline: f5f771f349398b6e341952b1a6ecfdab09d8945c. Source: `packages/agent-runtime/src/model-decision.ts` (6,926 split lines in the connector response; 292,100 bytes in the Git tree). This is a focused audit of the model decision recovery seam, not a full runtime audit.

## Responsibilities observed

| Responsibility | Existing owner / call site | Boundary |
|---|---|---|
| Orchestrate model decision, context, provider activity, and settlement | runModelDecision | Effectful orchestration; leave transaction and provider order unchanged |
| Determine whether a terminal Submitted DecisionRequest can replay a pinned SelectCurrentWork | isPinnedSubmittedDecisionReplay | Pure predicate over request, workspace, step, action and settled provider evidence |
| Classify the two exact AH10 binding mismatch failures | classifySubmittedDecisionBindingFailure | Pure classifier; other invalid evidence remains on the existing fail-closed path |
| Validate a prepared overflow compaction link | isValidOverflowCompactionLinkPair | Pure link identity/state/epoch predicate; caller retains additional count and transaction checks |
| Validate native checkpoint ownership, frontier and receipt | native checkpoint helpers and existing conversation-checkpoint modules | Next audit candidate; do not move until type and fixture dependencies are mapped |

The original replay calls are near lines 5526 and 5550; the overflow link checks near 1747 and 1965. Both read persisted facts from existing ports. Neither extracted predicate owns writes, starts a provider request, grants authority, or decides a new product semantic. The orchestration body, including ordering and recovery branches, is unchanged byte-for-byte.

## Implemented seam

- Submitted Decision predicates and their input type now live in `submitted-decision-replay.ts`.
- Overflow link predicate now lives in existing `agent-loop-step-recovery.ts`, beside P20 recovery chain helpers.
- Original internal module exports remain available so existing consumers/tests need no import migration. Package public barrel, package dependencies and frozen design remain unchanged.
- Existing pinned replay test retains its coverage and adds stale/missing evidence, cursor and duplicate/missing/wrong overflow link cases. No expected result was weakened.

## Validation boundary

The extracted pure functions were tested in isolation with Node 22.16.0's experimental type stripping: 27 tests passed (exact replay, both classified mismatches, other rejection paths, exact overflow pair and rejection paths). This is not a Vitest, TypeScript project build or daemon qualification. The production environment and dependency installation are unavailable in the current session. Run in a clean pinned Arbor checkout before merge:

    pnpm --filter @arbor/agent-runtime build
    pnpm exec vitest run packages/agent-runtime/test/model-decision-pinned-replay.test.ts packages/agent-runtime/test/agent-loop-step-recovery.test.ts
    pnpm architecture
    pnpm check

Run the affected AH10 and overflow process recovery journeys under the repository's existing release qualification policy. No existing verification evidence is promoted to the new commit.

## Next seam

Map native checkpoint manifest/portable frontier parsing and validation to existing conversation-checkpoint modules. Extract only when the caller-specific data dependencies and recovery evidence are explicit. Then review long effectful sections of runModelDecision by state/transaction ownership, not by arbitrary line count.
