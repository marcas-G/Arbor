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


## Proposed structural convergence: replace giant orchestration bodies

Audit base: 8c757bbface43cc048ee01197fbf45751ddaa977. This is a proposed implementation decomposition within the existing frozen design, not a new product contract or owner approval of semantic changes. DID §10.6 explicitly specifies a slim AgentRuntime, P3 defines the durable AgentLoopStep handoff, P4 owns executable tool execution, §7.4 requires one semantic transaction scope, and P9 requires systematic crash/recovery evidence. These existing constraints govern all extractions.

The preceding work moved independent helpers, but left runModelDecision, ToolRuntimeLive and executeAgentLoopActions bodies byte-identical. Their remaining control-flow and state coupling are the primary problem. Do not continue optimizing file-size totals.

### Observed source map (1-based approximate ranges at the audit base)

| Current file | Range / anchor | Responsibility candidate |
|---|---|---|
| model-decision.ts | 227–399 | Turn dependency setup; timeline and Work compaction pinning |
| model-decision.ts | 400–986 | Startup checkpoint recovery and inherited producer ownership |
| model-decision.ts | 987–2090 | Exact step identity, durable ProviderTurn/step replay and overflow continuation |
| model-decision.ts | 2091–2163 | Settlement proposal and fenced step transition |
| model-decision.ts | 2164–2667 | Conversation-specific input/history/checkpoint processing, including terminal recovery |
| model-decision.ts | 2676–4575 | Session projection, pinned output and checkpoint validation/replay |
| model-decision.ts | 4576–5099 | Workspace/Work context, instructions, decision replay binding |
| model-decision.ts | 5100–5407 | Compaction continuation, profile and preparation |
| model-decision.ts | 5408–5890 | ProviderRunInput and durable manifest/replay handling |
| model-decision.ts | 5891–6407 | Admission, Provider result/overflow, repair and outcome |
| tool-runtime/src/runtime.ts | 310–683 | Existing Layer assembly and sandbox process runner |
| tool-runtime/src/runtime.ts | 684–1154 | Recorded observation evidence and fenced invocation lookup |
| tool-runtime/src/runtime.ts | 1155–1957 | Invocation setup, durable no-effect and replay gates |
| tool-runtime/src/runtime.ts | 1958–2146 | Workspace/environment/resource resolution and captured admission checks |
| tool-runtime/src/runtime.ts | 2147–3741 | Admission, P39 evidence/reconciliation, retry and fenced claims |
| tool-runtime/src/runtime.ts | 3742–4317 | New effect admission, sandbox/execution and reconciliation selection |
| tool-runtime/src/runtime.ts | 4318–end | Terminal evidence/settlement writes and response |
| agent-loop-actions.ts | makeBlockedSettlement; 431–703 | Blocked settlement and exact step recovery before dispatch |
| agent-loop-actions.ts | 704–1539 | Action iteration, terminal result and observation persistence |
| agent-loop-actions.ts | 1540–1779 | Executable action path |
| agent-loop-actions.ts | 1780–end | Control decode, authorization, handler, settlement |
| apps/single-workspace/src/control-actions.ts | 903–4838 | Distinct handlers (assign work, sandbox allocation, acceptance, communication, plan, coordination, delivery, verification) |
| apps/single-workspace/src/control-actions.ts | 4839–end | Registry/composition and Layer wiring |

Ranges are investigation anchors, not extraction cuts. Some branches interleave early returns, continue, and transaction work across the conceptual boundaries. Determine actual live inputs/outputs and transfer ownership before moving them.

### Target internal responsibility graph

Preserve existing packages, public exports, direction of dependency and durable schemas. Place internal modules near their owner; reuse existing checkpoint, compaction, policy, recovery, authority, resolution and settlement modules rather than creating parallel services.

- Agent model decision: startup recovery; step recovery; conversation context; Work/session context; turn preparation; provider result/repair; settlement. The top-level decision driver should express the loop and outcome transitions, not reimplement every branch.
- Agent action execution: step resume; Action ledger/terminal persistence; executable dispatch; control dispatch; settlement. Both dispatch paths must use the same action identity and authoritative observation/settlement boundary where already required.
- Tool runtime: invocation identity/replay; resolution and authorization; approval and effect admission; reconciliation; scoped execution; terminal evidence/settlement. The existing Layer remains the composition root for this runtime.
- App control handlers: group by product capability (Work lifecycle, workspace authorization/placement, communication, dependency/delivery, verification), share existing command-receipt and fencing policy, retain registry assembly as wiring. Do not move semantic mutations out of owning Application commands.

The orchestration may use small explicit discriminated outcomes for a phase (continue with updated local state, return an existing ModelDecisionOutcome, or fail through the existing typed Effect error channel). They are private control-flow objects, never persisted state or new semantic authority. Each helper takes a narrow, immutable input and explicit required ports; no giant mutable DecisionContext, untyped service bag, hidden global state, or new independent scheduler. Do not invent outcomes or remove existing early returns merely to force a linear pipeline. Do not introduce a general-purpose state machine engine before the current state graph and proof obligations are mapped.

