# Atomic Behavioral Module Map

These modules are a bottom-up grouping of the 49 scenario decision points, not a proposed prompt architecture. A module is a small judgment interface that could later be isolated in a case. Deterministic portions remain runtime tests. `S3-DP22` has one primary communication-kind decision and a conditional Query/Inspection scope subdecision; that conditional split is called out below rather than treating every Query Program clause as scenario-backed.

## M01 — Direction readiness

- **Purpose:** Decide when high-level discussion contains enough direction to start useful work.
- **Decision question:** Is any unresolved ambiguity still decision-critical to the overall direction?
- **Minimal inputs:** User goal, explicit constraints, prior agreement, and unresolved questions.
- **Excluded inputs:** Full project history, tool catalog, unrelated workspace tree.
- **Output space:** `CONTINUE_DISCUSSION | BEGIN_WORK_ORGANIZATION`.
- **Mechanical scoring:** Partly scoreable by rubric; whether a clarification changes direction requires human judgment or a qualified LLM judge.
- **Runtime boundary:** Runtime records messages/admission; it must not infer user authorization from a mere mention of a goal.
- **Source decision points:** S1-DP01.
- **Prompt support:** No text-backed HumanInteractionProgram found; P3 BaseAgentProtocol is a slot contract. No production conversation program selection was found in inspected source.
- **Future test value:** CORE; high user-visible impact.

## M02 — Responsibility formation

- **Purpose:** Decide whether a responsibility should remain local or become a child responsibility, and whether division should be serial or parallel.
- **Decision question:** Does a candidate split meet the frozen criteria, and what is the smallest defensible partition?
- **Minimal inputs:** Responsibility/outcome, constraints, candidate sub-outcomes, dependency boundaries, context needs, parallel value, coordination cost, authority/resource ceiling.
- **Excluded inputs:** Arbitrary project history, unrelated skills/tools, assumed authority beyond the current boundary.
- **Output space:** `NO_SPLIT | DO_SELF | SPLIT_SERIAL | SPLIT_PARALLEL`, with candidate proposal/rationale when split.
- **Mechanical scoring:** Shape and authority are mechanically scoreable; quality of criteria application needs a human or LLM rubric judge.
- **Runtime boundary:** Proposal schema, revision-bound human gate at first layer, resource ceiling, and canonical child/work creation stay mechanical.
- **Source decision points:** S1-DP02, S1-DP03, S1-DP04.
- **Prompt support:** Text-backed `p6-formation`; static gate exists. Production loading was not found in inspected source.
- **Future test value:** CORE, plus ADVERSARIAL cases where work is complex but serial/shared-context.

## M03 — Work action selection

- **Purpose:** Select the next useful action within an already authorized responsibility, including handling an incoming related/independent item or adapting after a capability denial.
- **Decision question:** Given current state and constraints, what action advances the outcome without losing valid progress or crossing authority?
- **Minimal inputs:** Responsibility, objective/completion expectation, work frontier, latest relevant input, observations, allowed capabilities, and known blockers.
- **Excluded inputs:** Unrelated Workspace history, assumed tool capabilities, hidden external state.
- **Output space:** `ACT | OBSERVE | REVISE_PLAN | CONTINUE_EXISTING | QUEUE_INDEPENDENT | REQUEST_AUTHORIZED_HELP | CLAIM_READY_FOR_CHECK`.
- **Mechanical scoring:** Candidate action category can be rubric-scored; action usefulness often requires human/LLM judgment.
- **Runtime boundary:** Command authority, revision freshness, tool capability, turn/retry limits, and effect execution are not prompt duties.
- **Source decision points:** S1-DP05, S1-DP06, S3-DP21, S3-DP31.
- **Prompt support:** P3 WorkExecution slot contract; P6 human-steer/communication texts for relevant inputs. No production loader call site found for the P6 texts.
- **Future test value:** CORE and ADVERSARIAL (forbidden action temptation after denial or unrelated incoming work).

## M04 — Completion claim and verification judgment

