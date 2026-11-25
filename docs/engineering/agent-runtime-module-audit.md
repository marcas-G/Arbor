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

## R2 directory ownership and startup/settlement phases

Audit and implementation base: c9a75d6a785a0aa78d121bd4183627ba1844b7a8.

Directory ownership (implemented paths, not an aspirational empty directory tree):

```text
packages/agent-runtime/src/
├── index.ts                         # package public API
├── agent-loop-driver.ts             # outer loop and Runtime integration
├── model-decision.ts                # decision orchestration during convergence
├── agent-loop-actions.ts             # action orchestration
├── decision/
│   ├── contract.ts                  # shared decision input/port types
│   ├── conversation-context.ts      # exact conversation context phase
│   ├── startup-recovery.ts          # recover durable cursor before Prepared
│   ├── submitted-replay.ts          # submitted decision replay predicates
│   └── settlement.ts                # Prepared step proposal transaction
└── checkpoint/
    ├── native-evidence.ts           # native evidence and portable frontier
    └── conversation/
        ├── binding.ts
        ├── compaction.ts
        ├── evidence.ts
        └── projection.ts
```

Eight existing modules were moved (cd60e5a67deed560ac4700a412396e5f9452bffa). The package barrel and decision driver now import canonical owners. Six existing internal paths are temporarily explicit re-export facades for existing deep imports; they contain no second implementation. Direct test imports for the four checkpoint modules are migrated in this follow-up. Remove each facade only after scanning all active source/test imports and running the full gates; historical planning/verification references remain historical, not migration targets.

Startup recovery (eab3b3ee4589b3a62b3ab1806562d999f37127e7) extracts the pre-loop Work native checkpoint recovery and exact-action cursor override into an explicit Ready(cursor) / Complete(outcome) result. The existing two settlement exits are translated to Complete and all other source statements are unchanged. The driver applies the cursor after the phase successfully returns; a failed or interrupted invocation now does not publish the partially recovered process-local cursor to the driver. Re-executing the same failed Effect instance must be checked in the pinned runtime; do not claim complete behavioral equivalence without that regression. Durable writes and transaction/fence calls stay at the original places.

Prepared settlement (e4642c2a0ad0baefea6ab84a8ee02d2e8df81b8c) moves the closure to an explicit phase returning the updated step. The original ProviderFailure dangling-turn close and Prepared CAS remain within one transaction. AH4 before/after probes remain on the same sides of the durable transaction; the driver updates its local cursor after the phase succeeds. Two tests added to the existing settlement-proposal suite verify the absent-step branch and the fenced transition. They have not been executed in the pinned project.

Dependency rule: decision phases may call checkpoint evidence/compaction and existing shared runtime policies/ports; checkpoint implementation may not call decision phases or any runtime driver. Neither directory imports the package barrel, agent-loop driver/actions, model-decision driver or temporary facades. Existing package DAG remains unchanged. The new architecture test walks both directories and inspects static AST import/export edges; computed specifiers and full TS alias resolution are not covered.

Future layout, introduced only when a complete responsibility is moved:
- `decision/step-recovery.ts`, `decision/session-context.ts`, `decision/turn-preparation.ts`, `decision/provider-lifecycle.ts` (or narrower modules if real transaction owners differ).
- `actions/` for action ledger, executable/control dispatch, exact action recovery; `control/` for catalog, type contracts, decoder, and authority. Keep `control` as control-action semantics, not all runtime policy. `prompt/` for instruction assets/programs. Reuse existing modules before adding subdirectories.
- Tool Runtime: invocation, resource, authority/approval, recovery/reconciliation, execution, settlement; keep tool implementations under existing `tools/`. Do not add empty directory skeletons, a generic utils/services dump, parallel state authority, or phase-number folders.
- Driver entry points remain at the existing root paths until the remaining large phases are qualified; later relocation must retain the supported entry and update architecture checks.

