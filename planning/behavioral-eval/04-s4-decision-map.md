# S4 — long-term continuity and recovery

Source: `docs/design/01-scenarios.md` §§S4.1–S4.5, especially S4.3 and S4.4 steps 1–10. Related contracts: P5 continuity, P9 recovery, P11 environment/staleness, P12 runtime safety, and P14 session/transcript contracts.

## Decision points

### S4-DP37 — Does an idle or interrupted Workspace remain durable and wait for an event?

- **Source:** S4.3; S4.4 steps 2–4 and 10.
- **Situation / decision:** Current stage is complete, there is no runnable work, or an abnormal interruption has occurred.
- **Possible outcomes:** Retain long-lived responsibility/history and remain idle without model polling; record interruption/recovery state; re-enter only when a relevant event/condition changes.
- **Owner:** DETERMINISTIC.
- **Deterministic enforcement:** Execution settlement, durable Workspace/Session state, wait conditions, and event-triggered wake are runtime responsibilities; idle must not manufacture model calls.
- **Model judgment:** None for persistence, sleep, or event matching; later context interpretation is DP38 onward.
- **Required inputs:** Canonical Workspace/Work/Execution state, settlement cause, wait condition, and incoming event identity.
- **Observable output:** Durable state, zero repeated provider turns while idle, and a wake/admission only when a relevant trigger occurs.
- **Existing Prompt Program:** No prompt is needed to preserve canonical responsibility or avoid polling. P3 continuation/compaction entries are contracts, not long-term continuity proof.
- **Existing Runtime surface:** P5 settle/yield/recovery; P7 wait/wake; P9 recovery and P14 session continuity.
- **Current tests:** `apps/single-workspace/test/p5-restart-continuity.test.ts`, `p5-yield-wake.test.ts`, `p5-session-continuity.test.ts`, `tests/p9-recovery-driver.test.ts`, `p9-timer-refire.test.ts`.
- **Behavioral Test Candidate:** NO — **NOT_BEHAVIORAL**.
- **Why:** Validate durable ownership, no-poll behavior, and event wake mechanically. These tests do not establish what memory is later provided to a model.

### S4-DP38 — Which prior work context is needed to resume this responsibility?

- **Source:** S4.4 steps 1, 5, and 6.
- **Situation / decision:** A Workspace resumes after a delay or interruption and must recover enough of its work spine to proceed.
- **Possible outcomes:** Restore responsibility, goals, decisions, reliable results, failed paths, frontier, and relevant changes; avoid loading irrelevant entire-project history.
- **Owner:** MODEL_DECISION.
- **Deterministic enforcement:** Runtime can retrieve durable Session/Work/Checkpoint records and enforce retention/budget; it cannot decide semantic relevance to the next action.
- **Model judgment:** Select and interpret the minimal sufficient continuation context.
- **Required inputs:** Responsibility and revision, open/completed Work, prior verified outcomes, checkpoint/frontier, relevant history, and event that caused re-entry.
- **Observable output:** A resumed plan or query that correctly identifies what is owned, done, pending, and newly relevant.
- **Existing Prompt Program:** Continuation/Compaction program families are only slot contracts in P3; no text-backed continuation program was found.
- **Existing Runtime surface:** P3 context planning and continuation token; P5 Session/Work state; P9 recovery; current driver/context preparation.
- **Current tests:** `apps/single-workspace/test/p5-session-continuity.test.ts`, `p5-restart-continuity.test.ts`, `tests/p9-recovery-driver.test.ts`. These establish stored state/recovery with deterministic providers; they do not assert the exact model-visible historical context.
- **Behavioral Test Candidate:** YES — **CORE**.
- **Why:** S4’s defining promise is restoring the work history, not merely keeping a Session row.

### S4-DP39 — What changed while work was stopped?

