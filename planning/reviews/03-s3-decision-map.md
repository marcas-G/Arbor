# S3 — collaboration, dependencies, and failures

Source: `docs/design/01-scenarios.md` §§S3.1–S3.5, especially S3.3 and S3.4 steps 1–14. Related contracts: P6 communication/delegation, P7 dependencies/wait graph/wake, P8 verification, P9 recovery, P12 authority and runtime safety.

## Decision points

### S3-DP21 — Can the current agent solve the issue within its own responsibility?

- **Source:** S3.3; S3.4 steps 1 and 5.
- **Situation / decision:** Local work encounters a question or obstacle.
- **Possible outcomes:** Research/adjust/use tools locally; subdivide within authority; ask another Workspace; request Parent judgment.
- **Owner:** MODEL_DECISION.
- **Deterministic enforcement:** Runtime knows binding, responsibility, boundary, and available capabilities; it cannot judge whether the issue is semantically tractable locally.
- **Model judgment:** Decide if further local effort is likely to resolve the issue without crossing responsibility/authority.
- **Required inputs:** Responsibility and revision, resource boundary, work objective, attempted approaches, available tools, and current blocker.
- **Observable output:** Local action/formation proposal or a specific outward request.
- **Existing Prompt Program:** P3 ResponsibilityBound slot contract and P6 formation/communication texts are candidate surfaces; no dedicated autonomy/escalation program is connected in inspected source.
- **Existing Runtime surface:** WorkspaceMain/ExecutionBound binding, resource-boundary/authority projection; P6/P7 commands.
- **Current tests:** `tests/p6-deep-formation.test.ts`, `p6-ceiling.test.ts`, `p4-authority.test.ts` cover mechanics, not tractability judgment.
- **Behavioral Test Candidate:** YES — **CORE**.
- **Why:** It is the S3 form of “solve locally first” and controls needless escalation.

### S3-DP22 — Is the need a Query, a dependency on an outcome, or a different message?

- **Source:** S3.4 steps 2 and 5–7; P6 message kinds provide implementation vocabulary, not new scenario semantics.
- **Situation / decision:** Agent needs another Workspace’s observation, result, ruling, or answer.
- **Possible outcomes:** Ask for an observation (Query); represent a needed result as dependency; ask for a ruling (DecisionRequest); expose a finding (Report); answer a correlated request (Reply).
- **Owner:** MODEL_DECISION.
- **Deterministic enforcement:** Runtime validates message kind/shape, correlation id, target authority, and dependency lifecycle; it cannot choose the semantically appropriate communication intent.
- **Model judgment:** Select only the kind matching the actual need and avoid using a message as an implicit delivery or dependency satisfaction.
- **Required inputs:** What is missing, who can supply it, whether an answer or deliverable is required, existing correlation/dependency, and parent/peer relationship.
- **Observable output:** Typed message or dependency command with bounded summary and references.
- **Existing Prompt Program:** `p6-communication` text artifact; P8 `p8-query-inspection` is a separate read-only query discipline. No production loader call site found.
- **Existing Runtime surface:** `SendMessage`, Query/Report/DecisionRequest/Reply validation, `DeclareDependency`; P6 `02`, P7 `01`.
- **Current tests:** `tests/p6-send-message.test.ts`, `p6-acceptance.test.ts`, `p7-declare-dependency.test.ts`; scripted kind/payload cases, not semantic selection.
- **Behavioral Test Candidate:** YES — **CORE**.
- **Why:** The same surface can be misused when the model confuses “need a fact,” “need an outcome,” and “need a ruling.”

### S3-DP23 — Has the declared dependency actually become satisfied?

