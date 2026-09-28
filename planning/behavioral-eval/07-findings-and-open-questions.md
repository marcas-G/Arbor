# Findings and open questions

This is a research record against the frozen S1–S4 scenario set and the checked-out source visible on 2026-09-25. No prompt/runtime/test was changed and no model API was called. The repository was already dirty; code-path findings below are explicitly provisional until rechecked at a clean, named baseline.

## Findings

### F-01 — Registered P6/P8 prompt text has no identified production activation path

- **Severity / tags:** HIGH — `BEHAVIORAL_GAP`, `UNTESTABLE_WITH_CURRENT_OBSERVABILITY`.
- **Finding:** Six versioned text artifacts exist and are registered: `p6-formation`, `p6-communication`, `p6-bootstrap`, `p6-human-steer`, `p8-verification`, and `p8-query-inspection`. In the inspected source, `loadProgram(...)` has no production call site outside the prompt-program loader/gate itself. The current driver chooses P3 `BASE_AGENT_PROTOCOL` for a human Conversation and `WORK_EXECUTION_PROGRAM` for other executions; the P6/P8 full-text artifacts are not selected there.
- **Evidence:** `packages/agent-runtime/src/prompt-programs.ts` (`PROGRAM_REGISTRY`, `loadProgram`); `packages/agent-runtime/src/driver.ts` (`runDecisionTurn`, program selection); search results for `loadProgram(`; `packages/agent-runtime/test/p6-prompt-programs.test.ts`, `p8-programs.test.ts`.
- **State distinction:** **DESIGNED:** phase contracts name six families. **IMPLEMENTED:** registry, file loading, hash/version/clause gate. **TESTED:** static file gates and scripted acceptance stories. **BEHAVIORALLY VERIFIED:** no production activation evidence or real-model behavior evidence identified.
- **Why it matters:** A correctly versioned prompt artifact cannot affect behavior if the runtime never supplies it. This is the highest-priority activation question before interpreting any prompt-eval result.

### F-02 — Current WorkExecution instruction content appears to be a reference string, not the objective

- **Severity / tags:** HIGH — `BEHAVIORAL_GAP`, `INSUFFICIENT_INPUT_DEFINITION`.
- **Finding:** In the inspected driver, `workObjectiveFragment` sets `contentRef` to ``work:${execution.executionId}``. The model-context compiler copies `fragment.contentRef` directly into `PortableModelRequest.instructions[].text`; no resolution step appears between construction and compilation. The same inspected Work path supplies `contextFragments: []` and no body skills. On this source snapshot, the resulting instruction text is an opaque reference, not the actual objective/constraints/completion expectation.
- **Evidence:** `packages/agent-runtime/src/driver.ts` (`workObjectiveFragment`, Work `prepareTurn` input); `packages/model-context/src/compiler.ts` (`compile`); `packages/model-context/src/prepare-turn.ts` (`planContext`, skill/tool preparation); P3 `02-model-context-contracts.md` and `05-prompt-context-contracts.md`.
- **State distinction:** **DESIGNED:** Work objective/constraints/completion expectation are intended context inputs. **IMPLEMENTED:** fragment construction and direct compilation are present. **TESTED:** compiler/context shape tests exist. **BEHAVIORALLY VERIFIED:** no evidence that a model receives the actual objective in this path.
- **Why it matters:** Work-action, formation, completion, and recovery judgments cannot be evaluated meaningfully if the required task inputs are not in the request.
- **Confidence caveat:** `driver.ts` and context files were already modified in the dirty tree before this review. Confirm against the intended clean baseline; this report does not repair or reinterpret the source.

### F-03 — Root Conversation input is not evidence of persistent conversational context

- **Severity / tags:** HIGH — `BEHAVIORAL_GAP`, `UNTESTABLE_WITH_CURRENT_OBSERVABILITY`.
- **Finding:** In the inspected Conversation path, the request contains the currently claimed human message, disables tools, supplies no context fragments/body skills, and selects only the P3 Base protocol contract. P5 tests establish that Session rows/entries survive executions and restart; they do not show that earlier turns are included in a later provider request. Therefore persistence is not evidence of continuous model-visible conversation.
- **Evidence:** `packages/agent-runtime/src/driver.ts` (`conversationInputOf`, `isHumanConversation`, `messages`, `includeTools: false`, `contextFragments: []`); `apps/single-workspace/test/p5-session-continuity.test.ts`; `p5-restart-continuity.test.ts`; P14 `02-conversation-execution.md`, `03-transcript-read-model.md`.
- **State distinction:** **DESIGNED:** S1 says user and Main Agent can discuss over multiple turns; S4 expects work-spine continuity. **IMPLEMENTED:** human message persistence/claim/settlement exists. **TESTED:** storage/trigger continuity has coverage. **BEHAVIORALLY VERIFIED:** historical turn inclusion and correct use are not proven by those tests.
- **Why it matters:** A real behavioral test must inspect the compiled request/context manifest or otherwise establish exactly what prior state the model saw.