- **Source:** S4.4 steps 5–6 and 9.
- **Situation / decision:** Responsibility resumes after code, requirements, dependencies, results, or environment may have changed.
- **Possible outcomes:** Identify relevant deltas; ignore unrelated changes; query/check the current source when prior state is stale or incomplete.
- **Owner:** MODEL_DECISION.
- **Deterministic enforcement:** Runtime can report revision changes and known environment drift; it cannot decide which differences affect the current outcome.
- **Model judgment:** Compare current facts with the prior frontier and focus on changes that alter the next safe action.
- **Required inputs:** Last-known frontier and relevant revisions, new artifacts/events, changed requirements/dependencies, environment revision, and active objective.
- **Observable output:** Bounded change assessment and corresponding plan adjustment or no-change continuation.
- **Existing Prompt Program:** No text-backed staleness/continuation program; P11 provides mechanical revision/staleness contracts.
- **Existing Runtime surface:** P11 drift/impact/staleness/control-basis; P9 recovery visibility.
- **Current tests:** `tests/p11-drift.test.ts`, `p11-impact.test.ts`, `p11-staleness.test.ts`, `p11-controlbasis.test.ts`.
- **Behavioral Test Candidate:** YES — **CORE**.
- **Why:** Runtime can signal changed revisions, but only behavior evaluation can establish whether the model notices decision-relevant change without re-reading everything.

### S4-DP40 — What is the actual outcome of work interrupted around an external effect?

- **Source:** S4.4 step 7.
- **Situation / decision:** Recovery cannot rely only on the last transcript because an external operation may have completed before the process stopped.
- **Possible outcomes:** Confirm completed; confirm not completed and continue; classify as unknown and gather evidence; ask for judgment if it cannot be established automatically.
- **Owner:** MIXED.
- **Deterministic enforcement:** Runtime preserves execution/effect identity and known transport/provider outcome, applies idempotency/recovery constraints, and does not equate missing local response with failure.
- **Model judgment:** Assess the supplied evidence about the real world and select a safe reconciliation/read path.
- **Required inputs:** Last action and exact parameters, operation/effect id, provider/tool result, current external observation, idempotency guarantees, and action risk.
- **Observable output:** Evidence-backed complete/not-complete/unknown disposition and a reconciliation step if needed.
- **Existing Prompt Program:** No dedicated recovery/unknown-outcome text artifact.
- **Existing Runtime surface:** P9 Unknown Outcome, recovery visibility, provider/tool hardening; P11 environment and control basis.
- **Current tests:** `tests/p9-tool-outcome-unknown.test.ts`, `p9-recovery-driver.test.ts`, `p9-recovery-visibility.test.ts`.
- **Behavioral Test Candidate:** YES — **ADVERSARIAL** for the model’s state assessment; separately keep no-replay/runtime rules mechanical.
- **Why:** Missing response is an especially tempting but invalid basis for replay or a success claim.

### S4-DP41 — May an uncertain side effect be replayed?

- **Source:** S4.4 step 7; S3.4 step 10.
- **Situation / decision:** The external effect may have occurred but durable confirmation is absent.
- **Possible outcomes:** Do not blindly replay; first confirm actual state or use an explicitly safe idempotent recovery route.
- **Owner:** DETERMINISTIC.
- **Deterministic enforcement:** Idempotency/recovery policy and command/provider boundaries must prevent unsafe duplicate effect submission.
- **Model judgment:** None for the hard no-blind-replay rule; the model may suggest reconciliation under DP40.
- **Required inputs:** Effect identity, recorded attempt, idempotency semantics, and confirmed actual state.
- **Observable output:** Blocked replay pending reconciliation, or an allowed idempotent retry with evidence.
- **Existing Prompt Program:** No prompt is an adequate enforcement mechanism.
- **Existing Runtime surface:** P9 tool outcome unknown and provider/tool hardening; P12 authority/runtime-safety.
- **Current tests:** `tests/p9-tool-outcome-unknown.test.ts`, `p9-provider-disconnect.test.ts`, `p9-harness-fault-modes.test.ts`.
- **Behavioral Test Candidate:** NO — **NOT_BEHAVIORAL**.
- **Why:** This is a hard side-effect invariant and belongs in runtime/integration tests, not a model score.