- **Source:** S3.3; S3.4 steps 2–4 and 14.
- **Situation / decision:** Work is waiting on a dependency or a result has arrived.
- **Possible outcomes:** Keep waiting while the canonical condition is false; wake/re-enter only when the condition is satisfied; reject an unrelated Report as satisfaction.
- **Owner:** DETERMINISTIC.
- **Deterministic enforcement:** Dependency state transitions and satisfaction are evaluated from canonical dependency/deliverable state; correlation/report receipt alone is not satisfaction.
- **Model judgment:** None for the state predicate; semantic choice about what dependency to declare is DP22.
- **Required inputs:** Dependency id/revision, producer/consumer relationship, required deliverable, and canonical satisfaction transition.
- **Observable output:** Dependency transition and corresponding wake eligibility.
- **Existing Prompt Program:** `p6-communication` says Report is not delivery; that reminder does not own satisfaction.
- **Existing Runtime surface:** P7 dependency transitions, coordinator satisfaction, wait graph, and wake integration.
- **Current tests:** `tests/p7-satisfy-dependency.test.ts`, `p7-dependency-transitions.test.ts`, `p7-wake-pipeline.test.ts`, `p7-deadlock.test.ts`.
- **Behavioral Test Candidate:** NO — **NOT_BEHAVIORAL**.
- **Why:** Test dependency identity, state, and wake mechanically; do not score prompt compliance for a canonical predicate.

### S3-DP24 — While a dependency is pending, is there other valid work to do?

- **Source:** S3.4 step 3.
- **Situation / decision:** One work item is blocked, but the responsibility may contain other independent work.
- **Possible outcomes:** Continue eligible independent work; wait only when no condition-satisfying work remains.
- **Owner:** MODEL_DECISION.
- **Deterministic enforcement:** Runtime can determine registered dependency/wait conditions and avoid repeated polling; semantic independence and useful alternative work are not reducible to readiness alone.
- **Model judgment:** Identify work that does not rely on the pending result and can safely advance.
- **Required inputs:** Responsibility, current work graph/frontier, dependency edge, completion requirements, and any independent work already known.
- **Observable output:** Continue with an independent action or yield/wait with the actual condition.
- **Existing Prompt Program:** P3 WorkExecution slot contract is a candidate; no text-backed wait-vs-continue program.
- **Existing Runtime surface:** P7 runnability classification, work-wait graph, Yield/wake coordinator; P7 `03–06`.
- **Current tests:** `tests/p7-coordinator.test.ts`, `p7-deadlock.test.ts`, `p7-wake-pipeline.test.ts` test graph/readiness behavior; no real-model test of semantic work independence.
- **Behavioral Test Candidate:** YES — **ADVERSARIAL**.
- **Why:** Construct a pending dependency alongside a clearly independent task; the tempting failure is to stop the whole Workspace.

### S3-DP25 — Is the current inability a reason to ask the direct Parent?

- **Source:** S3.4 steps 5–6.
- **Situation / decision:** Agent cannot reliably resolve a local issue after making relevant attempts.
- **Possible outcomes:** Continue a bounded local attempt; send a specific request to the direct Parent with the actual decision/information/resource needed.
- **Owner:** MODEL_DECISION.
- **Deterministic enforcement:** Runtime can route to the direct parent and enforce command authorization; it cannot assess whether local attempts are exhausted or the request is actionable.
- **Model judgment:** Decide that local resolution is not reliable and state why.
- **Required inputs:** Objective, blocker, attempted approaches/results, uncertainty, responsibility boundary, and the exact needed ruling/resource.
- **Observable output:** Bounded `DecisionRequest` or continued local action; never only “I am stuck.”
- **Existing Prompt Program:** `p6-communication` gives message-kind applicability; it does not specify the full minimum help-request content.
- **Existing Runtime surface:** Parent routing and message correlation; P6 `02`, P7 communication surface.
- **Current tests:** `tests/p6-send-message.test.ts`, `p6-acceptance.test.ts` validate message construction/routing, not request sufficiency.
- **Behavioral Test Candidate:** YES — **CORE**.
- **Why:** This is the scenario’s nearest-layer resolution rule and has a directly observable message.

### S3-DP26 — Does the help request contain enough context for a ruling?