- **Purpose:** Keep producer completion claims distinct from independent quality judgment, and interpret evidence honestly.
- **Decision question:** Is the result ready to check, and does evidence establish PASS, FAIL, or Unknown for each criterion?
- **Minimal inputs:** Objective/mission criteria, completion expectation, target revision, result/artifacts, direct observations, and missing/unstable evidence.
- **Excluded inputs:** Parent acceptance decision, unrelated project state, unsupported assumptions about the environment.
- **Output space:** Producer `CONTINUE | CLAIM_FOR_VERIFICATION`; Verifier criterion verdicts `PASS | FAIL | UNKNOWN`, each with evidence references.
- **Mechanical scoring:** Directive/claim shape and criterion coverage are mechanical; evidence adequacy/verdict correctness need human or LLM judging.
- **Runtime boundary:** Verification identity/revision, verifier authority, evidence binding, allowed verdict enum, qualified aggregation, and claim-to-verification dispatch are runtime-enforced.
- **Source decision points:** S1-DP07, S1-DP08, S1-DP09, S3-DP34, S3-DP35.
- **Prompt support:** Text-backed `p8-verification` for verifier behavior; P3 WorkExecution contract for producer claim. No versioned producer-completion body found; P8 text production use was not found.
- **Future test value:** CORE for supported PASS; EDGE for FAIL/Unknown; ADVERSARIAL for “no issue found” and inadequate evidence.

## M05 — Parent sufficiency and stage integration

- **Purpose:** Determine whether a locally correct result supports the next responsibility level and what still needs work.
- **Decision question:** Is this result sufficient for my outcome, and what minimum information/work must be retained or passed upward?
- **Minimal inputs:** Parent outcome/completion expectation, child verdict/result, key evidence, open gaps/dependencies, and current stage state.
- **Excluded inputs:** Full child tool logs and entire transcript unless a specific reference is needed.
- **Output space:** `ACCEPT_AND_INTEGRATE | REQUEST_SUPPLEMENT | CONTINUE_STAGE | REPORT_STAGE_RESULT | RETURN_TO_USER`.
- **Mechanical scoring:** Some output/state transitions are mechanical; sufficiency, summary relevance, and stage completion require a rubric judge.
- **Runtime boundary:** Parent acceptance authority and revision checks, canonical Work transitions, message routing, and inbox/wake state are runtime-owned.
- **Source decision points:** S1-DP10, S1-DP11, S1-DP12, S1-DP13, S3-DP36.
- **Prompt support:** P3 WorkExecution/ResponsibilityBound slot contracts and text-backed P6 communication for summaries; no dedicated Parent Sufficiency Program.
- **Future test value:** CORE and EDGE; distinguish quality PASS from parent sufficiency.

## M06 — Human steer absorption

- **Purpose:** Incorporate a local human correction while preserving unaffected work and returning to useful autonomy.
- **Decision question:** What does this correction invalidate, what remains sound, and what is the next safe autonomous action?
- **Minimal inputs:** Current responsibility/frontier, prior relevant evidence, exact correction, affected assumptions, and pending explicit human decisions.
- **Excluded inputs:** Entire project transcript, unmentioned authority changes, unrelated tree branches.
- **Output space:** `ABSORB_AND_CONTINUE | REVISE_AFFECTED_PLAN | ASK_BOUNDED_RULING`.
- **Mechanical scoring:** Diff between prior and revised assumptions can be partially checked; usefulness and no-loss-of-valid-work need human/LLM judgment.
- **Runtime boundary:** Authenticated steer, target binding, critical-stop quiescence, revisions, and effect reconciliation remain mechanical.
- **Source decision points:** S2-DP15, S2-DP16, S2-DP19.
- **Prompt support:** Text-backed `p6-human-steer`; static clause checks exist; no production loader call site found.
- **Future test value:** CORE; include a correction that changes one constraint but leaves substantial progress valid.

## M07 — Governance escalation, severity, and responsibility scope