### S4-DP42 — When evidence cannot settle reality, should the agent request a ruling?

- **Source:** S4.4 step 7, “无法自动判断”; S3.4 steps 5–7.
- **Situation / decision:** Available direct observations cannot establish the real state safely.
- **Possible outcomes:** Continue a justified local check; state uncertainty and request Parent/user judgment with missing evidence named; do not assert a guessed status.
- **Owner:** MODEL_DECISION.
- **Deterministic enforcement:** Runtime can route an authorized DecisionRequest and preserve Unknown; it cannot decide whether the current evidence is sufficient.
- **Model judgment:** Recognize the limit of automation and identify the exact unresolved fact/decision.
- **Required inputs:** Attempted checks, their results, missing evidence, action risk, and Parent/user authority path.
- **Observable output:** Bounded request that states the unknown and needed ruling; or a further safe observation.
- **Existing Prompt Program:** `p6-communication` covers DecisionRequest kind; `p8-verification` covers Unknown wording for verification. No general recovery-elevation prompt.
- **Existing Runtime surface:** P6 communication and inbox, P9 recovery visibility, P8 Unknown/verification path.
- **Current tests:** `tests/p9-recovery-visibility.test.ts`, `tests/p6-send-message.test.ts`; route mechanics only.
- **Behavioral Test Candidate:** YES — **EDGE**.
- **Why:** It tests honest uncertainty and the correct escalation boundary rather than a fabricated resolution.

### S4-DP43 — Can recovery be limited to the interrupted part?

- **Source:** S4.4 step 8; S4.5 “局部故障局部恢复”.
- **Situation / decision:** A child or local Execution was interrupted, but sibling/ancestor work may remain valid and runnable.
- **Possible outcomes:** Recover/reconcile the affected branch only; leave unaffected completed or active branches intact.
- **Owner:** DETERMINISTIC.
- **Deterministic enforcement:** Runtime tracks the affected Execution/Work/lease and applies recovery to the bound scope; it does not restart the entire tree by default.
- **Model judgment:** None for canonical recovery scope. Deciding whether other work is semantically affected belongs to planning if the change affects its objective.
- **Required inputs:** Interrupted Execution/Work id, dependency graph, durable state, and recovery event.
- **Observable output:** Localized recovery/wake with unaffected canonical state unchanged.
- **Existing Prompt Program:** No prompt should decide canonical recovery blast radius.
- **Existing Runtime surface:** P9 worker crash/recovery and P7 dependency/wake; execution identity and lease recovery.
- **Current tests:** `tests/p9-worker-crash.test.ts`, `p9-recovery-driver.test.ts`, `p9-rebuild-durability.test.ts`, `tests/p7-wake-pipeline.test.ts`.
- **Behavioral Test Candidate:** NO — **NOT_BEHAVIORAL** for recovery scope.
- **Why:** Use restart/rebuild/architecture tests to verify the affected identity boundary.

### S4-DP44 — After context and reality checks, should work re-enter S1 or S3?

- **Source:** S4.4 step 9.
- **Situation / decision:** Current work state is sufficiently restored and external reality is understood.
- **Possible outcomes:** Resume normal progress (S1); resume collaboration/dependency/failure handling (S3); remain blocked pending an explicit condition or ruling.
- **Owner:** MODEL_DECISION.
- **Deterministic enforcement:** Runtime can resume the bound Work/Execution and expose wait conditions; it cannot choose the appropriate reasoning path from the current task state.
- **Model judgment:** Select a safe next action that continues the old responsibility without reopening unrelated completed work.
- **Required inputs:** Restored frontier, current objective, unresolved dependencies, external state, changed requirements, and available tools.
- **Observable output:** Concrete next action, dependency communication, or bounded wait/ruling request.
- **Existing Prompt Program:** P3 WorkExecution contract only; no text-backed ContinuationProgram.
- **Existing Runtime surface:** P5 Execution driver, P7 dependency/wake, P9 recovery; P3 recent-frontier compiler field.
- **Current tests:** `tests/p9-recovery-driver.test.ts`, `p9-acceptance.test.ts`, `tests/p7-coordinator.test.ts` use scripted actions.
- **Behavioral Test Candidate:** YES — **EDGE**.
- **Why:** It tests whether recovery hands the model back to ordinary task behavior instead of remaining in a recovery ritual.

