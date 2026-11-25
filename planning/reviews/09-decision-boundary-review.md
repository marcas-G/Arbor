# Decision-boundary review

This review re-examines the 49 existing points against the frozen S1–S4 text. It does not add product semantics. A point can remain a model decision even when Runtime mechanically constrains its output; that is the reason MIXED exists.

## Reclassification result

The point-level owner counts remain:

| Owner | Before | After review | Change |
|---|---:|---:|---:|
| DETERMINISTIC | 8 | 8 | none |
| MODEL_DECISION | 31 | 31 | none |
| MIXED | 10 | 10 | none |
| **Total** | **49** | **49** | none |

No MODEL_DECISION was fully reducible to a canonical predicate from the frozen scenario text. No MIXED point was collapsed into “the prompt decides” or “Runtime decides everything.” The review did, however, split several old module boundaries and removed duplicate capability claims.

## Point-level boundary decisions

### S1

| Point | Review result | Boundary decision |
|---|---|---|
| S1-DP01 | KEEP LLM | Direction readiness is semantic: Runtime can admit input, not decide whether an ambiguity changes the overall direction. |
| S1-DP02 | KEEP LLM | Formation criteria require judgment over independence, parallel value, isolability, working-style difference, and single-agent cost. |
| S1-DP03 | RUNTIME ONLY | Exact human gate, proposal/revision binding, and canonical effect remain deterministic; proposal quality belongs to DP02. |
| S1-DP04 | KEEP LLM | Deeper own/serial/parallel choice is not a unique state predicate; authority ceiling remains Runtime. |
| S1-DP05 | SPLIT WITHIN POINT | “What next action?” and “Is it ready to claim?” are two outputs in one scenario step. They become separate atomic modules while retaining the same source point. |
| S1-DP06 | KEEP MIXED | Runtime routes input and preserves safe boundaries; model classifies related, independent, or immediate direction change. |
| S1-DP07 | RUNTIME ONLY | CompletionClaimed-to-verification dispatch is canonical; producer claim quality is DP05’s model half. |
| S1-DP08 | KEEP LLM | Evidence adequacy and Pass/Fail/Unknown are semantic; identity, revision, evidence binding, and verdict shape are mechanical. |
| S1-DP09 | KEEP LLM | Repair versus missing-evidence response is semantic; routing and authorized commands are mechanical. |
| S1-DP10 | KEEP LLM | Parent sufficiency is explicitly distinct from local PASS in the frozen scenario. |
| S1-DP11 | KEEP LLM | Upward information selection is different from message-kind selection: it asks what the Parent needs to know. |
| S1-DP12 | KEEP LLM | Overall-stage sufficiency is higher-level integration, not a single Work/Verification predicate. |
| S1-DP13 | KEEP LLM | User-facing next-stage handoff is conversational judgment with an authorization boundary. |

### S2

| Point | Review result | Boundary decision |
|---|---|---|
| S2-DP14 | RUNTIME ONLY | Viewing/projection must not mutate or take over work; no LLM is needed to enforce this. |
| S2-DP15 | KEEP LLM | Scope of a natural-language change (local versus high-level) is semantic; target binding and authority are Runtime facts. |
| S2-DP16 | KEEP LLM | Absorbing a correction while retaining valid prior work is a distinct behavior from merely routing the steer. |
| S2-DP17 | KEEP MIXED | Explicit Critical command and stop fence are mechanical; ordinary-language risk/severity classification is semantic. |
| S2-DP18 | KEEP MIXED | Stop/cancellation/reconciliation fence is Runtime; choosing what evidence to reconcile is model judgment. |
| S2-DP19 | KEEP MIXED | Wake/wait mechanics are Runtime; deciding whether guidance is enough to resume is semantic. |
| S2-DP20 | KEEP MIXED | Relationship preservation and governed transfer are mechanical boundaries; detecting a true ownership change is semantic. |

### S3

These points remain in the map but are deferred from Batch-1 because the user asked for S1/S2-first case design.