- **Source:** S3.4 step 5.
- **Situation / decision:** A local agent has chosen to ask its Parent.
- **Possible outcomes:** Send a request with task, blocker, attempts, reason it cannot decide, and what is needed; gather more information before asking if these are missing.
- **Owner:** MODEL_DECISION.
- **Deterministic enforcement:** Schema can require bounded fields and references; Runtime cannot establish that natural-language rationale is decision-sufficient.
- **Model judgment:** Include the facts needed for the Parent to answer without transferring the entire transcript.
- **Required inputs:** The current task, blocker, attempted options/results, unresolved choice, and Parent’s scope.
- **Observable output:** DecisionRequest with a bounded evidence-backed body.
- **Existing Prompt Program:** `p6-communication` specifies message kinds and bodyRef/bounded summary; no dedicated help-request completeness prompt.
- **Existing Runtime surface:** `SendMessage` and message artifact/bodyRef; P6 `02`.
- **Current tests:** `tests/p6-send-message.test.ts`, `p6-acceptance.test.ts` cover structural payload/correlation only.
- **Behavioral Test Candidate:** YES — **EDGE**.
- **Why:** It isolates usefulness of the escalation payload from the separate decision to escalate.

### S3-DP27 — Can the direct Parent resolve the issue?

- **Source:** S3.3; S3.4 steps 6–7.
- **Situation / decision:** Parent receives a child’s bounded request.
- **Possible outcomes:** Resolve with ruling/information/resource/adjusted requirement; escalate to its own Parent if it cannot reliably decide.
- **Owner:** MODEL_DECISION.
- **Deterministic enforcement:** Runtime knows the parent chain and allowed governance scope; it cannot decide whether evidence and expertise suffice.
- **Model judgment:** Assess whether the request is within local scope and answerable from available information.
- **Required inputs:** Child request and evidence, Parent responsibility/boundary, relevant project context, and any higher-level policy.
- **Observable output:** Specific reply/ruling, additional information request, or next escalation.
- **Existing Prompt Program:** `p6-communication` covers DecisionRequest/Reply distinctions; no parent-resolution decision program.
- **Existing Runtime surface:** Inbox promotion/consumption, message correlation, governance routing; P6 `02`, P7 `07`.
- **Current tests:** `tests/p6-inbox-promotion.test.ts`, `p6-acceptance.test.ts`; scripted inbox/governance transitions only.
- **Behavioral Test Candidate:** YES — **EDGE**.
- **Why:** It is the semantic boundary that prevents both premature escalation and unjustified local answers.

### S3-DP28 — Does escalation preserve the original responsibility relationship?

- **Source:** S3.4 step 7.
- **Situation / decision:** Direct Parent cannot resolve and the issue must move upward.
- **Possible outcomes:** Escalate the ruling request along ancestors while keeping Parent/Child and Work ownership unchanged; request a separate governed responsibility adjustment if ownership itself must change.
- **Owner:** MIXED.
- **Deterministic enforcement:** Runtime preserves parent links and requires explicit formation/assignment/transfer commands; an escalation message cannot silently rewrite the tree.
- **Model judgment:** Decide whether the problem is only “who can rule?” or whether the responsibility arrangement itself has become unsuitable.
- **Required inputs:** Escalation reason, original owner chain, work and dependency state, and evidence that responsibility itself must change.
- **Observable output:** Correlated upward DecisionRequest or a distinct responsibility-change proposal.
- **Existing Prompt Program:** `p6-communication` says escalation is a DecisionRequest, not message urgency; `p6-formation` is the candidate for a separate responsibility proposal.
- **Existing Runtime surface:** P6 message routing and formation governance; parent relations; P6 `01–03`.
- **Current tests:** `tests/p6-acceptance.test.ts`, `p6-formation-governance.test.ts`; mechanical command boundaries are tested, semantic distinction is not.
- **Behavioral Test Candidate:** YES — **EDGE**.
- **Why:** A model may try to “solve” an escalation by changing organization, even though the scenario keeps those operations separate.

### S3-DP29 — Should a Parent request preempt its current work?