- **Purpose:** Determine when a local agent should ask a higher authority and keep escalation separate from interrupting work or changing ownership.
- **Decision question:** Is this an ordinary local request, a high-risk Critical Stop, a ruling request, or a genuine responsibility transfer?
- **Minimal inputs:** Request/evidence, active work and side-effect boundary, explicit urgency, responsibility chain, local authority, and unresolved decision.
- **Excluded inputs:** Assumed priority not present in command/input; broad permission detached from one exact action.
- **Output space:** `LOCAL_DECISION | DIRECT_PARENT_REQUEST | UPWARD_REQUEST | CRITICAL_STOP | RESPONSIBILITY_CHANGE_PROPOSAL`.
- **Mechanical scoring:** Explicit command kind, authority chain, and stop mechanics are mechanical; risk classification and escalation sufficiency need judgment.
- **Runtime boundary:** Exact authority, scope, parent relation, no implicit tree mutation, critical stop fencing, and approval binding.
- **Source decision points:** S2-DP17, S2-DP20, S3-DP25, S3-DP27, S3-DP28, S3-DP29; S2-DP18’s stop-effect mechanics are tested separately under M10.
- **Prompt support:** Text-backed `p6-human-steer` and `p6-communication`; neither can grant authority or interrupt execution on its own.
- **Future test value:** CORE/EDGE plus ADVERSARIAL for strong wording without critical intent and blocked-child requests while Parent is busy.

## M08 — Inter-Workspace communication choice

- **Purpose:** Choose a communication kind and include the smallest useful correlated content.
- **Decision question:** Is the need an observation, finding, ruling, or answer to a prior request—and what summary enables the recipient to act?
- **Minimal inputs:** Missing information/result, recipient relationship, correlation/dependency, evidence summary, and purpose.
- **Excluded inputs:** Full conversation/tool log by default; invented urgency or unmodeled message kinds.
- **Output space:** `QUERY | REPORT | DECISION_REQUEST | REPLY`, with required references/correlation and bounded summary.
- **Mechanical scoring:** Kind enum, correlation identity, body reference, and urgency are mechanical; semantic applicability/content usefulness need a judge.
- **Runtime boundary:** Message validation/routing, correlation lifecycle, durable artifact reference, inbox projection, and “Report is not delivery/dependency satisfaction.”
- **Source decision points:** S3-DP22, S3-DP26.
- **Prompt support:** Text-backed `p6-communication`; static gate exists; no production loader call site found.
- **Future test value:** CORE for kind choice; EDGE for correlation and sufficiency.

## M09 — Dependency and wait choice

- **Purpose:** Represent a real prerequisite and avoid stopping unrelated progress while it is pending.
- **Decision question:** Is another outcome actually required, and can any independent work proceed now?
- **Minimal inputs:** Work graph/frontier, requested result and producer, dependency condition, available independent tasks, and current readiness facts.
- **Excluded inputs:** Merely related conversation, Reports without delivery, speculative work with unmet preconditions.
- **Output space:** `DECLARE_DEPENDENCY | CONTINUE_INDEPENDENT_WORK | YIELD_ON_CONDITION`.
- **Mechanical scoring:** Dependency state/satisfaction and wake are mechanically scoreable; semantic independence of candidate work needs a judge.
- **Runtime boundary:** Dependency identity/status, no polling while waiting, deadlock/readiness checks, and event wake.
- **Source decision points:** S3-DP23, S3-DP24.
- **Prompt support:** No dedicated dependency/wait text; P6 communication explicitly says formation is not dependency and Report does not satisfy it.
- **Future test value:** CORE for ordinary waits; ADVERSARIAL for a dependency pending while independent work exists.

## M10 — Failure, Unknown, and side-effect recovery

- **Purpose:** Respond proportionately to failure and preserve real-world state when an external effect is uncertain.
- **Decision question:** Is it safe to retry, should the method change, what observation can reconcile the effect, or is help required?
- **Minimal inputs:** Failure class, exact action/effect identity, attempts, idempotency guarantee, observed external state, and available authority.
- **Excluded inputs:** Assumed success/failure from a missing response; unrelated history; unsupported claim that a side effect was rolled back.
- **Output space:** `RETRY_SAFE | CHANGE_METHOD | RECONCILE | REQUEST_RULING | HOLD_UNKNOWN`.
- **Mechanical scoring:** No-blind-replay, retry bounds, and recovery identity are mechanical; choice/quality of reconciliation evidence needs a judge.
- **Runtime boundary:** Provider transport retry vs model repair, idempotency, execution safety, typed Unknown state, and localized recovery.
- **Source decision points:** S2-DP18; S3-DP32, S3-DP33; S4-DP40, S4-DP41, S4-DP42, S4-DP43.
- **Prompt support:** No dedicated text-backed general recovery program; P3 bounded repair and P9 recovery contracts cover specific mechanics.
- **Future test value:** ADVERSARIAL; high consequence, but keep every hard safety assertion outside the prompt score.