### F-04 — The current test named “real-provider conversation” uses a canned provider response

- **Severity / tags:** HIGH — `BEHAVIORAL_GAP`.
- **Finding:** The dirty-tree test `apps/single-workspace/test/p14-real-provider-conversation.test.ts` exercises the OpenAI-compatible adapter and request serialization, but injects a custom fetch for `http://model.test/v1` and returns fixed SSE text. It does not call Qwen or another actual model, and its expected answer is predetermined.
- **Evidence:** `apps/single-workspace/test/p14-real-provider-conversation.test.ts` (`OpenAICompatibleFetchClient`, custom `fetch`, constant `assistantAnswer`); `packages/model-context/test/p3-eval.test.ts`.
- **State distinction:** **DESIGNED:** real-model scenario evaluation is a later goal, not part of this authorized phase. **IMPLEMENTED:** provider-shaped integration request/response path. **TESTED:** mocked transport and deterministic persistence. **BEHAVIORALLY VERIFIED:** no.
- **Why it matters:** Provider compatibility is useful infrastructure evidence, but it cannot establish sustained conversation, task understanding, or prompt-caused behavior.

### F-05 — The P3 “behavioral eval” suite is a deterministic contract/hash check

- **Severity / tags:** HIGH — `BEHAVIORAL_GAP`, `UNTESTABLE_WITH_CURRENT_OBSERVABILITY`.
- **Finding:** P3’s `CaseRunner` is `(evalCase) => boolean`; the default `programCaseRunner` looks up a program and compares its contract hash to the expected hash. P6/P8 gates check text hash, header/version, required clauses, and forbidden phrases. These are useful static/contract gates, not scripted model behavior and not real behavioral evals.
- **Evidence:** `packages/model-context/src/eval.ts` (`CaseRunner`, `programCaseRunner`, `P3_EVAL_SUITES`); `packages/model-context/test/p3-eval.test.ts`; `packages/agent-runtime/test/p6-prompt-programs.test.ts`; `p8-programs.test.ts`.
- **State distinction:** **DESIGNED:** P3 contract names a shared eval harness. **IMPLEMENTED:** deterministic suite/hash runner. **TESTED:** deterministic harness and static clause gates. **BEHAVIORALLY VERIFIED:** zero mapped programs found with scenario + prompt variant + actual model + scored observation.
- **Why it matters:** Counts and release notes must not label static prompt-presence checks as behavioral evidence.

### F-06 — Query read-only behavior has a prompt clause, but the activation/capability boundary is unproven

- **Severity / tags:** HIGH — `BEHAVIORAL_GAP`, `PROMPT_OVERREACH` (conditional), `AMBIGUOUS_DECISION_BOUNDARY`.
- **Finding:** `p8-query-inspection` says “This execution is read-only” and forbids canonical mutation at the text layer. `ModelContext.prepareTurn` normally exposes `ToolCatalogPort.visibleRefs()` unless tools are explicitly disabled, while no production Query-family activation or Query-specific read-only tool filter was identified. Because the Program itself was not found loaded, the evidence does **not** prove an active prompt-only safety failure; it does show that text alone is not evidence of a read-only capability boundary.
- **Evidence:** `packages/agent-runtime/promptPrograms/query-inspection/v1.md`; `packages/model-context/src/prepare-turn.ts` (tool exposure); `packages/agent-runtime/src/prompt-programs.ts`; P8 `05-query-program.md`; P12 `07-toolcatalog-model-facing.md`.
- **State distinction:** **DESIGNED:** query is intended to be read-only. **IMPLEMENTED:** text artifact, registry, general tool catalog. **TESTED:** static negative phrase checks and general tool-authority tests. **BEHAVIORALLY VERIFIED:** no model Query execution test; Query-specific capability set not established from the inspected path.
- **Why it matters:** Read-only is a hard capability boundary and should not depend on compliance with a natural-language sentence. Scope-restatement style should also remain isolated from ordinary Human Conversation.

### F-07 — Several prompt clauses repeat runtime-owned boundaries; overlap is not itself proof of a defect

