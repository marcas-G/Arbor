# Arbor Behavioral Decision Map — scope and method

- **Status:** research draft for human review
- **Scenario baseline:** `docs/design/01-scenarios.md`, Scenarios v1.2, FROZEN
- **Related frozen sources:** `docs/design/02-system-design.md` v1.3; `docs/design/03-detailed-implementation-design.md` v1.17; P3/P5/P6/P7/P8/P9/P11/P12/P14 contracts under `docs/design/implementation/`
- **Review date:** 2026-09-25

## Purpose and boundary

This map extracts every scenario branch in S1–S4 that changes what happens next, then distinguishes machine-decided outcomes from semantic model judgments and mixed boundaries. It does not redesign the scenarios, define new semantics, modify prompts/runtime/contracts/tests, call a formal model API, create cases, or plan implementation. The decision maps are evidence-backed research artifacts for human review before Atomic Scenario Case Design.

The requested filename `Arbor_Scenarios_S1-S4_v1.2.md` is not present in this checkout. The authoritative in-repository source is `docs/design/01-scenarios.md`: its header says v1.2/FROZEN and its section structure is S1–S4. Its closing coverage text says “场景集状态：FROZEN / COMPLETE（v1.1）”; that version-label inconsistency is recorded as a low finding, not silently reconciled here.

The workspace was already dirty when this review began, including provider/runtime/UI changes and `planning/proposals/prompt-review/`. Those files are outside this review and were left untouched. Runtime observations below describe the checked-out source as inspected on this date; where that source is uncommitted, findings are explicitly provisional and do not claim a clean-baseline result.

## Classification rules

Each mapped point receives exactly one owner:

- **DETERMINISTIC** — the branch can be decided mechanically from canonical state, explicit command kind, or a frozen runtime rule. It is not a prompt-behavior test. Test it with unit, integration, architecture, or scripted story coverage.
- **MODEL_DECISION** — the branch requires semantic judgment and has no unique mechanical answer in the scenario. This is the primary behavioral-evaluation surface.
- **MIXED** — a semantic choice and a mechanical boundary both matter. Test the model’s choice separately from the runtime’s permission, state transition, or stop/wake enforcement.

An explicit human action (for example, choosing to inspect or issue a steer) is treated as input, not as a model decision. A deterministic point may record how Runtime must preserve that explicit choice, but never attributes the human’s choice to the model.

For every point, “possible outcomes” names scenario-allowed branches; it does not add new product semantics. “Required inputs” lists the minimum information implied by the frozen scenario. If source code does not show that an input reaches the model, that is recorded as a gap rather than assumed.

## Test-value labels

- **CORE** — recurring mainline judgment in the frozen flow.
- **EDGE** — less frequent boundary with meaningful correctness consequences.
- **ADVERSARIAL** — a scenario-shaped temptation likely to elicit a known wrong branch (for example, complexity without parallel value, or an uncertain side effect that tempts replay).
- **NOT_BEHAVIORAL** — the relevant outcome is explicit human input or mechanically enforced; cover it with non-model tests.

“Behavioral Test Candidate: YES” means a future real-model scenario could isolate the semantic choice. It does not mean a case, runner, prompt variant, or model call was created in this phase.

## Evidence and confidence

Claims are anchored to the frozen scenario section/step first, then to the corresponding System Design / DID / phase contract, source symbol, and existing test. A test is described by what it actually asserts:

- **STATIC CONTRACT GATE** — prompt headers, hashes, versions, mandatory/forbidden clauses, slots, or output-contract references.
- **SCRIPTED PIPELINE / STORY TEST** — deterministic test provider or fixed directives exercise runtime wiring and state transitions. This proves the tested path, not that prompt wording caused the behavior.
- **BEHAVIORAL MODEL TEST** — a scenario is run against an actual model and scored for behavior. No such coverage was identified for the mapped prompt families in the checked-in tests.

The source/test references in each map use repository-relative paths so they can be verified directly. “Existing Prompt Program” means a plausible declared owner, not proof that production loads it.

## Count convention

The map contains **49** decision points:

| Scenario | Points |
|---|---:|
| S1 — normal long-running work | 13 |
| S2 — human supervision and correction | 7 |
| S3 — collaboration, dependencies, and failures | 16 |
| S4 — continuity and recovery | 13 |
| **Total** | **49** |

