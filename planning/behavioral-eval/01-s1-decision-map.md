# S1 — normal progress on long-running work

Source: `docs/design/01-scenarios.md` §§S1.1–S1.5, especially S1.3 and S1.4 steps 1–13. Runtime references: DID v1.17 §§3, 6, 8–9; P3, P5, P6, and P8 contracts listed in `00-scenario-decision-method.md`.

## Decision points

### S1-DP01 — Is the work ready to leave high-level discussion?

- **Source:** S1.3; S1.4 step 2.
- **Situation / decision:** A user and Main Agent have discussed the goal; decide whether a direction-setting ambiguity still prevents practical progress.
- **Possible outcomes:** Continue discussion; begin work-organization judgment.
- **Owner:** MODEL_DECISION.
- **Deterministic enforcement:** Runtime can accept/record human messages and admit an execution; it cannot determine semantic sufficiency of the shared understanding.
- **Model judgment:** Decide whether a remaining ambiguity changes the overall direction enough to ask for clarification.
- **Required inputs:** Goal, stated constraints, relevant supplied materials, unresolved questions, and any prior agreed direction.
- **Observable output:** Clarifying question / continued discussion, or a proposal/action that starts organizing work.
- **Existing Prompt Program:** Human interaction / Base protocol are plausible owners; no text-backed HumanInteractionProgram was found. The production driver’s current human-message path selects `BASE_AGENT_PROTOCOL`; it does not load a dedicated conversation program.
- **Existing Runtime surface:** P14 `SubmitHumanMessage` / conversation trigger and Coordination execution; `packages/agent-runtime/src/driver.ts`.
- **Current tests:** `tests/p14-conversation-trigger.test.ts`, `tests/p14-human-message.test.ts` cover admission and storage, not this judgment; no behavioral model test identified.
- **Behavioral Test Candidate:** YES — **CORE**. It determines whether conversation remains exploratory or starts work.
- **Why:** Score whether the model asks only for decision-relevant clarification and does not form work merely because a goal was mentioned.

### S1-DP02 — Is first-layer division worth proposing?

- **Source:** S1.3; S1.4 step 3.
- **Situation / decision:** Work is sufficiently clear to begin; decide whether one Main Agent should do it or propose separate first-layer responsibilities.
- **Possible outcomes:** Main Agent does the work; propose a first-layer division.
- **Owner:** MODEL_DECISION.
- **Deterministic enforcement:** Runtime can validate proposal shape and enforce the later human gate; it cannot score independence, parallel value, isolability, working-style difference, or single-agent cost.
- **Model judgment:** Weigh the five explicit criteria and avoid splitting merely because the task is large or complex.
- **Required inputs:** Work outcome, constraints, dependencies, context boundaries, expected coordination cost, and available parallelism.
- **Observable output:** No proposal, or a `ChildWorkspaceProposal` with rationale tied to the criteria.
- **Existing Prompt Program:** `p6-formation` text artifact (`packages/agent-runtime/promptPrograms/formation/v1.md`); plausible and explicitly scenario-aligned, but no production loader call site was found.
- **Existing Runtime surface:** Formation proposal/plan/consumer and `CreateChildWorkspace` / `AssignWork`; `packages/application/src/formation-plan.ts`, `formation-consumer.ts`; P6 `01`, `03`.
- **Current tests:** `tests/p6-formation-governance.test.ts`, `p6-formation-consumer.test.ts`, `p6-acceptance.test.ts` exercise proposal and governance contracts, not model selection quality.
- **Behavioral Test Candidate:** YES — **CORE**. This is the central S1 split/no-split judgment.
- **Why:** Contrast complex-but-serial work with genuinely independent work; score the decision and rationale separately.

### S1-DP03 — May a first-layer proposal take effect?