- **Source:** S3.4 step 8; S3.5 “普通通信不拥有默认硬抢占权”.
- **Situation / decision:** A child’s request arrives while Parent is busy.
- **Possible outcomes:** Queue ordinary request for a safe boundary; use a separate explicit Critical Stop path only where the high-risk condition is met.
- **Owner:** MIXED.
- **Deterministic enforcement:** Ordinary message receipt cannot itself hard-preempt; Critical Steer/Runtime Safety gates govern actual stop.
- **Model judgment:** Assess urgency/blockage and choose when to handle the request without inventing message-level interrupt semantics.
- **Required inputs:** Parent’s active work/frontier, request content, blocked child impact, explicit critical signal, and safe boundaries.
- **Observable output:** Queued/inbox disposition or separately authorized stop action.
- **Existing Prompt Program:** `p6-communication` fixes ordinary urgency at Normal and forbids text-layer preemption.
- **Existing Runtime surface:** Inbox promotion/consumption, work waits, Critical Steer; P6 `02`, `04`.
- **Current tests:** `tests/p6-inbox-promotion.test.ts`, `p6-critical-steer.test.ts`.
- **Behavioral Test Candidate:** YES — **ADVERSARIAL**.
- **Why:** Use a blocking child request while Parent is busy, then contrast ordinary urgency with an explicit critical event.

### S3-DP30 — Is the requested operation authorized and within capability?

- **Source:** S3.4 step 9.
- **Situation / decision:** An operation is proposed that may exceed current tool, resource, workspace, or approval authority.
- **Possible outcomes:** Admit only if authority/capability checks pass; otherwise reject or return a typed denial/precondition.
- **Owner:** DETERMINISTIC.
- **Deterministic enforcement:** Resolver/gateway/tool admission checks principal, capability, resource scope, binding, and any approval authority; prompt text is not authorization.
- **Model judgment:** None for whether the operation is permitted. Separately, recognizing that a denial means the goal may need another plan is DP31.
- **Required inputs:** Principal, exact command/tool target and arguments, Workspace/Execution binding, capability ceiling, resource boundary, and approval state.
- **Observable output:** Authorized effect or typed `AuthorityDenied`/capability failure.
- **Existing Prompt Program:** P3 ResponsibilityBound contract and bootstrap text describe boundaries; neither can grant authority.
- **Existing Runtime surface:** P4/P6/P12 tool and command authority resolver, gateway and capability-ceiling checks.
- **Current tests:** `packages/tool-runtime/test/p4-authority.test.ts`, `tests/p6-ceiling.test.ts`, `tests/p12-authority-resolver.test.ts`, `tests/p12-toolcatalog.test.ts`.
- **Behavioral Test Candidate:** NO — **NOT_BEHAVIORAL**.
- **Why:** The authorization result must be mechanical; test attempts including boundary violations with integration/architecture tests.

### S3-DP31 — After a permission/capability denial, what is the useful next move?

- **Source:** S3.4 step 9.
- **Situation / decision:** Runtime denies or cannot offer the requested capability.
- **Possible outcomes:** Use an allowed alternative; complete governed permission/approval flow for a concrete action; request Parent judgment; stop that branch if no safe option exists.
- **Owner:** MODEL_DECISION.
- **Deterministic enforcement:** Runtime communicates the precise denial and keeps forbidden effects blocked; it can validate a subsequent approved request.
- **Model judgment:** Preserve the outcome goal while selecting an authorized alternative or appropriately scoped escalation.
- **Required inputs:** Denial reason, authority/resource boundary, action goal, possible alternatives, approval requirements, and affected work.
- **Observable output:** Alternative action, concrete request, or explicit blocked branch.
- **Existing Prompt Program:** No dedicated permission-recovery program found; responsibility/bootstrap text may expose limits but does not provide a complete decision policy.
- **Existing Runtime surface:** Tool/command denial observation, P6 delegation/authority, P12 tool catalog/authority resolver.
- **Current tests:** `tests/p6-ceiling.test.ts`, `tests/p12-toolcatalog.test.ts`, `tests/p12-authority-resolver.test.ts` assert mechanical denials, not post-denial planning.
- **Behavioral Test Candidate:** YES — **EDGE**.
- **Why:** It distinguishes safe adaptation from repeated forbidden attempts or broad, unnecessary escalation.