## M11 — Continuation, change, and staleness judgment

- **Purpose:** Resume an existing responsibility with its relevant work spine and determine which past conclusions survive.
- **Decision question:** What changed, what prior evidence remains valid, and what is the smallest sufficient continuation context?
- **Minimal inputs:** Responsibility and Work identity/revisions, frontier/checkpoint, previous decisions/evidence, event causing return, current environment and relevant deltas.
- **Excluded inputs:** Entire project transcript or unrelated branches unless a specific dependency requires them.
- **Output space:** `REUSE | RECHECK | MARK_UNKNOWN | CONTINUE_EXISTING | NEW_GOVERNED_WORK`, with sources and next action.
- **Mechanical scoring:** Durable identity, version comparison, retention, and budget are mechanical; relevance/staleness/reuse quality needs a human or LLM judge.
- **Runtime boundary:** Persistence, checkpoint/revision provenance, context budget, freshness invalidation, event wake, and no unintended whole-tree restart.
- **Source decision points:** S4-DP37, S4-DP38, S4-DP39, S4-DP44–S4-DP49.
- **Prompt support:** Continuation/Compaction are P3 slot contracts only; no text-backed continuation artifact was found.
- **Future test value:** CORE for return after a relevant change; EDGE for long gap; ADVERSARIAL for stale success or irrelevant large history.

## M12 — Query / Inspection scope discipline

- **Purpose:** Keep read/inspection work scoped and evidential, and ensure observation does not mutate what it observes.
- **Decision question:** What exact question and source boundary apply to an observation, and can the result be reported without canonical mutation?
- **Minimal inputs:** Requesting question, authorized readable surfaces, source references, and returned observations.
- **Excluded inputs:** Mutation commands, unspecified surfaces, claims unsupported by inspected records.
- **Output space:** `SCOPED_OBSERVATION | REPORT_OR_REPLY | OUT_OF_SCOPE_OR_UNKNOWN`.
- **Mechanical scoring:** Read-only command/tool availability, target scope, and citations can be mechanically checked; relevance/sufficiency of answer may need a judge.
- **Runtime boundary:** Read-only capability/tool set and authorization must be enforced by Runtime. Prompt text saying “read-only” cannot remove a mutation tool.
- **Source decision points:** S2-DP14 (explicitly human UI inspection, deterministic); conditional Query branch of S3-DP22 (peer observation request). S1–S4 do not define a separate agent Query execution lifecycle; this is a limited mapping, not evidence that such an execution is activated.
- **Prompt support:** Text-backed `p8-query-inspection` requires scope declaration, citations, and message/observation-only results. Its production activation and read-only tool enforcement were not found in the inspected call path.
- **Future test value:** EDGE if a genuine model Query execution is confirmed; otherwise do not count user browsing as model behavior.

## Cross-module boundaries

- The verifier decides the evidence verdict; the producer selects and performs repair; the Parent decides sufficiency/acceptance. These are separate modules even if one prompt text appears to discuss all three roles.
- Dependency satisfaction is deterministic (M09 boundary), while choosing whether a dependency is necessary is semantic (M08/M09 input/output choices).
- “Critical” semantic recognition, stopping/cancellation, and unknown-effect reconciliation must never be scored as one undifferentiated prompt success (M07 vs M10).
- Continuation persistence and context selection are separate: M11 can only be behaviorally evaluated after the provider request’s actual context is observable.
- M12 remains conditional because frozen S1–S4 describe a user inspecting a tree and an Agent asking a peer for an observation, but do not spell out the full activation contract of a dedicated Query execution.
