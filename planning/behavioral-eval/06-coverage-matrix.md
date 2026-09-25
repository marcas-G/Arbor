# Scenario coverage matrix

`●` means the decision point is sourced from that scenario. The final column is whether a future real-model behavior test is warranted for its semantic portion; `NO` points remain covered by mechanical/scripted tests. For MIXED points, `YES` covers only the model-judgment half.

## Decision-point coverage

| Decision Point | S1 | S2 | S3 | S4 | Owner | Primary module | Test value | Behavioral candidate |
|---|:---:|:---:|:---:|:---:|---|---|---|---|
| S1-DP01 | ● |  |  |  | MODEL_DECISION | M01 | CORE | YES |
| S1-DP02 | ● |  |  |  | MODEL_DECISION | M02 | CORE | YES |
| S1-DP03 | ● |  |  |  | DETERMINISTIC | M02 | NOT_BEHAVIORAL | NO |
| S1-DP04 | ● |  |  |  | MODEL_DECISION | M02 | CORE | YES |
| S1-DP05 | ● |  |  |  | MODEL_DECISION | M03 | CORE | YES |
| S1-DP06 | ● |  |  |  | MIXED | M03 | EDGE | YES |
| S1-DP07 | ● |  |  |  | DETERMINISTIC | M04 | NOT_BEHAVIORAL | NO |
| S1-DP08 | ● |  |  |  | MODEL_DECISION | M04 | CORE | YES |
| S1-DP09 | ● |  |  |  | MODEL_DECISION | M04 | EDGE | YES |
| S1-DP10 | ● |  |  |  | MODEL_DECISION | M05 | CORE | YES |
| S1-DP11 | ● |  |  |  | MODEL_DECISION | M05 | EDGE | YES |
| S1-DP12 | ● |  |  |  | MODEL_DECISION | M05 | CORE | YES |
| S1-DP13 | ● |  |  |  | MODEL_DECISION | M05 | CORE | YES |
| S2-DP14 |  | ● |  |  | DETERMINISTIC | M12 | NOT_BEHAVIORAL | NO |
| S2-DP15 |  | ● |  |  | MODEL_DECISION | M06 | CORE | YES |
| S2-DP16 |  | ● |  |  | MODEL_DECISION | M06 | CORE | YES |
| S2-DP17 |  | ● |  |  | MIXED | M07 | ADVERSARIAL | YES |
| S2-DP18 |  | ● |  |  | MIXED | M10 | EDGE | YES |
| S2-DP19 |  | ● |  |  | MIXED | M06 | CORE | YES |
| S2-DP20 |  | ● |  |  | MIXED | M07 | EDGE | YES |
| S3-DP21 |  |  | ● |  | MODEL_DECISION | M03 | CORE | YES |
| S3-DP22 |  |  | ● |  | MODEL_DECISION | M08 | CORE | YES |
| S3-DP23 |  |  | ● |  | DETERMINISTIC | M09 | NOT_BEHAVIORAL | NO |
| S3-DP24 |  |  | ● |  | MODEL_DECISION | M09 | ADVERSARIAL | YES |
| S3-DP25 |  |  | ● |  | MODEL_DECISION | M07 | CORE | YES |
| S3-DP26 |  |  | ● |  | MODEL_DECISION | M08 | EDGE | YES |
| S3-DP27 |  |  | ● |  | MODEL_DECISION | M07 | EDGE | YES |
| S3-DP28 |  |  | ● |  | MIXED | M07 | EDGE | YES |
| S3-DP29 |  |  | ● |  | MIXED | M07 | ADVERSARIAL | YES |
| S3-DP30 |  |  | ● |  | DETERMINISTIC | M07 | NOT_BEHAVIORAL | NO |
| S3-DP31 |  |  | ● |  | MODEL_DECISION | M03 | EDGE | YES |
| S3-DP32 |  |  | ● |  | MODEL_DECISION | M10 | ADVERSARIAL | YES |
| S3-DP33 |  |  | ● |  | MIXED | M10 | ADVERSARIAL | YES |
| S3-DP34 |  |  | ● |  | MODEL_DECISION | M04 | CORE | YES |
| S3-DP35 |  |  | ● |  | MODEL_DECISION | M04 | CORE | YES |
| S3-DP36 |  |  | ● |  | MIXED | M05 | EDGE | YES |
| S4-DP37 |  |  |  | ● | DETERMINISTIC | M11 | NOT_BEHAVIORAL | NO |
| S4-DP38 |  |  |  | ● | MODEL_DECISION | M11 | CORE | YES |
| S4-DP39 |  |  |  | ● | MODEL_DECISION | M11 | CORE | YES |
| S4-DP40 |  |  |  | ● | MIXED | M10 | ADVERSARIAL | YES |
| S4-DP41 |  |  |  | ● | DETERMINISTIC | M10 | NOT_BEHAVIORAL | NO |
| S4-DP42 |  |  |  | ● | MODEL_DECISION | M10 | EDGE | YES |
| S4-DP43 |  |  |  | ● | DETERMINISTIC | M10 | NOT_BEHAVIORAL | NO |
| S4-DP44 |  |  |  | ● | MODEL_DECISION | M11 | EDGE | YES |
| S4-DP45 |  |  |  | ● | MODEL_DECISION | M11 | CORE | YES |
| S4-DP46 |  |  |  | ● | MODEL_DECISION | M11 | CORE | YES |
| S4-DP47 |  |  |  | ● | MODEL_DECISION | M11 | EDGE | YES |
| S4-DP48 |  |  |  | ● | MODEL_DECISION | M11 | EDGE | YES |
| S4-DP49 |  |  |  | ● | MODEL_DECISION | M11 | EDGE | YES |