- **Source:** S1.3; S1.4 step 4.
- **Situation / decision:** A first-layer proposal exists; decide whether it becomes active.
- **Possible outcomes:** Human confirms, adjusts, or rejects/re-divides it; only an authorized decision permits effect.
- **Owner:** DETERMINISTIC.
- **Deterministic enforcement:** Runtime binds `RecordDecision` to the exact proposal and revision and does not activate the proposal without the human decision.
- **Model judgment:** The proposing model explains the proposed division; it does not decide the human gate.
- **Required inputs:** Exact proposal/revision, proposal rationale and fields, authenticated human decision.
- **Observable output:** A revision-bound decision and corresponding accepted/rejected/adjusted canonical transition.
- **Existing Prompt Program:** `p6-formation` says to anticipate the human gate; the actual gate is not a prompt responsibility.
- **Existing Runtime surface:** P6 FormationProposal governance, `RecordDecision`, approval consumer; P6 `01` and `03`.
- **Current tests:** `tests/p6-formation-governance.test.ts`, `tests/p6-formation-consumer.test.ts`, `tests/p6-acceptance.test.ts`; static prompt gate in `packages/agent-runtime/test/p6-prompt-programs.test.ts`.
- **Behavioral Test Candidate:** NO — **NOT_BEHAVIORAL** for the gate. Test exact binding, authorization, and transitions mechanically; evaluate proposal quality at DP02.
- **Why:** The decisive branch is an explicit human command plus runtime-enforced preconditions.

### S1-DP04 — Should a deeper Workspace do work itself, serially delegate, or parallelize?

- **Source:** S1.3; S1.4 steps 5–6.
- **Situation / decision:** A Workspace has a bounded local responsibility and may split it further.
- **Possible outcomes:** Work locally; create serial sub-work; create parallel sub-work.
- **Owner:** MODEL_DECISION.
- **Deterministic enforcement:** Runtime checks the authority/resource ceiling and creates accepted child/work records; it cannot determine whether the split improves the result.
- **Model judgment:** Apply the formation criteria inside the local responsibility; distinguish dependency from formation.
- **Required inputs:** Responsibility and revision, resource boundary, local outcome, candidate sub-outcomes, dependencies, and coordination cost.
- **Observable output:** Work directive, serial proposal, or parallel proposal; accepted child creation is separately runtime-observable.
- **Existing Prompt Program:** `p6-formation` text artifact; production loading was not found.
- **Existing Runtime surface:** Deep-layer formation, capability-ceiling validation, `CreateChildWorkspace` / `AssignWork`; P6 `01`, `03`; `tests/p6-deep-formation.test.ts`.
- **Current tests:** `tests/p6-deep-formation.test.ts`, `p6-ceiling.test.ts`, `p6-acceptance.test.ts` prove mechanical formation/authority paths with scripted directives.
- **Behavioral Test Candidate:** YES — **CORE**. It recurs recursively and has different tradeoffs from first-layer human review.
- **Why:** Measure correct own/serial/parallel selection under explicit authority limits; do not score successful command execution as evidence of good judgment.

### S1-DP05 — What is the next work-loop action, including whether to claim completion?

- **Source:** S1.3; S1.4 steps 5–9.
- **Situation / decision:** The agent has a current responsibility and observations from prior actions; decide how to advance or whether the completion expectation appears met.
- **Possible outcomes:** Plan, act, gather evidence, inspect result, revise, continue, or issue a completion claim.
- **Owner:** MODEL_DECISION.
- **Deterministic enforcement:** Runtime decodes allowed directives, checks freshness and authority, executes supported handlers, caps turns, and treats a completion claim as a trigger; it cannot determine whether the next action is substantively useful or the outcome is actually met.
- **Model judgment:** Select a relevant next step; preserve progress; claim only when the completion expectation is supported.
- **Required inputs:** Objective, why, constraints, completion expectation, current frontier, prior observations, and available tools.
- **Observable output:** Directive(s), claim, or text response; subsequent Runtime observations make effects visible.
- **Existing Prompt Program:** P3 `WorkExecutionProgram` slot contract names WorkObjective, WorkConstraints, CompletionExpectation, OutcomeGap; no versioned body. P6 formation applies only when splitting.
- **Existing Runtime surface:** `packages/agent-runtime/src/driver.ts`, directive decoder/handlers, `packages/application/src/commands/`; P3 `03`, P5 `02–03`.
- **Current tests:** `apps/single-workspace/test/p5-slice-acceptance.test.ts`, `p5-completion-claim.test.ts`, `tests/p12-acceptance.test.ts`; fixed provider outputs test pipeline handling, not action selection.
- **Behavioral Test Candidate:** YES — **CORE**. This is the repeated autonomy loop.
- **Why:** Score progress-relevant actions, unnecessary waiting, premature claims, and failure to use available evidence.