- **Severity / tags:** MEDIUM — `PROMPT_OVERREACH` candidate / observation.
- **Finding:** Formation text reiterates the first-layer human gate; Communication text reiterates that sending is not confirmation and a Report is not a delivery/dependency satisfaction; Human Steer text reiterates severity and critical-stop sequencing; Verification text reiterates exact verdict/evidence structure. Corresponding command, dependency, authority, or output-shape checks exist in P6/P7/P8/P12 contracts and tests. Text can still guide a semantic choice, but it must not become the only guard for the mechanical half.
- **Evidence:** `packages/agent-runtime/promptPrograms/{formation,communication,human-steer,verification}/v1.md`; `tests/p6-formation-governance.test.ts`, `tests/p7-satisfy-dependency.test.ts`, `tests/p8-acceptance.test.ts`, `tests/p12-runtime-safety.test.ts`.
- **State distinction:** The frozen design says hard invariants are enforced by Runtime. Static prompt gates prove the reminders remain present, not that they are the enforcement mechanism.
- **Question:** Which repeated clauses are explanatory decision policy, and which are intended to carry an invariant that already has a mechanical guard?

### F-08 — Query scope wording may leak into ordinary conversation if activation is too broad

- **Severity / tags:** MEDIUM — `AMBIGUOUS_DECISION_BOUNDARY`.
- **Finding:** `query-inspection/v1.md` requires every query to restate the question and declare inspected/in-scope surfaces. S1 separately describes multi-turn high-level discussion; S2 describes user browsing as observation. The frozen scenarios do not say that every Human Conversation is a Query execution. If these families are ever co-activated broadly, the clause could make ordinary replies repetitive/formal.
- **Evidence:** S1.4 steps 1–2; S2.4 steps 1–4; `packages/agent-runtime/promptPrograms/query-inspection/v1.md`; no production activation call site found.
- **State distinction:** This is a risk hypothesis, not an observed user-facing regression. Current evidence does not show the Query text in Root Conversation requests.

### F-09 — Frozen scenario version labels disagree

- **Severity / tags:** LOW — observation.
- **Finding:** `docs/design/01-scenarios.md` header identifies Scenarios v1.2/FROZEN, while its final “场景覆盖结论” line says FROZEN / COMPLETE (v1.1).
- **Evidence:** Same file header and closing section.
- **State distinction:** This map follows the v1.2 header/source contents and does not alter the frozen document.

## Direct answers

1. **Decision points:** 49 total — S1 13, S2 7, S3 16, S4 13.
2. **Owner counts:** 8 DETERMINISTIC, 31 MODEL_DECISION, 10 MIXED.
3. **Points needing LLM semantic judgment:** 41 (31 MODEL_DECISION + the model half of 10 MIXED). Eight mechanical branches are excluded from behavioral scoring.
4. **Atomic modules:** 12, in `05-atomic-module-map.md`.
5. **Fully mechanical scoring:** No complete semantic model-judgment module is fully mechanically scoreable. Mechanical subcontracts include M02 first-layer gate/proposal shape; M04 claim/verdict shape, evidence identity, and dispatch; M07 exact authority/critical command; M08 correlation/message schema; M09 dependency satisfaction/wake; M10 no-blind-replay and recovery identity; M11 persistence/revision invalidation; M12 explicit UI read-only boundary. Those tests do not score adjacent model judgment.
6. **Partial LLM/human scoring:** M01–M08, M09’s independent-work choice, M10’s recovery/evidence choice, M11’s relevance/staleness choice, and M12’s conditional Query answer relevance. Use deterministic checks for output shape/source bindings and human/LLM rubric judgment for semantic correctness.
7. **Prompt support by module:** M02 `p6-formation`; M03 P3 WorkExecution slot contract; M04 `p8-verification` plus P3 completion slot; M05 P3 work/responsibility slots and `p6-communication`; M06 `p6-human-steer`; M07 `p6-human-steer`/`p6-communication`; M08 `p6-communication`; M09 no dedicated prompt; M10 no general recovery prompt (P3 repair is narrower); M11 P3 Continuation/Compaction slot contracts only; M12 `p8-query-inspection`. P6 Bootstrap has a text artifact for initial child cognition but no separate S1–S4 decision point that proves its activation. **Prompt support does not imply production connection.**
8. **Unsupported semantic areas:** Conversation readiness/style (M01), Parent sufficiency/integration (M05), message-kind choice and dependency-vs-query boundary (M08/M09), post-denial recovery and general failure/Unknown handling (M03/M10), long-term context/staleness (M11), and Query activation/scope (M12) have no identified dedicated, production-connected prompt support. Several have declared candidate artifacts or contract-only slots; none has real behavioral evaluation coverage identified here.
9. **Runtime-overlap candidates:** First-layer gate, authority/critical-stop execution, dependency satisfaction, evidence/verification identity/shape, read-only capability, persistence/wake/replay guards are Runtime responsibilities. Prompt reminders can guide semantic recognition, but cannot be counted as their enforcement. F-06 is the clearest conditional `PROMPT_OVERREACH` risk.
10. **First model API evaluations:** After input/activation evidence is observable, prioritize formation decisions (M02), work-action selection (M03), producer completion/verifier judgment (M04), Parent sufficiency (M05), human correction absorption (M06), and critical/ordinary steer classification (M07). Keep the matching deterministic Runtime checks outside those scores.
11. **Minimum S1/S2 first batch:** M01 readiness; M02 first-layer/deeper formation; M03 work-loop next action; M04 completion/verification; M05 parent sufficiency/stage completion; M06 steer absorption/autonomy; M07 normal-vs-critical and ownership-scope decisions. Explicit approval and stop gates remain mechanical tests.
12. **S3/S4 second batch:** M08 communication-kind selection, M09 dependency/continue/wait, M10 retry/Unknown/reconciliation, M11 continuation/staleness, and conditional M12 Query discipline. S3’s exact authority/permission and dependency satisfaction portions remain mechanical from the first batch onward.