## Atomic-module coverage

Counts refer to mapped decision points/candidates, not generated cases. M12 includes a conditional Query-scope subdecision inside S3-DP22; therefore its source overlaps M08 and the module totals are not intended to sum to 49.

| Atomic Module | Source Decision Points | CORE Cases | EDGE Cases | ADVERSARIAL Cases | Mechanical Score |
|---|---|---:|---:|---:|---|
| M01 Direction readiness | S1-DP01 | 1 | 0 | 0 | Partial; rubric judgment |
| M02 Responsibility formation | S1-DP02, DP03, DP04 | 2 | 0 | 0 | Partial; schema/gate mechanical, choice semantic |
| M03 Work action selection | S1-DP05, DP06; S3-DP21, DP31 | 2 | 2 | 0 | Partial; action category can be rubric-scored |
| M04 Completion claim and verification | S1-DP07–DP09; S3-DP34–DP35 | 3 | 1 | 0 | Partial; shape/binding mechanical, evidence adequacy semantic |
| M05 Parent sufficiency and integration | S1-DP10–DP13; S3-DP36 | 3 | 2 | 0 | Partial; summaries and sufficiency need judgment |
| M06 Human steer absorption | S2-DP15, DP16, DP19 | 3 | 0 | 0 | Partial; retained/revised facts need judgment |
| M07 Governance escalation, severity, and responsibility scope | S2-DP17, DP20; S3-DP25, DP27–DP30 | 1 | 3 | 2 | Partial; authority/stop mechanics mechanical, semantic boundary judged |
| M08 Inter-Workspace communication choice | S3-DP22, DP26 | 1 | 1 | 0 | Partial; kind/correlation partly mechanical |
| M09 Dependency and wait choice | S3-DP23, DP24 | 0 | 0 | 1 | Partial; satisfaction mechanical, independent-work choice semantic |
| M10 Failure, Unknown, and side-effect recovery | S2-DP18; S3-DP32–DP33; S4-DP40–DP43 | 0 | 2 | 3 | Partial; no-replay/identity mechanical, reconciliation needs judgment |
| M11 Continuation, change, and staleness | S4-DP37–DP39, DP44–DP49 | 4 | 4 | 0 | Partial; persistence/revision mechanical, relevance/staleness semantic |
| M12 Query / Inspection scope discipline | S2-DP14; conditional Query branch of S3-DP22 | 1* | 0 | 0 | Split: UI inspection fully mechanical; query relevance partially judged |

`*` M12 CORE is conditional on a future/verified agent Query execution; DP14 itself is `NOT_BEHAVIORAL`.

## Owner totals

| Owner | Count | Counts toward semantic model judgment? |
|---|---:|---|
| DETERMINISTIC | 8 | No |
| MODEL_DECISION | 31 | Yes |
| MIXED | 10 | Yes, for the model half only |
| **Total decision points** | **49** | **41 include a model judgment** |

## Coverage interpretation

- S1 has strong contract/runtime coverage for formation, claims, and verification dispatch, but no identified real-model scoring for readiness, split quality, work action, verifier judgment, parent sufficiency, or stage completion.
- S2 has explicit steer/critical-stop runtime stories, but natural-language scope, severity classification, correction absorption, and responsibility-transfer recognition remain model-behavior questions.
- S3 has broad dependency/message/recovery scripted coverage. That validates mechanics, not whether a model chooses the appropriate Query/dependency/help/retry path.
- S4 has persistence/recovery/revision tests. Model-visible restored context and correct staleness/reconciliation judgments remain unobserved by those tests.