### S1-DP06 — How does newly arriving work relate to the active responsibility?

- **Source:** S1.4 step 8; S2 cross-reference.
- **Situation / decision:** A Workspace is busy when a new human or Parent input arrives.
- **Possible outcomes:** Absorb relevant guidance at a safe boundary; preserve independent work for later; route an immediate direction/stop change through S2.
- **Owner:** MIXED.
- **Deterministic enforcement:** Message origin, command type, execution state, and stop/steer controls are runtime facts; Runtime must not hard-preempt ordinary input.
- **Model judgment:** Determine semantic relevance to the active work and what can be deferred without losing continuity.
- **Required inputs:** Active objective/frontier, new message, source/authority, urgency/steer kind if present, and already completed work.
- **Observable output:** Updated next action, retained queued work, or a steer/stop path; inspect both the model decision and the runtime admission/queue event.
- **Existing Prompt Program:** `p6-human-steer` is a candidate for genuine correction; `p6-communication` governs inter-Workspace messages. Neither was found loaded by production source.
- **Existing Runtime surface:** P6 `SteerWork`, `CriticalSteer`, Inbox promotion, P14 human message; `tests/p6-steer.test.ts`, `p6-critical-steer.test.ts`.
- **Current tests:** Scripted steer/inbox tests cover storage, routing, and interruption mechanics; no model relevance/absorption eval identified.
- **Behavioral Test Candidate:** YES — **EDGE**. It is less common than normal work-loop choice but directly tests interruption and continuity boundaries.
- **Why:** Use paired cases where an instruction changes the current line, is independent future work, or requires explicit stop handling.

### S1-DP07 — Once a completion claim is emitted, does formal verification start?

- **Source:** S1.4 step 9 and its PASS/FAIL/Unknown branches.
- **Situation / decision:** Runtime receives a `CompletionClaimed` settlement.
- **Possible outcomes:** Start the bound verification; recover/replay the consumer idempotently; do not silently treat the claim as accepted completion.
- **Owner:** DETERMINISTIC.
- **Deterministic enforcement:** The completion consumer starts verification for the bound Work/revision; idempotency and exact revision binding are runtime/application responsibilities.
- **Model judgment:** None at this transition. Whether the producer should claim is included in DP05; verifier judgment is DP08.
- **Required inputs:** Completion claim, Work id/revision, verification mission, execution settlement, and durable consumer state.
- **Observable output:** Verification record and verifier Execution, or a tested idempotent no-op/recovery path.
- **Existing Prompt Program:** `p8-verification` is a candidate for the spawned verifier; production selection/loading is not established.
- **Existing Runtime surface:** `packages/application/src/completion-consumer.ts`, `start-verification.ts`, verification consumer; P8 `01–03`.
- **Current tests:** `apps/single-workspace/test/p5-completion-claim.test.ts`, `tests/p8-consumer-a.test.ts`, `p8-acceptance.test.ts`.
- **Behavioral Test Candidate:** NO — **NOT_BEHAVIORAL** for dispatch. Test consumer, binding, and replay behavior mechanically; assess judgment at DP05/DP08.
- **Why:** The claim-to-verification transition has a canonical event and deterministic consumer.

### S1-DP08 — Is the result PASS, FAIL, or not reliably judgeable?