## Prompt-family and runtime snapshot

| Family / artifact | Scenario role | Text in repository | Runtime activation observed | Existing validation | Main risk |
|---|---|---|---|---|---|
| BaseAgentProtocol | General agent/output slots | P3 contract only | Current driver selects it for Human Conversation | Slot/hash contract tests | No text body; no dedicated conversation policy |
| ResponsibilityBoundProtocol | Responsibility/resource boundary slots | P3 contract only | No selection in inspected driver path | Slot contract tests | Semantic boundary may be absent from actual context |
| WorkExecutionProgram | Work objective/constraints/completion/outcome-gap slots | P3 contract only | Current driver selects it for non-Conversation execution | Slot/hash/compiler tests | Current fragment may carry an unresolved reference instead of objective text |
| CompactionProgram / ContinuationProgram | Checkpoint/recovery context | Compaction contract only; Continuation family is type/slot-level | No production compaction ProviderTurn observed in inspected driver | Static/context/compaction tests | Durable continuity is not proof of model-visible work pulse |
| ResponsibilityFormationProgram | Formation | Full `p6-formation/v1.md` | Registered; no production load call found | Static hash/version/clause gates; scripted acceptance | Split/no-split quality unverified |
| CommunicationProgram | Query/Report/DecisionRequest/Reply and message discipline | Full `p6-communication/v1.md` | Registered; no production load call found | Static gates and command stories | Message choice/content behavior unverified |
| BootstrapHandoffProgram | Initial child cognition | Full `p6-bootstrap/v1.md` | Registered; no production load call found | Static gates | Actual source filtering/provenance must be runtime-enforced |
| HumanInteractionProgram | Correction/steer/autonomy | Full `p6-human-steer/v1.md` | Registered; no production load call found | Static clauses and steer stories | Natural-language classification/absorption unverified |
| VerificationProgram | Verifier investigation/verdict | Full `p8-verification/v1.md` | Registered; no production load call found | Static gates and scripted verifier stories | Verdict quality/effort appropriateness unverified |
| QueryProgram | Read-only query/inspection | Full `p8-query-inspection/v1.md` | Registered; no production load call found | Static gates and negative phrase checks | No identified Query-specific capability/activation path |

The current untracked P14 adapter test is a canned HTTP/SSE integration fixture, not an actual-model test. The “real model” question remains open until a scenario is run against the intended local model and the compiled request, output, and score are captured.

## Questions for human review

1. Does the 49-point map capture every S1–S4 branch that changes later behavior, especially the Parent’s sufficiency judgment and unknown-effect recovery?
2. Should readiness-to-start and stage-completion be separate behavioral modules from WorkExecution, or are any points too granular?
3. Does S3 distinguish Query (observation), dependency (required outcome), and DecisionRequest (ruling) at the intended semantic boundary?
4. Is the Query/Inspection module actually part of S1–S4 agent behavior, or only a separate execution family whose activation belongs to another scenario/contract?
5. What is the intended production activation path for the six registered P6/P8 text artifacts?
6. Which exact Runtime surfaces must be captured in an eval manifest so a failed behavior can be attributed to selection, missing input, model output, or command enforcement?
7. Does S4’s promised continuity mean Session transcript inclusion, a structured checkpoint/work pulse, or a combination? Current tests do not answer what the provider sees.
8. Should the existing `p8-verification` requirement for a plan and a counterexample on every criterion apply uniformly to all mission sizes, or is that effort policy not frozen by the scenario?
9. Is a “strongly worded” human correction ever sufficient evidence for Critical severity without an explicit stop instruction? The scenario describes high-risk direction errors but leaves the classifier boundary open.
10. Are the design/status counts in this map still valid after comparing the dirty working-tree runtime changes to the intended clean baseline?

## STOP record

This phase produced only the eight authorized Markdown files under `planning/behavioral-eval/`. It created no scenario cases, implementation plan, runner, prompt/runtime change, or model API request. Human review is the next authorized decision point.