At this point model-decision.ts is 5,175 split lines (643 fewer than this batch's base). Source migration equality and the two startup exit reversals were checked in the extraction scripts; the phase and test changes are still unqualified. DNS clone failure reproduced in the current session; Node v22.16.0, no pnpm, no installed repository dependency graph. No full build, Biome, architecture, Vitest, recovery or release run is claimed. Run the existing full checks and AH4/AH17/AH19/P20 and exact-action recovery cases; verify repeated effect execution and interrupted phase behavior. No master merge or CI authorization.

## R2 durable step and overflow recovery — mandatory 800-line ceiling

Base 13a588ea11cec0b572b522f0e8590bae02e07a38. Owner requires source files at most 800 physical lines, not a soft metric.

- 10645b15267d82d412e89163d07ae4022cd0a633: extract durable step recovery from model-decision.ts (5,175 to 4,119 split lines). Four outer continues become Restart outcomes; three terminal returns become Complete outcomes. The extraction verified the inverse transformation against the original body.
- 72eb43fc24a320c1475b4f1c465394afcdf8757f: split Conversation overflow and explicit process-local overflow state.
- 5e3b789cf061a9acaf89d1b624b26e7feb002c04: split non-conversation Session overflow; step-recovery.ts becomes 254 split lines.
- 6158ec141b490cb66b30589fa932c12d81e97e8f: split settled Summary receipt/replacement recovery; work-overflow.ts becomes 693 split lines and settled-summary-overflow.ts 246 split lines. All new recovery modules are below 800 lines. Source equivalence checks covered moved body text and explicit continuation adapters, not full runtime behavior.

Canonical directory: decision/step-recovery.ts is the step driver; decision/recovery/overflow-state.ts owns only local continuation data; conversation-overflow.ts owns conversation checkpoint recovery; work-overflow.ts owns non-conversation Session recovery; settled-summary-overflow.ts owns settled summary receipt promotion. No new compatibility facades. Existing durable Step and ProviderTurn stores, transactions and fencing remain authoritative.

A strict source-size checker is introduced in this batch and wired into pnpm check; its transition mode compares actual parent/PR base and prevents new/growing violations while listing all historical violations. Source scope is extension-based and tracked paths only (including tests and scripts), not a limit on Markdown or generated build artifacts. The full repository still has oversized files; the strict gate is intentionally not green. The next largest remaining target in Agent Runtime is model-decision.ts, especially Session/checkpoint and provider lifecycle phases. Tool Runtime, Action Runtime, assign-work, persistence, and large tests remain to be inventoried and split.

Validation: 15 standalone JavaScript assertions on the line-rule helpers passed in the execution isolate; no full CLI/Node test-suite or project build was run here. Git network clone remains blocked by DNS, Node 22.16.0 is not the pinned runtime, pnpm unavailable. Do not claim the branch is qualified or merge until full checks pass. The new strict gate is intended to fail until all over-limit source files are eliminated. No workflow or branch protection changes.

### Follow-up validation of the source-size gate

On local Node v22.16.0, byte-identical copies of all three committed governance scripts were verified with Git blob hashes (source-lines-lib.mjs 580c9a97bbac15e52b7a51502bbdc5e7f359f534; check-source-lines.mjs 62854fed5884491c947ddb33cc2b8ae190958598; source-lines-lib.test.mjs 89d7db3232ed401e15cafc9e83c669b3211aadb5). The Node unit test suite passed 3/3. Five independent temporary Git repository CLI checks passed: strict rejection of a 900-line legacy file; transition acceptance of unchanged legacy debt; rejection of growth to 901; strict acceptance after reduction to 800; rejection of a new tracked 801-line file. The clone of Arbor itself still fails DNS; no full Arbor qualification is claimed.

The remote diff from 13a588e through 83cbd14 contains 13 changed files. All eight newly added source files have at most 800 physical lines; the five recovery modules have 253 (step driver), 18 (overflow state), 332 (conversation), 692 (Work Session), and 245 (settled Summary) lines. Physical counts exclude the phantom trailing empty entry in split-line statistics. The full repository remains over the cap (model-decision.ts alone is still 4,118 physical lines). The exact repository-wide backlog must be produced by running the strict scanner in a complete checkout.

## R2 context and native checkpoint convergence

Base: 6dd5efc8a872fa1021942ff31af88f52f1b52103.

| Commit | Actual responsibility extracted |
|---|---|
| b187d47e586d5afa1b136c00888054a29ff434eb | Session projection, provenance-bound dangling invocation repair, context and native owner lookup |
| 33c264e392546cb91d4801a5eb81da8f8d771e96 | Native checkpoint producer receipt/source step and cursor validation |
| 9ab264fa5a086236fa7356efb6505601af06b81e | Reconstruct portable frontier from the exact native manifest/receipt and Session suffix |
| aaa17785ec43cd2fb57d1b5908cba1a3c28bc2bc | Recover committed terminal response or exact next Step after rebase |
| 708809bc7db9914ea54b0dbac9655cbbac11cbbd | Workspace/Work/LocalPlan context and separate existing local-plan rebase branch |
| 2fdc6db0133167adc3ab752e5cd7ae059ef918f1 | Compose native checkpoint recovery with explicit Ready/Restart/Complete and local cursor/overflow result |

Canonical owners: decision/context/session.ts (412 physical lines); decision/context/workspace.ts (129); decision/recovery/native-checkpoint-source.ts (333); native-portable-frontier.ts (550); committed-rebase-step.ts (549); work-plan-rebase.ts (337); native-rebase.ts (508). No new compatibility facades, no new package dependency, no schema or frozen design change. The main file is now below 2,000 physical lines, but still above the mandatory 800. Workspace additions are returned as fresh arrays and appended by the driver; the local plan scope condition and order of reads are retained. Recovery phases return cursor/overflow values rather than modifying an outer mutable context. They preserve existing durable store calls and transaction boundaries by source extraction, not by independently verified runtime equivalence. Cursor updates now become visible to the driver on successful phase returns, which requires repeated/interrupted Effect regression checks.

Static evidence: inverse checks of moved source text and explicit return/continue adapters; at 2fdc6db the full Git tree was not truncated. Across the seven added modules and driver, 51 literal relative import/re-export edges resolve to tracked paths with no detected new decision-to-driver back-edge. All seven added production files satisfy the 800-physical-line cap. The final follow-up adjusts existing P3, MAC, CRAC, AH19 and EGP architecture assertions to canonical owners; EGP's negative constraint now scans decision subdirectories as well. No architecture assertion is knowingly dropped. This is not an AST/type-resolution or test-suite result.

Qualification blocker: current container git ls-remote against GitHub failed DNS resolution; Node v22.16.0, pnpm missing. The complete project cannot be cloned, built or tested here. Existing branch changes remain unqualified; run the pinned formatting, TypeScript, architecture, manifest, Vitest and relevant AH19/P20 native checkpoint/rebase, terminal response, LocalPlan and Session frontier repair process tests. Strict 800-line check is still expected to fail for remaining oversized files. Next: turn preparation (instructions, profile, manifest), provider admission/replay and result/repair/overflow handling; then shrink the main driver below 800 before moving it to its final canonical directory.