- **Source:** S1.4 step 9; PASS, FAIL, and “无法可靠判断” branches.
- **Situation / decision:** A Verifier examines a producer’s claimed result against the mission.
- **Possible outcomes:** PASS with sufficient positive evidence; FAIL with evidence of unmet requirements; Unknown when evidence or environment is insufficient.
- **Owner:** MODEL_DECISION.
- **Deterministic enforcement:** Runtime validates exact verification identity/revision, required evidence bindings, and verdict shape/aggregation; it cannot decide semantic adequacy of evidence.
- **Model judgment:** Map observations to mission criteria; avoid converting “no problem found” into PASS.
- **Required inputs:** Frozen mission criteria, target Work revision, producer result, direct observations/artifacts, environment state, and evidence provenance.
- **Observable output:** Criterion-level verdicts with evidence references, then an aggregate verdict accepted by Runtime if structurally valid.
- **Existing Prompt Program:** `p8-verification` text artifact; it requires a plan, evidence ordering, tri-valued verdicts, counterexamples, and evidence references. No production loader call site found.
- **Existing Runtime surface:** Verifier execution, `RecordVerificationEvidence`, `ConcludeVerification`; P8 `01`, `02`, `04`.
- **Current tests:** `tests/p8-acceptance.test.ts`, `p8-conclude.test.ts`, `p9-harness.test.ts`; the former tests contract aggregation and the latter uses controlled test drivers, not a real model.
- **Behavioral Test Candidate:** YES — **CORE**. This is a central quality decision.
- **Why:** Score false PASS, false FAIL, and appropriate Unknown independently; preserve runtime tests for evidence identity and binding.

### S1-DP09 — What should happen after FAIL or Unknown?

- **Source:** S1.4 step 9.
- **Situation / decision:** Verification did not produce an actionable PASS.
- **Possible outcomes:** Producer repairs against failure evidence; gather missing evidence/change check for Unknown; request an upstream ruling when not reliably decidable.
- **Owner:** MODEL_DECISION.
- **Deterministic enforcement:** Runtime routes verification conclusions and authorized commands; it does not choose the useful repair or evidence plan.
- **Model judgment:** Distinguish a defect from missing evidence and select a response that preserves the existing work thread.
- **Required inputs:** Criterion-level verdicts, evidence/missing-evidence references, producer frontier, available tools, and unresolved authority boundary.
- **Observable output:** Revised work action, evidence-gathering action, or a bounded DecisionRequest.
- **Existing Prompt Program:** `p8-verification` constrains verifier reporting; P3 WorkExecution slot contract has OutcomeGap; no dedicated repair-policy text was found.
- **Existing Runtime surface:** Verification return/wake and Work Execution; P8 `03`, P9 recovery contracts.
- **Current tests:** `tests/p8-consumer-a.test.ts`, `p9-recovery-driver.test.ts`, `p9-harness.test.ts`; tests exercise fixed verdicts and recovery wiring, not repair judgment.
- **Behavioral Test Candidate:** YES — **EDGE**. FAIL/Unknown are less frequent than PASS but consequential.
- **Why:** Contrast repairable failure, insufficient evidence, and unavailable environment; score whether the response fits the actual reason.

### S1-DP10 — Does a PASS result suffice for the Parent’s own responsibility?

- **Source:** S1.4 step 10.
- **Situation / decision:** A valid local result passed quality verification; Parent must decide whether it supports the parent-level outcome.
- **Possible outcomes:** Accept and integrate; request/create supplementary work while retaining the child result’s PASS status.
- **Owner:** MODEL_DECISION.
- **Deterministic enforcement:** Runtime can distinguish verification PASS from Parent acceptance and require exact authority/revision for acceptance; it cannot know whether the Parent has enough information.
- **Model judgment:** Assess sufficiency against the parent outcome, not re-litigate the child’s quality verdict.
- **Required inputs:** Parent objective/completion expectation, child result and evidence summary, dependencies, and known gaps.
- **Observable output:** Accept/integrate, or a specific additional-work proposal/request.
- **Existing Prompt Program:** P3 WorkExecution / ResponsibilityBound slot contracts are possible surfaces; no dedicated parent-sufficiency family or text artifact.
- **Existing Runtime surface:** `AcceptWorkOutcome`, Work lifecycle, formation/assignment commands; P8 `01`, `05`.
- **Current tests:** `tests/p8-acceptance-commands.test.ts`, `p8-acceptance.test.ts` validate authority and canonical preconditions; they do not evaluate semantic sufficiency.
- **Behavioral Test Candidate:** YES — **CORE**.
- **Why:** It tests the scenario’s explicit separation between “locally correct” and “enough for the parent.”

### S1-DP11 — What should be carried upward from a child result?