| Point | Review result | Boundary decision |
|---|---|---|
| S3-DP21 | KEEP LLM | Local tractability is not the same as authority or tool availability. |
| S3-DP22 | KEEP LLM | Query, Report, DecisionRequest, Reply, and dependency intent are semantic; message schema/correlation are mechanical. |
| S3-DP23 | RUNTIME ONLY | Canonical dependency satisfaction and wake are state predicates. |
| S3-DP24 | KEEP LLM | “Other useful work exists” requires semantic work-graph interpretation. |
| S3-DP25 | KEEP LLM | Deciding that local attempts are exhausted and asking the nearest Parent is semantic. |
| S3-DP26 | KEEP LLM | Request sufficiency is distinct from the decision to escalate. |
| S3-DP27 | KEEP LLM | Parent answerability is a scope/evidence judgment. |
| S3-DP28 | KEEP MIXED | Escalation routing and relationship preservation are mechanical; recognizing a responsibility problem is semantic. |
| S3-DP29 | KEEP MIXED | Ordinary no-preemption and Critical Stop are Runtime boundaries; urgency/blockage interpretation is semantic. |
| S3-DP30 | RUNTIME ONLY | Authority/capability is a canonical resolver result; prompt compliance cannot grant access. |
| S3-DP31 | KEEP LLM | Post-denial adaptation is a planning judgment and has no unique mechanical answer. |
| S3-DP32 | KEEP LLM | Retry/change-method/escalate/reconcile choice depends on failure meaning and risk. |
| S3-DP33 | KEEP MIXED | No-blind-replay is mechanical; evidence selection under unknown effect is semantic. |
| S3-DP34 | MERGE WITH COMPLETION HALF | It is the S3 recurrence of producer readiness already present in S1-DP05; retain provenance, avoid a duplicate module. |
| S3-DP35 | MERGE WITH VERIFICATION | It is the S3 recurrence of S1-DP08’s criterion verdict. |
| S3-DP36 | KEEP MIXED | Wake/inbox routing is mechanical; result relevance and upward integration are semantic. |

### S4

| Point | Review result | Boundary decision |
|---|---|---|
| S4-DP37 | RUNTIME ONLY | Durable idle/wake and no polling are state/scheduler behavior. |
| S4-DP38 | KEEP LLM | Selecting a sufficient work spine from durable records is semantic. |
| S4-DP39 | KEEP LLM | Relevance of changes to the active objective is semantic. |
| S4-DP40 | KEEP MIXED | Effect identity/recovery state are mechanical; interpreting evidence and choosing reconciliation are semantic. |
| S4-DP41 | RUNTIME ONLY | No-blind-replay is a hard side-effect invariant. |
| S4-DP42 | KEEP LLM | Recognizing insufficient evidence and formulating a bounded ruling request is semantic. |
| S4-DP43 | RUNTIME ONLY | Recovery blast radius is bound to the affected Execution/Work identity. |
| S4-DP44 | KEEP LLM | Choosing ordinary progress versus collaboration/recovery continuation is semantic. |
| S4-DP45 | KEEP LLM | Mechanical invalidation signals staleness; the model judges which old claims matter now. |
| S4-DP46 | KEEP LLM | Reusing reliable prior learning without carrying stale interpretation is semantic. |
| S4-DP47 | KEEP LLM | Minimal sufficient context is a relevance/omission judgment after Runtime budgeting. |
| S4-DP48 | KEEP LLM | Environment revision impact is semantic after Runtime reports drift. |
| S4-DP49 | KEEP LLM | Continuation versus a genuinely new responsibility is semantic; creation/assignment remains governed. |

## Final module disposition

The old 12-module grouping is not retained as the final grouping. It mixed distinct capabilities in three places and treated conditional Query behavior as fully scenario-activated. The converged set is **15 modules**:

| Final id | Module | Disposition from old map | Source decision points |
|---|---|---|---|
| M01 | Direction Readiness | KEEP | S1-DP01 |
| M02 | Responsibility Formation | KEEP | S1-DP02–DP04 |
| M03 | Work Action Selection | SPLIT from old M03 | S1-DP05; S3-DP21 |
| M04 | Concurrent Input Triage | SPLIT from old M03 | S1-DP06 |
| M05 | Completion Readiness | SPLIT from old M04; absorbs S3-DP34 | S1-DP05; S3-DP34 |
| M06 | Verification Judgment | SPLIT from old M04; absorbs S3-DP35 | S1-DP08–DP09; S3-DP35 |
| M07 | Parent Sufficiency and Integration | KEEP/rename old M05 | S1-DP10–DP13; S3-DP36 |
| M08 | Human Steer Scope and Absorption | SPLIT from old M06 | S2-DP15–DP16 |
| M09 | Governance Escalation and Severity | KEEP/rename old M07 | S2-DP17, DP20; S3-DP25, DP27–DP30 |
| M10 | Communication Choice | KEEP/rename old M08 | S3-DP22, DP26 |
| M11 | Dependency and Wait Choice | KEEP/rename old M09 | S3-DP23–DP24 |
| M12 | Failure and Unknown Recovery | KEEP/rename old M10; absorbs S3-DP31 from old M03 | S2-DP18; S3-DP31–DP33; S4-DP40–DP43 |
| M13 | Continuation and Staleness | KEEP/rename old M11 | S4-DP37–DP39, DP44–DP49 |
| M14 | Query and Inspection Scope | KEEP-CONDITIONAL old M12 | S2-DP14; conditional Query branch of S3-DP22 |
| M15 | Autonomy Restoration | SPLIT from old M06 | S2-DP19 |

