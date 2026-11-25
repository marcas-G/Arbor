# Batch-1 atomic module specification

Batch-1 is intentionally limited to six modules selected in `09-decision-boundary-review.md`. The module interfaces are analysis contracts for case design, not Runtime or Prompt contracts.

## M02 — Responsibility Formation

- **Purpose:** Decide whether a bounded responsibility stays local or becomes a child responsibility, and whether a justified split is serial or parallel.
- **Decision question:** Do the frozen five criteria support a split, and which branch is the smallest defensible one?
- **Minimal inputs:** Outcome, constraints, candidate sub-outcomes, context boundary, dependency facts, parallel value, working-style difference, and single-agent cost.
- **Excluded inputs:** Unrelated project history, invented authority, full tool catalog, and hidden implementation facts.
- **Output space:** `NO_SPLIT | SPLIT_SERIAL | SPLIT_PARALLEL`; when splitting, `proposal` with responsibility/resource boundary/initial work/rationale.
- **Mechanical scoring:** Validate enum, required proposal fields, no first-layer effect without the human gate, and no “formation satisfies dependency” claim.
- **Judge scoring:** Whether the five criteria actually support the selected branch and whether the rationale is proportional.
- **Source decision points:** S1-DP02, S1-DP04. S1-DP03 is a Runtime-only gate and is not a model case.

## M03 — Work Action Selection

- **Purpose:** Select the next useful action inside an already authorized responsibility.
- **Decision question:** Given the current frontier and evidence, should the agent act, observe, revise, continue, or wait?
- **Minimal inputs:** Objective, constraints, completion expectation, current frontier, latest observation, and available authorized action categories.
- **Excluded inputs:** Unrelated Workspace history, unprovided tool capabilities, and presumed external state.
- **Output space:** `ACT | OBSERVE | REVISE_PLAN | CONTINUE | WAIT_ON_DECLARED_CONDITION`; a completion claim belongs to M05.
- **Mechanical scoring:** Validate one permitted action label and required reference to the current work.
- **Judge scoring:** Whether the selected action advances the objective, preserves valid progress, and avoids a premature wait.
- **Source decision points:** S1-DP05. The related S3 local-tractability point is deferred to Batch-2.

## M05 — Completion Readiness

- **Purpose:** Decide whether the producer has enough evidence to submit a local result for independent quality verification.
- **Decision question:** Is the completion expectation met enough to emit a claim, or is more work/evidence required?
- **Minimal inputs:** Work objective, completion expectation, result state, checks already run, remaining gaps, and evidence references.
- **Excluded inputs:** Parent acceptance, verifier authority, and an assumption that “no visible problem” means PASS.
- **Output space:** `CLAIM_FOR_VERIFICATION | CONTINUE_WORK | GATHER_EVIDENCE | REPAIR`.
- **Mechanical scoring:** Validate one output enum, work/revision reference, and no direct Parent acceptance claim.
- **Judge scoring:** Whether the claim is honest and appropriately distinguishes local readiness from final completion.
- **Source decision points:** S1-DP05. S3-DP34 is the same decision recurrence and is deferred as a separate source.

## M06 — Verification Judgment

- **Purpose:** Judge a completed local result against its mission using evidence and the frozen three-valued outcome.
- **Decision question:** For every criterion, is the result `PASS`, `FAIL`, or `UNKNOWN`, and what evidence supports it?
- **Minimal inputs:** Mission criteria, target Work revision, result/artifacts, direct observations, documents, hypotheses, boundary/counterexample evidence, and missing evidence.
- **Excluded inputs:** Producer self-repair instructions, Parent acceptance, and unsupported “no issue found” conclusions.
- **Output space:** Criterion verdicts `PASS | FAIL | UNKNOWN`, evidence references, and a bounded next action for FAIL/UNKNOWN.
- **Mechanical scoring:** Validate criterion coverage, one verdict per criterion, evidence-reference shape, and no mutation directive.
- **Judge scoring:** Evidence quality ordering, verdict correctness, honest Unknown use, and proportionate repair/evidence response.
- **Source decision points:** S1-DP08, S1-DP09. S3-DP35 is merged into this module and deferred from Batch-1.

## Deferred M07 — Parent Sufficiency and Integration

- **Purpose:** Determine whether a locally verified result supports the Parent’s own outcome and how much information should move upward.
- **Decision question:** Is this result sufficient for the parent/stage, or is supplementary work, integration, or a user handoff still needed?
- **Minimal inputs:** Parent objective, completion expectation, child result/verdict, key evidence and caveats, open dependencies, and stage frontier.
- **Excluded inputs:** Full child transcript/tool log by default, unrelated tree branches, and a local PASS treated as parent completion.
- **Output space:** `ACCEPT_AND_INTEGRATE | REQUEST_SUPPLEMENT | CONTINUE_STAGE | REPORT_STAGE_RESULT | RETURN_TO_USER`.
- **Mechanical scoring:** Validate one output category, bounded summary fields, and no canonical completion without the required acceptance authority.
- **Judge scoring:** Sufficiency, relevance of upward summary, stage completeness, and proportional user handoff.
- **Source decision points:** S1-DP10, S1-DP11, S1-DP12, S1-DP13.