### S4-DP45 — Which historical facts and conclusions are stale?

- **Source:** S4.4 steps 5–7; S4.5 “优先理解新增变化”.
- **Situation / decision:** Historical notes/results exist, but code, environment, requirements, or external state may have changed.
- **Possible outcomes:** Reuse facts still supported by current revisions/evidence; re-check materially stale claims; mark unavailable claims as Unknown.
- **Owner:** MODEL_DECISION.
- **Deterministic enforcement:** Runtime can invalidate artifacts/verifications tied to changed revisions; it cannot infer semantic downstream relevance for every historical statement.
- **Model judgment:** Determine which old conclusions remain reliable for the present decision.
- **Required inputs:** Provenance/revision of facts, current versions/environment, old verification evidence, and the decision now being made.
- **Observable output:** Explicit reuse/recheck/Unknown decisions tied to sources.
- **Existing Prompt Program:** No text-backed Staleness or Continuation Program; P11 `07` invalidates canonical artifacts/verifications under specified revision changes.
- **Existing Runtime surface:** P11 staleness invalidation, impact evaluation, control-basis freshness.
- **Current tests:** `tests/p11-staleness.test.ts`, `p11-impact.test.ts`, `p11-verdict-consumer.test.ts`.
- **Behavioral Test Candidate:** YES — **CORE**.
- **Why:** Mechanical invalidation is necessary but does not prove that the agent notices stale information in ordinary context.

### S4-DP46 — Which prior conclusions and failed paths should be reused?

- **Source:** S4.4 steps 1, 5, and 10.
- **Situation / decision:** Same responsibility returns after a delay or a later bug/extension.
- **Possible outcomes:** Reuse reliable prior findings and known failures; re-verify only where changed context undermines them; avoid starting over as if a new worker.
- **Owner:** MODEL_DECISION.
- **Deterministic enforcement:** Runtime retains durable artifacts/history and provenance; it does not judge what is reusable.
- **Model judgment:** Carry forward valid learning while distinguishing evidence from outdated interpretation.
- **Required inputs:** Prior decisions, validation/evidence references, failed approaches, current goal, revisions, and intervening changes.
- **Observable output:** Resume plan naming relevant retained facts and any targeted rechecks.
- **Existing Prompt Program:** No dedicated memory/continuation body; CompactionProgram is only a P3 contract.
- **Existing Runtime surface:** Session/history/checkpoint/artifact retrieval and context planning; P3 `02`, P5 `04`, P9.
- **Current tests:** P5 continuity tests prove records persist; P9 rebuild tests prove recoverability; neither scores reuse quality.
- **Behavioral Test Candidate:** YES — **CORE**.
- **Why:** Long-term continuity fails if persisted data is ignored or stale beliefs are carried forward uncritically.

### S4-DP47 — How much old history should be loaded to continue correctly?