### S3-DP32 — After an execution fault, retry, change method, escalate, or reconcile?

- **Source:** S3.4 step 10; S4.4 step 7 for uncertain effects.
- **Situation / decision:** Network, tool, model, method, or other execution failure occurs.
- **Possible outcomes:** Safe bounded retry/alternative method; Parent escalation if blocked; state reconciliation before replay when an external effect is uncertain.
- **Owner:** MODEL_DECISION.
- **Deterministic enforcement:** Runtime distinguishes transport retry from a new model/repair turn, applies retry/repair bounds, reports typed failures, and guards uncertain side effects.
- **Model judgment:** Choose a useful recovery method from the observed failure class and avoid presenting uncertainty as success.
- **Required inputs:** Failure type, attempt history, idempotency/effect status, remaining authority, and available alternative checks.
- **Observable output:** Retry/new method, bounded request, or reconcile/read action; the original effect identity remains traceable.
- **Existing Prompt Program:** P3 repair/retry contracts constrain output repair mechanics; no general failure-recovery text artifact was found.
- **Existing Runtime surface:** P3 driver/repair; P9 fault/recovery/outcome-unknown; P12 Runtime Safety.
- **Current tests:** `tests/p3-repair.test.ts`, `tests/p9-tool-outcome-unknown.test.ts`, `p9-provider-disconnect.test.ts`, `p9-recovery-driver.test.ts`.
- **Behavioral Test Candidate:** YES — **ADVERSARIAL**.
- **Why:** A meaningful test changes the failure evidence, including ambiguous external effects, and checks the selected recovery class.

### S3-DP33 — What should the model do when an external side effect’s outcome is unknown?

- **Source:** S3.4 step 10; S4.4 step 7.
- **Situation / decision:** A side-effecting call may have run, but the caller has no reliable completion record.
- **Possible outcomes:** Reconcile/read actual state; request help if it cannot be established; do not blindly replay.
- **Owner:** MIXED.
- **Deterministic enforcement:** Runtime/provider/command idempotency and recovery rules prevent unsafe automatic replay and preserve “unknown” rather than inventing success/failure.
- **Model judgment:** Select evidence that can establish actual state and decide when evidence remains insufficient for local continuation.
- **Required inputs:** Action identity/parameters, transport outcome, idempotency contract, external state observation, and known side effects.
- **Observable output:** Read/reconciliation request or bounded escalation; no duplicate side-effect command while outcome is unresolved.
- **Existing Prompt Program:** No dedicated text-backed unknown-outcome program found.
- **Existing Runtime surface:** P9 Unknown Outcome/rebuild recovery and P3/P12 provider/tool failure surfaces.
- **Current tests:** `tests/p9-tool-outcome-unknown.test.ts`, `p9-recovery-driver.test.ts`, `p9-recovery-visibility.test.ts`.
- **Behavioral Test Candidate:** YES — **ADVERSARIAL** for evidence choice; test no-replay separately as a runtime invariant.
- **Why:** This is a high-consequence semantic/runtime boundary and a known temptation to equate missing response with failure.

### S3-DP34 — Is the local result ready to submit for a quality check?

- **Source:** S3.4 step 11; same claim-to-verification transition as S1-DP07.
- **Situation / decision:** The producer has a local result and must decide whether its stated completion expectation is met enough to submit for independent verification.
- **Possible outcomes:** Start the bound verification and preserve the producer/Verifier distinction; do not treat claim alone as PASS or Parent acceptance.
- **Owner:** MODEL_DECISION.
- **Deterministic enforcement:** Claim structure and consumer dispatch are mechanical; this point concerns the producer’s semantic decision that its own task appears ready to submit, if that judgment is separated from the event dispatch.
- **Model judgment:** Decide whether the local result meets the stated completion expectation and is ready for independent quality review.
- **Required inputs:** Local objective/completion expectation, current result, evidence gathered, and known remaining gaps.
- **Observable output:** `CompletionClaim` only when justified; otherwise more work or evidence gathering. Once emitted, deterministic dispatch is covered by S1-DP07.
- **Existing Prompt Program:** P3 WorkExecution slot contract includes CompletionExpectation; no text-backed producer completion policy.
- **Existing Runtime surface:** Driver decodes `CompletionClaim`, then P8 consumer starts verification; P5 `03`, P8 `03`.
- **Current tests:** `apps/single-workspace/test/p5-completion-claim.test.ts`, `tests/p8-consumer-a.test.ts`; fixed-claim pipeline, not behavioral truthfulness.
- **Behavioral Test Candidate:** YES — **CORE**.
- **Why:** Measure premature completion claims independently from whether Runtime correctly starts verification.