### Original 12-candidate disposition

| Original candidate | Final disposition |
|---|---|
| M01 Direction Readiness | **KEEP** as final M01. |
| M02 Responsibility Formation | **KEEP** as final M02; remove deterministic S1-DP03 from model case scope. |
| M03 Work Action Selection | **SPLIT** into final M03 Work Action Selection and M04 Concurrent Input Triage; move S3-DP31 denial recovery to M12. |
| M04 Completion Claim and Verification | **SPLIT** into final M05 Completion Readiness and M06 Verification Judgment; S1-DP07 dispatch remains deterministic, while S3-DP34/35 recur in and merge with M05/M06. |
| M05 Parent Sufficiency and Integration | **KEEP** as final M07. |
| M06 Human Steer Absorption | **SPLIT** into final M08 Human Steer Scope and Absorption and M15 Autonomy Restoration; governance/critical-stop points remain in M09/M12. |
| M07 Governance Escalation and Severity | **KEEP** as final M09. |
| M08 Inter-Workspace Communication | **KEEP** as final M10. |
| M09 Dependency and Wait Choice | **KEEP** as final M11. |
| M10 Failure and Unknown Recovery | **KEEP** as final M12, with S3-DP31 denial recovery reassigned from old M03. |
| M11 Continuation and Staleness | **KEEP** as final M13. |
| M12 Query / Inspection Scope | **KEEP-CONDITIONAL** as final M14; activation remains unproven. |

No module is dropped. M03/M04 and M05/M06 are splits; the old Human Steer module is split into M08 scope/absorption and M15 autonomy restoration; S3-DP34/35 are merges into the S1-origin modules; M14 remains conditional because clean master does not show a production Query activation path. No new product behavior is implied by these analysis labels.

## Batch-1 selection

Batch-1 contains **six modules** and **72 cases** (12 per module), all sourced from S1/S2 points:

| Module | Why selected now | Source points |
|---|---|---|
| M02 Responsibility Formation | Frequent S1 branch, explicit frozen criteria, observable proposal output, and a strong minimal-pair structure | S1-DP02, S1-DP04 |
| M03 Work Action Selection | Repeated S1 autonomy loop with clear next-action alternatives | S1-DP05 |
| M05 Completion Readiness | Separates a producer’s claim from later verification and catches premature closure | S1-DP05 |
| M06 Verification Judgment | Core S1 quality branch with explicit Pass/Fail/Unknown semantics | S1-DP08, S1-DP09 |
| M08 Human Steer Scope and Absorption | Core S2 user-visible behavior: route local versus high-level change and preserve unaffected progress | S2-DP15, S2-DP16 |
| M15 Autonomy Restoration | Core S2 user-visible behavior with a clear continue-versus-bounded-wait boundary and comparatively direct scoring | S2-DP19 |

M01 Direction Readiness is deferred because clean master has no observed Conversation context/program path and its clarification threshold needs an oracle review before scoring. M07 Parent Sufficiency and Integration remains a high-value deferred module because its multi-level integration judgments are less independently and mechanically scored in this batch. M09–M14 remain second-batch candidates.

## Scoring boundary

The case catalog uses three disjoint dispositions:

- **MECHANICAL (16):** exact output shape/enum and hard boundary can be checked without a semantic judge. This does not claim that all neighboring model reasoning is mechanical.
- **JUDGE (50):** output must be reviewed against the frozen oracle; structure alone is insufficient.
- **ORACLE-AMBIGUOUS (6):** the frozen scenario permits more than one reasonable branch given the deliberately minimal inputs; these are retained for review but excluded from accuracy scoring.

Across the catalog there are 18 CANONICAL, 18 COUNTERFACTUAL, 18 BOUNDARY, and 18 ADVERSARIAL cases. The catalog contains 36 paired contrast groups, of which 18 meet the stricter one-variable minimal-pair definition in `12-oracle-review.md`.