- **Source:** S4.4 steps 5–6.
- **Situation / decision:** Full project history is large while only a subset relates to the current frontier.
- **Possible outcomes:** Use a sufficient local work pulse and recent relevant changes; request/load a specific missing artifact; avoid replaying all old transcripts by default.
- **Owner:** MODEL_DECISION.
- **Deterministic enforcement:** Runtime applies context budget, retention class, and selected fragments; relevance/coverage remains semantic.
- **Model judgment:** Identify the minimum adequate context and notice when omitted material is required.
- **Required inputs:** Current work frontier, context references/provenance, selected history summary, and available budget.
- **Observable output:** A grounded continuation or explicit request for a missing source.
- **Existing Prompt Program:** Compaction/Continuation families are contracts only; no versioned continuation text artifact found.
- **Existing Runtime surface:** P3 `planContext`, `ModelContextManifest`, compaction contract, recent-frontier field.
- **Current tests:** `packages/model-context/test/p3-context.test.ts`, `p3-compaction.test.ts`, `p3-prepare-turn.test.ts` verify budgeting and data shape, not semantic memory sufficiency.
- **Behavioral Test Candidate:** YES — **EDGE**.
- **Why:** It isolates useful compression/context selection from simple persistence and token-budget mechanics.

### S4-DP48 — Which environment drift changes the current plan?

- **Source:** S4.4 steps 6–7.
- **Situation / decision:** Environment revision or external world changed while the Workspace was idle/interrupted.
- **Possible outcomes:** Continue when drift is irrelevant; re-check affected assumptions/actions; request a ruling when the actual state remains unknown.
- **Owner:** MODEL_DECISION.
- **Deterministic enforcement:** Runtime records environment revisions and validates control-basis freshness for effectful directives; it cannot always establish whether semantic conclusions depend on changed surfaces.
- **Model judgment:** Connect observed drift to the current outcome and prioritize appropriate checks.
- **Required inputs:** Old/current environment revision, affected resources, old assumptions, current work, and freshness response.
- **Observable output:** Continue, re-inspect affected surfaces, or stop for judgment, with the triggering change cited.
- **Existing Prompt Program:** No environment-drift prompt family; P11 contains revision/impact contracts.
- **Existing Runtime surface:** EnvironmentRevisionStore, ControlBasis, freshness invalidation, P11 drift/impact.
- **Current tests:** `tests/p11-drift.test.ts`, `p11-controlbasis.test.ts`, `p11-staleness.test.ts`.
- **Behavioral Test Candidate:** YES — **EDGE**.
- **Why:** It tests correct semantic impact analysis after the mechanical revision signal is delivered.

### S4-DP49 — When an old responsibility returns months later, is it a continuation or a new responsibility?

- **Source:** S4.4 steps 5 and 10.
- **Situation / decision:** Same work is revisited repeatedly for extensions, bugs, or later repair.
- **Possible outcomes:** Continue the established responsibility with its valid prior context and a new bounded frontier; create a separate responsibility only if the actual ownership/outcome boundary changed.
- **Owner:** MODEL_DECISION.
- **Deterministic enforcement:** Workspace identity and lineage remain durable; creation/assignment of a new responsibility requires canonical commands.
- **Model judgment:** Recognize continuity without treating all new requests as identical to old work, and distinguish a new outcome/owner from another cycle of the same work.
- **Required inputs:** Stable responsibility definition, prior work history, new request/bug, current owner, and changed outcome boundary.
- **Observable output:** Continue the existing Work/Workspace or propose a separately governed responsibility with explicit rationale.
- **Existing Prompt Program:** `p6-formation` may apply only if a genuine new child responsibility is proposed; no ContinuationProgram text.
- **Existing Runtime surface:** Durable Workspace/Work identity, formation governance, P5/P9 re-entry.
- **Current tests:** `apps/single-workspace/test/p5-session-continuity.test.ts`, `p5-restart-continuity.test.ts`, `tests/p6-formation-governance.test.ts`.
- **Behavioral Test Candidate:** YES — **EDGE**.
- **Why:** It probes whether continuity preserves ownership while allowing real scope changes, not whether rows merely survive restart.

## S4 evidence interpretation

The tests establish persistence, recovery, freshness invalidation, and event-driven wake mechanics. They do not show that a real model receives and correctly uses a restored frontier, identifies relevant staleness, or safely reconciles an uncertain real-world result. A persisted Session is not evidence that its prior entries or a sufficient work pulse reached the next provider request.