- **Source:** S1.4 step 11.
- **Situation / decision:** A Parent integrates a child result and decides what information is relevant to its own work and higher levels.
- **Possible outcomes:** Preserve conclusion, key basis, impact, and unresolved issues; keep low-level logs local; escalate only information needed above.
- **Owner:** MODEL_DECISION.
- **Deterministic enforcement:** Runtime routes results through the parent/inbox/verification surfaces; it does not determine which facts matter to the parent’s outcome.
- **Model judgment:** Condense without omitting decision-critical evidence or flooding higher levels with irrelevant transcript/tool detail.
- **Required inputs:** Child result, evidence references, Parent objective, current blockers, and relevant prior decisions.
- **Observable output:** Bounded parent-facing summary/report and any retained unresolved question.
- **Existing Prompt Program:** `p6-communication` governs Report/Reply/DecisionRequest kind and bounded summary; `p6-bootstrap` concerns child initial cognition, not upward summarization. No loader call site found.
- **Existing Runtime surface:** `SendMessage`, Message/Inbox projections, report and correlation lifecycle; P6 `02`.
- **Current tests:** `tests/p6-send-message.test.ts`, `p6-acceptance.test.ts` test payload/routing contracts, not summary quality.
- **Behavioral Test Candidate:** YES — **EDGE**.
- **Why:** Compare concise summaries for decision sufficiency and information leakage/omission.

### S1-DP12 — Has the current overall stage reached its requirement?

- **Source:** S1.3; S1.4 step 12.
- **Situation / decision:** Main Agent has received and integrated current first-layer results.
- **Possible outcomes:** Continue the stage, create new work, revisit an existing responsibility, or present the stage result to the user.
- **Owner:** MODEL_DECISION.
- **Deterministic enforcement:** Runtime can expose Work state and verification/acceptance facts; no single status mechanically captures the user’s overall stage goal.
- **Model judgment:** Determine whether the combined result meets the agreed high-level outcome or leaves material gaps.
- **Required inputs:** Agreed stage goal, first-layer results and bases, open Work, dependencies, and user constraints.
- **Observable output:** New work/continued work or a user-facing stage summary.
- **Existing Prompt Program:** WorkExecutionProgram slot contract is a possible source; no dedicated stage-completion text.
- **Existing Runtime surface:** WorkspaceMain/Coordination and Work execution; P14 `02`; P5/P8 result surfaces.
- **Current tests:** `tests/p14-conversation-trigger.test.ts`, P5/P8 acceptance tests cover execution/canonical status, not semantic stage completion.
- **Behavioral Test Candidate:** YES — **CORE**.
- **Why:** This is the stage-level counterpart to DP10 and prevents premature user-facing closure.

### S1-DP13 — After a stage result, what is the appropriate next high-level move?

- **Source:** S1.4 step 13.
- **Situation / decision:** Main Agent has summarized an achieved stage to the user.
- **Possible outcomes:** Wait for a new goal, discuss the next stage, accept a change in direction, or pause as the user chooses.
- **Owner:** MODEL_DECISION.
- **Deterministic enforcement:** Runtime can retain the conversation and wait for user input; it cannot choose the useful conversational next move.
- **Model judgment:** Provide a clear, proportional handoff without inventing authorization for the next stage.
- **Required inputs:** Achieved result, remaining possibilities/gaps, prior user direction, and explicit current user message if one exists.
- **Observable output:** Bounded summary or question; no new canonical work without its required authority.
- **Existing Prompt Program:** No text-backed HumanInteractionProgram was found; P3 BaseAgentProtocol is only a slot contract.
- **Existing Runtime surface:** P14 conversation input, Coordination focus, `SubmitHumanMessage`; P14 `01–03`.
- **Current tests:** `tests/p14-human-message.test.ts`, `p14-conversation-trigger.test.ts` test trigger/storage, not reply usefulness or authorization restraint.
- **Behavioral Test Candidate:** YES — **CORE**.
- **Why:** It directly shapes the ordinary user-facing conversation and should be distinguished from Query/Inspection ritual.

## S1 evidence interpretation

P6 formation contracts and P8 verification contracts provide static and runtime structure around important S1 choices. Neither their contract tests nor the P5/P8 scripted stories demonstrate that a real model makes these choices well. S1’s highest-value behavioral candidates are DP01/02/04/05/08/10/12/13; the human gate at DP03 and completion-consumer transition at DP07 remain mechanical.
