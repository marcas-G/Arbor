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

## Follow-up: checkpoint and cross-runtime recovery seams

Starting at e6ab5b4870b06593e72e167ca03ad1bf0ec63dbf, four focused commits were landed on the governance branch:

| Commit | Change | Responsible boundary |
|---|---|---|
| 8f3092489f738ab6e6a489ec5a63b11c33d490e1 | Native and conversation checkpoint evidence | Native manifest/request frontier validation; conversation causal scope and persisted receipt read/validation |
| 50fd70c694a2dac61ff93b247f9071d8ccadc7d5 | ToolRuntime P39 binding | Construct and validate durable binding identities, approval snapshots, authenticated reconciliation evidence |
| 849be1c08f2a7c95a14537ba604e56a985410bf2 | Requested resources | Parse legacy/new requests, lexical target resolution and candidate root selection before canonical admission; not OS sandbox authority |
| 3e54f0448260c6901af1c83b35ef7781d9222003 | Agent action recovery | Project source binding from persisted Step/Action/ControlBasis; verify sandbox-unavailable resume evidence through existing stores |

The following new internal modules own these responsibilities:

| Module | Owns | Does not own |
|---|---|---|
| agent-runtime/src/native-checkpoint-evidence.ts | Native producer identity and portable input frontier checks | Provider calls, checkpoint mutation |
| agent-runtime/src/conversation-checkpoint-evidence.ts | Exact conversation source scope and checkpoint receipt validation | Checkpoint writes, provider admission |
| agent-runtime/src/recovery-binding-source.ts | Exact persisted source identity and policy revision projection | Tool approval, execution, P39 settlement |
| agent-runtime/src/sandbox-unavailable-recovery.ts | Read and compare exact unavailable fact and newer effective policy | Grant/revoke authority, change execution state |
| tool-runtime/src/recovery-binding.ts | RecoveryBinding construction and evidence matching | Durable writes, retry/admission decisions |
| tool-runtime/src/requested-resources.ts | Requested resource argument parsing and lexical selection | Canonical resource admission, realpath and OS containment |

Existing orchestration, package exports and package dependency declarations are preserved. Existing internal imports of moved exported guards continue working via re-exports. The three orchestration bodies (runModelDecision, ToolRuntimeLive, executeAgentLoopActions) were compared with the baseline via the exact remote content and found unchanged byte-for-byte. The extraction operations also checked source equality with the original helpers, except newly required export modifiers. The three files are now 6,408, 4,706 and 2,246 split lines respectively (935 fewer lines in those orchestration files, not a reduction in total system code). Twenty-two functions were moved to the six responsibility modules.

CRAC architecture assertion was updated to inspect the actual owner of the existing causal-prefix logic while also checking that model-decision still imports and calls the guard. The invariant remains unchanged. Existing test expectations were not relaxed.

### Evidence

- Remote commit comparison for the four code commits confirms 13 affected files: six new implementation modules, two new test files, three modified implementation files and two extended test files.
- On Node v22.16.0 (Linux), exact copies of requested-resources.ts and recovery-binding-source.ts matched Git blob SHA 4007ed0ce797281a5cfc66b7aeb647fa10dc4303 and 7e42ef3fe854ab6bf4065f7f01e958f6ca53b6a1 respectively. A standalone Node test harness using experimental type stripping executed 29 cases, 29 passed, 0 failed/skipped. Cases covered valid/malformed resource requests, absent/invalid/contained targets, absolute/escaping paths, candidate roots, missing/mismatched persisted binding evidence and invalid policy revisions. This is independent functional evidence for these two modules, not the project's Vitest suite or type checking.
- Full clone/install is blocked by network DNS in the execution environment; pnpm and the pinned Node version are unavailable. No full build, Biome, architecture, Vitest, process recovery or release qualification was run. Native checkpoint/P39/Effectful receipt and resume paths require the real package graph and stores.

### Further findings and next seam

Requested-resource selection lowercases candidate paths on all platforms; lexical normalization must not be confused with canonical admission on case-sensitive hosts. This pre-existing behavior is deliberately preserved, not declared a proven authorization bug. Establish a Linux counterexample across the canonical resolver/admission boundary before considering a separate fix.

Next: qualify this batch before extracting nested Effectful orchestration. Inventory the context assembly and provider admission/settlement subflows against the recovery contracts, isolate one independently testable responsibility at a time, and keep the current transaction owners intact.

Required verification in the pinned Arbor checkout:

    pnpm lint
    pnpm typecheck
    pnpm exec vitest run packages/agent-runtime/test/native-checkpoint-evidence.test.ts packages/agent-runtime/test/recovery-binding-source-identity.test.ts packages/tool-runtime/test/recovery-binding-identity.test.ts packages/tool-runtime/test/requested-resources.test.ts
    pnpm architecture
    pnpm check

Additionally run applicable AH17/AH19 checkpoint, AH7/P39 tool recovery and P9 sandbox-unavailable process cases according to the current manifest and release qualification policy. Do not claim completion or merge without required gates.