### Refactor sequence and exit gates

1. Qualify the existing extraction branch at a clean pinned revision: typecheck, lint, architecture, targeted tests, full check; preserve real failures. Obtain the actual import and inventory diagnostics.
2. Create a pre-refactor call/control-flow map including all return/continue/throw sites, mutable local cursor writes, transaction scope, fencing, provider activity bracket and crash boundaries. Map existing tests to those transitions; fill missing regression tests first.
3. Split capability-based top-level control handlers and isolate one shared receipt/fencing seam; keep command ownership and registry behavior intact. In parallel only if file ownership is disjoint.
4. Extract ModelDecision settlement proposal and startup/step recovery by explicit outcome contracts. Next separate conversation context from Work/session context, then preparation and provider/result handling. Each PR covers a complete responsibility seam, not a mechanical line quota. Validate exact replay, overflow, checkpoint, repair, and restart paths.
5. Extract Action ledger and dispatch boundaries. Preserve observed sequence and the P3/P4/P40 handoff. Prove recovery with existing P9/SandboxUnavailable and blocked-settlement cases.
6. Extract ToolRuntime in transaction-order groups: replay/evidence, admission/reconciliation, scoped effect execution, terminal settlement. Verify AH7, P39/P40, stop/revocation, unknown outcome, lease/fence and cleanup paths. Do not move admission or settlement into a separate transaction.
7. Reassess attention projection and schema upgrade only after runtime boundaries stabilize; do not restructure historical migrations for cosmetic consistency.

For every slice, maintain a reviewable before/after transition map, explicit dependency surface, unchanged persisted/public contract, unit and required integration/process tests on the new revision. Split or adapt architecture checks to the actual owner without weakening an invariant. The target is a coherent short top-level orchestration plus independently testable phase implementations; file/line sizes are indicators only. Establish actual baselines and do not introduce arbitrary blocking line-count limits.

### Current blocker

The current session can read and write repository files through GitHub, but cannot resolve github.com for a local clone (git ls-remote fails with "Could not resolve host: github.com"). Local Node is v22.16.0, pnpm is unavailable; the pinned project build and integration qualification cannot run here. The prior helper extraction commits have not been qualified as a combined Arbor tree. This plan is committed as a proposed audit-backed roadmap, not an executed large-scale refactor. Avoid adding unverified stateful rewrites to that stack until the actual runner/build is available. No branch promotion, new CI run, design change or release claim is authorized by this note.

## R1 implementation and first R2 phase

Implementation base: e0cb825dd7bd23d5f34e8df9d095719cbe36fbb2.

- d4c499625c35ce97f6fcfdd7ffe5b04426284af0: split single-workspace control actions into eight responsibility modules, preserving the original registry facade, Context service, registration order, existing exported names, command bodies, dependency interfaces, receipt helpers and transaction scopes. The original 5,241-line file is now a 543-line composition/compatibility entry. Shared command receipt policy is in command-receipts.ts; the other modules own assign-work, workspace, work lifecycle, messaging, dependency/deliverable, delivery, and verification.
- 536cf8b21d751ad9846c0693b41077c431e17aa3: relocated existing verification architecture assertions to their actual owners; retained the no-wake-delivery invariant across the split.
- 1ea367997b61d7dd73d90c60b18d3dde394bd13f: extracted the Conversation Context phase and the independent ModelDecision dependency contract. The model decision file decreased from 6,408 to 5,818 split lines. The new phase returns Ready, Restart or Complete; the caller retains the existing loop and terminal outcomes. It preserves the original conversation checkpoint transaction calls, fences, provider compaction, P20 terminal recovery and evidence checks. Only the rebase continue and two terminal exits are adapted to the explicit private result union.
- This follow-up adds a static AST guard for the control capability dependency direction and dynamically scans the split modules for the pre-existing forbidden wake-delivery responsibilities. This is a new internal structure constraint, not a change to domain semantics. The guard checks static imports/re-exports; it is not a complete TypeScript resolver.

Evidence: the R1 migration script checked coverage of every original non-import line, equality of moved body text after restoring newly required export modifiers, and the original public symbol set. For R2 the extraction script reversed all three control-flow adaptations and checked the resulting body against the original exact text after indentation normalization. These checks are static source-equivalence evidence only, not runtime equivalence or a passing test suite. The full checkout remains blocked by DNS resolution of github.com; local Node v22.16.0 and no installed pnpm/Arbor dependencies differ from the pinned Node 24.21.0/pnpm 12.4.2. No complete TypeScript, Biome, Vitest, architecture or process recovery tests have run. Do not merge until required gates pass.

Required before the next stateful phase: format/check only the changed files under the pinned environment, run pnpm typecheck, pnpm architecture, pnpm test:manifest, pnpm test and the applicable control-command, AH10/AH19/P20 conversation checkpoint and recovery cases. Then run pnpm check; preserve failures and fix them without weakening the contracts. Next implementation boundary: startup/step recovery and settlement proposal, followed by Work/Session context and provider lifecycle. Do not create a second scheduler or move transactions across their existing boundaries.