Initial owner classification: **8 DETERMINISTIC, 31 MODEL_DECISION, 10 MIXED**. Therefore **41 points include a semantic model judgment** (MODEL_DECISION + MIXED). A mixed point counts once in the total and once in the “requires model judgment” count; its mechanical half is not thereby a prompt-eval target.

The 49-point count is a review granularity, not a benchmark-size recommendation. Identical decisions recurring in multiple scenarios remain separately traceable to their source, then are grouped in `05-atomic-module-map.md`.

## Runtime / prompt / test evidence baseline

The frozen scenario baseline is user-visible behavior, not an implementation contract. Runtime boundaries are cross-checked against:

- P3 context, Prompt Program, driver, repair, and eval contracts: `docs/design/implementation/P3/02-model-context-contracts.md`, `03-agent-loop-driver.md`, `05-prompt-context-contracts.md`, `06-provider-failure-repair.md`, `07-behavioral-eval-harness.md`.
- P5 work execution and continuity: `docs/design/implementation/P5/02-runnable-work-source.md`, `03-directive-handling.md`, `04-slice-continuity.md`, `05-slice-acceptance.md`.
- P6 formation, communication, delegation, steer, and prompt family contracts: `docs/design/implementation/P6/01-formation-semantics.md` through `06-acceptance.md`.
- P7 dependencies, coordinator satisfaction, wait graph, and wake: `docs/design/implementation/P7/01-dependency-deliverable-commands.md` through `07-acceptance.md`.
- P8 verification and query prompt contracts: `docs/design/implementation/P8/01-verification-commands.md` through `06-acceptance.md`.
- P9 recovery evidence: `docs/design/implementation/P9/01-recovery-visibility.md` through `06-acceptance.md`.
- P11 staleness/environment and P12 tool/authority contracts: `docs/design/implementation/P11/01-revision-algebra.md`, `05-drift-detection.md`, `06-impact-evaluation.md`, `07-staleness-invalidation.md`, `08-controlbasis-binding.md`; `docs/design/implementation/P12/02-authority-resolver.md`, `07-toolcatalog-model-facing.md`, `08-runtime-safety-completion.md`.
- P14 conversation trigger and transcript contracts: `docs/design/implementation/P14/01-human-message.md` through `05-acceptance.md`.

Current implementation evidence includes `packages/agent-runtime/src/driver.ts`, `packages/model-context/src/prepare-turn.ts`, `compiler.ts`, `resolver.ts`, `context.ts`, and `packages/agent-runtime/src/prompt-programs.ts`. The P6/P8 text files are registered and statically gated by `packages/agent-runtime/test/p6-prompt-programs.test.ts` and `p8-programs.test.ts`; source searches found no production `loadProgram(...)` call site. The driver source inspected selects the P3 `BASE_AGENT_PROTOCOL` or `WORK_EXECUTION_PROGRAM`, and passes no context fragments or body skills in the inspected path. Because those files are among pre-existing uncommitted changes, these observations are provisional until checked against a clean, named baseline.

P5 session/restart tests (`apps/single-workspace/test/p5-session-continuity.test.ts`, `p5-restart-continuity.test.ts`) establish durable session/Execution state and recovery behavior. They do not establish which historical entries are compiled into a later provider request. Likewise P6/P8 acceptance stories and prompt gates establish scripted runtime and static contract properties, not real-model judgment quality.

## Deliverable index

- `01-s1-decision-map.md` — normal work, formation, completion, verification, and aggregation.
- `02-s2-decision-map.md` — observe/inspect/steer, critical stop, local correction, autonomy, and responsibility change.
- `03-s3-decision-map.md` — collaboration, dependency/wait, help/escalation, authority, recovery, verification, and parent response.
- `04-s4-decision-map.md` — long-lived continuity, wake, freshness, reality checks, and local recovery.
- `05-atomic-module-map.md` — bottom-up grouping and minimum candidate interfaces.
- `06-coverage-matrix.md` — point-level S1–S4 and module coverage.
- `07-findings-and-open-questions.md` — findings, counts, and questions for human review.