## M08 — Human Steer Scope and Absorption

- **Purpose:** Classify the requested change as local or high-level, then incorporate a local correction while preserving unaffected work.
- **Decision question:** Which responsibility does the correction affect, what prior findings remain valid, and what bounded plan update follows?
- **Minimal inputs:** Selected Workspace/responsibility, current frontier, prior relevant findings, exact user correction, parent direction, and explicit pending rulings.
- **Excluded inputs:** Unrelated tree history, inferred ownership transfer, stop-severity classification, and a broad “permission to use tools.”
- **Output space:** `ABSORB_LOCAL | ROUTE_HIGH_LEVEL | REVISE_LOCAL_PLAN | PRESERVE_VALID_PROGRESS | REQUEST_BOUNDED_CLARIFICATION`.
- **Mechanical scoring:** Validate target/scope references and output shape; ensure a clarification is tied to an unresolved scope fact. Canonical authority, Critical Stop, and ownership-transfer enforcement are outside this module.
- **Judge scoring:** Scope classification, retained valid progress, corrected assumptions, and proportional plan revision.
- **Source decision points:** S2-DP15, S2-DP16. S2-DP17/18/19/20 are outside this module; DP19 autonomy-versus-wait is not combined with correction absorption in Batch-1.

## M15 — Autonomy Restoration

- **Purpose:** Decide whether absorbed guidance leaves useful authorized work to continue or a specific ruling/precondition requires a bounded wait.
- **Decision question:** After the correction is understood, can the agent safely continue now, continue an unblocked branch, or must it wait for one named condition?
- **Minimal inputs:** Absorbed correction, current Work frontier, remaining authority, available next actions, explicit blockers, and pending human rulings.
- **Excluded inputs:** Unrelated history, inferred permission changes, stop-severity classification, and unresolved external side-effect reconciliation.
- **Output space:** `CONTINUE_AUTONOMOUSLY | CONTINUE_UNBLOCKED_WORK | WAIT_FOR_SPECIFIC_RULING | WAIT_FOR_EXPLICIT_PRECONDITION`.
- **Mechanical scoring:** Validate one action label and require each wait output to identify its stated ruling/precondition; do not score routing or stop mechanics here.
- **Judge scoring:** Whether the named condition actually blocks the proposed action, whether safe work continues, and whether unnecessary confirmation debt is avoided.
- **Source decision points:** S2-DP19. DP17 Critical Stop and DP18 in-flight effect reconciliation remain separate.

## Deferred module interfaces

The remaining final modules are retained for Batch-2 and have the following boundary-only definitions:

| Module | Minimum output boundary | Main deferred source points |
|---|---|---|
| M01 Direction Readiness | `CONTINUE_DISCUSSION | BEGIN_WORK_ORGANIZATION` | S1-DP01 |
| M04 Concurrent Input Triage | `ABSORB_CURRENT | QUEUE_INDEPENDENT | ENTER_CRITICAL_PATH` | S1-DP06 |
| M07 Parent Sufficiency and Integration | `ACCEPT_AND_INTEGRATE | REQUEST_SUPPLEMENT | CONTINUE_STAGE | REPORT_STAGE_RESULT | RETURN_TO_USER` | S1-DP10–DP13 |
| M09 Governance Escalation and Severity | `LOCAL | PARENT_REQUEST | UPWARD_REQUEST | CRITICAL_STOP | TRANSFER_PROPOSAL` | S2-DP17, DP20; S3-DP25, DP27–DP30 |
| M10 Communication Choice | `QUERY | REPORT | DECISION_REQUEST | REPLY` | S3-DP22, DP26 |
| M11 Dependency and Wait Choice | `CONTINUE_INDEPENDENT | DECLARE_DEPENDENCY | WAIT_ON_CONDITION` | S3-DP23–DP24 |
| M12 Failure and Unknown Recovery | `RETRY_SAFE | CHANGE_METHOD | RECONCILE | REQUEST_RULING | HOLD_UNKNOWN` | S2-DP18; S3-DP31–DP33; S4-DP40–DP43 |
| M13 Continuation and Staleness | `REUSE | RECHECK | MARK_UNKNOWN | CONTINUE_EXISTING | NEW_GOVERNED_WORK` | S4-DP37–DP39, DP44–DP49 |
| M14 Query and Inspection Scope | `SCOPED_OBSERVATION | REPORT_OR_REPLY | OUT_OF_SCOPE_OR_UNKNOWN` | S2-DP14; conditional S3-DP22 |

The deferred definitions are included to make the final 15-module disposition auditable; they are not Batch-1 cases.