### S3-DP35 — Is the child result quality PASS, FAIL, or Unknown?

- **Source:** S3.4 step 11.
- **Situation / decision:** A child’s local result is submitted for check.
- **Possible outcomes:** PASS with evidence; FAIL with contrary evidence; Unknown with insufficient/unstable/unavailable evidence.
- **Owner:** MODEL_DECISION.
- **Deterministic enforcement:** Verifier-only mutation authority, evidence identity/binding, current revision, and qualified aggregation are mechanical; evidence adequacy is semantic.
- **Model judgment:** Produce a criterion-level evidence-backed verdict and keep FAIL repair with the original producer.
- **Required inputs:** Mission/criteria, current Work revision, result/evidence, environment availability, and unresolved criteria.
- **Observable output:** Evidence records and one permitted verdict per criterion, with Unknown reason if needed.
- **Existing Prompt Program:** `p8-verification` text artifact, but source inspection did not find a production loader call.
- **Existing Runtime surface:** `StartVerification`, `RecordVerificationEvidence`, `ConcludeVerification`; P8 `01–04`.
- **Current tests:** `tests/p8-acceptance.test.ts`, `p8-conclude.test.ts`, `p9-harness.test.ts`.
- **Behavioral Test Candidate:** YES — **CORE**.
- **Why:** Same atomic quality judgment as S1-DP08, now in the child/Parent return path; retain the S3 case as a scenario source for later case merging.

### S3-DP36 — On result arrival, should the Parent wake, queue, or integrate upward?

- **Source:** S3.3; S3.4 step 14.
- **Situation / decision:** Child result arrives while Parent may be waiting, busy, or holding information that affects higher levels.
- **Possible outcomes:** Wake a Parent waiting on that condition; otherwise place the result in its inbox; integrate relevant result before escalating it further.
- **Owner:** MIXED.
- **Deterministic enforcement:** Wait conditions, wake eligibility, inbox routing, deduplication, and parent relationship are canonical runtime state.
- **Model judgment:** Decide the result’s relevance to the Parent’s current responsibility and what impact must move upward.
- **Required inputs:** Result/evidence summary, Parent wait state and active work, affected objective/dependency, and higher-level impact.
- **Observable output:** Runtime wake/inbox transition plus any parent-facing integration/report.
- **Existing Prompt Program:** `p6-communication` may shape the summary/kind; it does not own wake state.
- **Existing Runtime surface:** P6 SpecialistSettled/inbox and P7 wait/wake pipeline; P6 `02`, P7 `04–06`.
- **Current tests:** `tests/p6-specialist-settlement.test.ts`, `p6-inbox-promotion.test.ts`, `tests/p7-wake-pipeline.test.ts`.
- **Behavioral Test Candidate:** YES — **EDGE** for relevance and summary; **NOT_BEHAVIORAL** for wake eligibility.
- **Why:** Keeping semantic integration separate prevents a passing event-delivery test from being misreported as successful collaboration.

## S3 evidence interpretation

P6/P7/P8/P9 acceptance tests provide extensive scripted coverage for the communication, dependency, verification, and recovery machinery. The prompt artifacts are structurally gated, but no test found here sends S3 scenarios to a real model and scores semantic choice. DP23 and DP30 are explicitly excluded from prompt-behavior scoring.
