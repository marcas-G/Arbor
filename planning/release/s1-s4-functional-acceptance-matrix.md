# S1–S4 Functional Acceptance Matrix

**Audit baseline:** `24598bbeba0dac6d1901f1f1781f7eb2c59a7f76` (`first-usable-release-v19`).
**Scope:** frozen `docs/design/00-problem-goals.md` and `01-scenarios.md`, scenario decision maps S1–S4, P1–P14/MAC, and the P36–P41 release/recovery work referenced by the v19 stream.
**Method:** read-only inspection of the default functional configs, test/catalog sources, and qualification records. No tests or builds were run for this matrix. This file is a planning audit; it changes no design or production contract.

## Decision summary

The repository has substantial deterministic and component coverage, and it has recorded public black-box passes for a small end-to-end S1–S4 slice. That evidence does not cover the whole frozen scenario set. The scenario map defines 49 decision points; 31 are model decisions and 10 are mixed decisions. The mixed points require both a mechanical invariant test and a separate semantic evaluation. The eight deterministic points are not candidates for model scoring.

At this exact baseline, there is no recorded terminal `pnpm check` + `pnpm test:functional` result. The nearest full report is `planning/results/P36-integrated-full-qualification.result.md` at `6ee3ccd9248defae439e57f01cc4b339cc32d641`, an ancestor of this baseline: it reports `pnpm check` PASS and functional Vitest 171/171 plus Playwright 7/7. It is **historical SHA evidence**, not an exact-baseline or final-release run. The report itself says that this is not release readiness and leaves AH7, P37–P41 and multi-subject behavior open.

The following evidence labels are used throughout:

| Label | Meaning |
|---|---|
| `PB@24598` | Public process/browser PASS recorded on the exact audit SHA. No such terminal batch record was found; do not infer one from test source being present. |
| `PB historical` | Public process/browser PASS reported on another SHA. Useful history, not current-candidate qualification. |
| `SQLite crash` | Real daemon/process and restart evidence whose oracle reads or mutates internal SQLite/ledger state. Counts for recovery qualification, not user-visible functional acceptance. |
| `Component` | Unit, adapter, application, architecture or scripted fixture coverage. Proves encoded mechanics, not whole-product behavior. |
| `Source only` | Test code/probe exists but no terminal passing run is recorded. |
| `Open` | No adequate evidence located, or explicitly blocked by a design/implementation gap. |

| `Model eval missing` | Deterministic fake-provider paths exist, but semantic behavior has not been assessed with a real model or an explicit evaluator. |

## Current candidate addendum — 2026-10-24

The detailed matrix below remains an audit of its named historical baseline.
On current candidate `5b8482c9a1c1712e2298630c3b52df581541fd9e`, the full
`pnpm check` command passed once continuously; see
[`pnpm-check-5b8482c9.result.md`](../results/pnpm-check-5b8482c9.result.md).
The full functional suite, package/clean-checkout gate, representative
real-provider S1–S4 qualification, Native OS sandbox support, and release
readiness remain **OPEN**. S3 AnyProducer, S4 assistant-message projection,
and P12 D2/D4 progress convergence implementations are now accepted/landed
and have scoped deterministic verification; none of those implementation
results alone closes its broader scenario or release qualification.

## Public journey and subsystem evidence

| Area | Evidence found | Grade and remaining qualification |
|---|---|---|
| S1–S4 public black-box slice | `tests/capability/black-box/s1-s4-public-api.test.ts`; `planning/results/S1-S4-black-box-validation.result.md` reports 4/4 public process journeys: first-layer formation, exact approval/Work, verification/acceptance, steer, and restart continuity. | `PB historical` plus limited real-provider B-sentinels; no exact `PB@24598` terminal record. It covers one happy path per scenario, not each S1–S4 branch. F23 alignment later fixed command-origin setup and reports 4/4 on its own run; that is still a fake-provider scenario, not broad semantic evaluation. |
| F01–F20, F22 | `planning/testing/functional/01-functional-journey-catalog.md`; process/browser sources under `tests/functional/`; full report at P36 SHA `6ee3ccd…`. | `PB historical`. The P36 report records 171/171 process/package tests and 7/7 browser journeys. It is a prior SHA and explicitly not an overall release-readiness claim. |
| F21 / project resource boundary | `tests/functional/ui/f21-project-resource.spec.ts`; resource-admission public-process source remains in `tests/functional/pending/resource-admission.functional.test.ts`. | Browser Profile selection and forged-reference cases are included in the P36 reported 7/7 run. Open questions in FT-DG-01 v3 include profile-source audit, old-v1 same-ID receipt compatibility, and post-commit durable Attention. UI journey alone does not qualify all those branches. |
| F23 / external typed commands | `tests/functional/process/command-input-validation.functional.test.ts`, `f23-receipt-tuple-ordering.functional.test.ts`; negative receipt-integrity matrix in `tests/functional/pending/f23-exact-tuple-receipt-integrity.functional.test.ts`. | Some public-process PASS is reported in later qualification notes, but exact SHA status must be checked. Receipt tuple mutation/replay branches stay `Source only` while under pending. Do not promote them by source presence. |
| AH1–AH6, AH8–AH9, AH11–AH13 | `planning/testing/functional/02-agent-loop-step-crash-qualification.md` and linked result records. | `SQLite crash` at the named boundary sides, with local public response assertions in several cases. This is strong recovery evidence, not proof of every S4 semantic or public UI outcome. |
| AH7 / AH10 / AH14 | Same qualification plan and `planning/testing/functional/04-open-governance-queue.md`; open negative branches include non-Success Observation replay, active Reconcilable reality proof, approval/settlement atomicity, stale Deliver fencing, verification-command replay, and ambiguous legacy Attention. | `SQLite crash` is partial; multiple named gaps remain `Open`. Never infer closure from F16, isolated race tests, or the successful AH1–AH6 matrix. |
| P36 | `planning/results/P36-integrated-full-qualification.result.md` and independent review. | Full reported gates at `6ee3ccd…`, but it expressly excludes overall AH7 closure, approved executable InvocationApproval handoff, P37–P41 and multi-subject behavior. It is an ancestor SHA, not a qualification of `24598bb`. |
| P37 DeliverMessage / replay Attention | `planning/results/P37-layered-qualification.result.md`; L6 matrix source at `tests/functional/pending/p37-delivermessage-process-crash.functional.test.ts`; capacity source at `p37-deliver-replay-capacity.functional.test.ts`. | Layer 1 component qualification is reported PASS on another frozen candidate; L6 crash/restart and F19 integration are explicitly pending in the result. L6 is `Source only`; four profile-dependent P12 capacity cases are TODO pending a selected deployment profile. |
| P38 executable approval | `tests/functional/process/p38-executable-approval-public.functional.test.ts`, `tests/functional/ui/p38-executable-approval-browser.spec.ts`; detailed qualification `planning/results/P38-layered-executable-approval-qualification.result.md`. | Five focused cases are reported PASS on candidate `ec79ad0`, but no full `pnpm check`/`pnpm test:functional` was run for that qualification. The process tests read SQLite to prove internal binding/settlement, so count them as mixed public-input + `SQLite crash`/ledger evidence, not strict functional oracles. Migration compatibility and complete P38 closure remain open. |
| P39–P41 | Candidate evidence is in separate worktrees: P39 `9533b35` (maintenance) / `ee098f9` (reality proof), P40 `d59b1dc` (runtime), P41 `0853b67` (runtime). The v19 default configuration at `24598bb` does not include these as integrated release qualification. | P39 record says implementation checkpoint, no Vitest/daemon/migration/full gates or Windows VFS/VM hard-power qualification; P40 process source is pending and unrun, migration unregistered; P41 runtime record says centralized qualification pending, with pending migration-prefix and binding-corruption cases. These are `Source only` / checkpoint evidence, not default-suite PASS. Require approved integration, default discovery, focused qualification and a full release run on one final SHA. |
| Existing user database upgrade | Migration/component fixtures exist, including P36 schema migration and P37/P38 migration work. F20 is a clean packaged checkout smoke. | No end-user preserved-database upgrade journey was found that starts from a captured supported prior-version DB, opens it through normal product startup, verifies retained user data/configuration, then resumes work through public UI/API. `Component` plus fresh-install evidence is not this upgrade qualification. |
| Real configuration / restart | Provider compatibility and selected DeepSeek L3 sentinels exist; functional tests use a deterministic HTTP provider. P5/P9/AH tests cover various restart paths. | No single user journey proves a configured real provider + user-owned secrets/config, existing DB upgrade, app/Web start, and continuation after restart together. This remains a required final delivery qualification. |

## P1–P14 and MAC observable contract links

This is a coverage crosswalk, not a claim that every phase result is a user-facing PASS. Component/architecture closure qualifies the implementation contract at its own layer; the last column is the end-user acceptance still needed for full S1–S4 delivery.

| Contract area | Main S1–S4 decision points / journey | Existing observable evidence | Missing end-user qualification |
|---|---|---|---|
| P1 Commands, project and Work write boundary | S1-DP03/04/07; S2-DP14; F01/F03/F04/F23 | F01/F03/F04 public paths; F23 input/receipt tests, with exact release SHA qualification still required. | Existing-DB upgrade/replay journey; all malformed branded IDs and exact receipt replay through the public process. |
| P2 Execution admission and recovery ownership | S1-DP07; S3-DP23/30/36; S4-DP37/43 | F06/F16 and selected AH/P9 restart cases; component coverage for scheduler and fencing. | Observable no-poll idle, same episode resume, multi-subject/owner isolation, public Attention on fail-closed recovery. |
| P3 Agent loop, continuation and model context | S1-DP05/08/09/12; S2-DP16/19; S4-DP38/44/46/47 | Scripted provider process journeys and AH crash cases; P3 context/driver tests. | Real-model action quality, proof of exact model-visible resumed frontier, relevant history selection and correction absorption. |
| P4 Tool runtime, side effects and approval | S1-DP05; S2-DP18; S3-DP30/32/33; S4-DP40/41 | Tool capability/component tests; P38 focused process/browser evidence exists on a separate candidate; AH7 partial crash suite. | Integrated executable approval + real effect, Stop/reconcile, non-idempotent crash/replay, and public unknown outcome. |
| P5 Workspace/Work lifecycle | S1-DP03/05/07/12; S2-DP19/20; S4-DP37/49 | F04/F05/F07/F18/F22 public slices; P5 continuity/component tests. | Parent-level sufficiency, supplementary Work, transfer vs update, long idle and recurring Work continuation. |
| P6 communication, Inbox and governance | S1-DP04/11; S2-DP17/20; S3-DP22/25–29/36 | Formation/approval F03/F18; MAC formation and selected real-provider B06–B07; communication components. | Public Message/DecisionRequest/Reply journeys for solvable/escalated cases, queue-vs-wake, parent integration, critical-stop interactions. |
| P7 dependencies, delivery and wake | S1-DP06/11; S3-DP23/24/36; S4-DP37 | F19 both event orders on older qualification; P7 coordinator tests. | Requalify F19 with the exact integrated P37/P38 candidate, then test pending L6 Deliver replay and public Attention after restart. |
| P8 verification, Acceptance and Completion | S1-DP07–10; S3-DP34/35; F05/F12/F13/F22 | Public PASS/FAIL/Unknown/Acceptance/Work Detail slices; P8 component contracts. | Real-model verdict adequacy and claim honesty; duplicate/missing evidence and stale verification end-to-end cases. |
| P9 durability, faults and recovery | S2-DP18; S3-DP32/33; S4-DP37/40/41/43 | F06/F09/F16, dense-SSE lease evidence, AH crash matrices; AH7/AH10 gaps remain. | Complete AH7/AH10/AH14 closures, P37/P40 cross-contract crash matrix, public reconcile/Attention outcome. |
| P10 Attention and views | S2-DP14/18; S3-DP23/29/36; S4-DP37/42 | F03/F14/F22 and view/Attention component tests. | Public Attention for all RecoveryBlocked/approval/replay states; no sensitive leak; wake/ACK durability after restart. |
| P11 environment, revisions and ControlBasis | S2-DP15/16/20; S4-DP39/45/48 | Drift, staleness, ownership and revision component tests. | Model recognizes which public resource/environment deltas invalidate which result and limits rework to affected Work. |
| P12 platform, auth, provider and storage boundaries | S2-DP14/18; S3-DP30/31; S4-DP37/41 | P12 component, architecture, provider qualification and release `pnpm check` history. | Real configured provider + credentials/config + upgraded DB + browser task/restart on one final candidate; multi-subject authorization/isolation. |
| P13 Web client | S2-DP14–20; F08/F09/F14/F15/F21/F22 | P36 historical Playwright 7/7; UI source covers project, conversation, approvals, resource choice, Work Detail and route/session. | Integrated browser coverage for Child/Dependency/Deliverable, stop/reconcile, existing data upgrade and resumed provider/config state. |
| P14 conversation and transcript | S1-DP01/13; S2-DP15/19; F02/F08/F09/F17 | Public Root transcript and conversation/restart/pagination slices. | Semantic clarification, stage closeout, context restraint and user-authorized next stage with real model. |
| MAC-P1 single-Workspace golden path | S1-DP01–10/12; S2-DP15/16/19; S4-DP38 | Historical public Root→Work→Verification→Acceptance black-box and B01/B03/B11 sentinels. | Semantic readiness/sufficiency, exact final-candidate run, and browser completion under user configuration. |
| MAC-P2 formation and existing Child assignment | S1-DP02/04/06; S3-DP25–28/36 | F18 and MAC-P2 real-provider formation sentinel (B07); component/functional result notes. | Deep-level responsibility quality, transfer, Parent sufficiency, and Child return/wake cases in the final default batch. |
| MAC-P3 cross-Work communication/delivery | S1-DP10/11; S3-DP22–29/36; S4-DP37 | F19 two-order public flow and B09 delivery sentinel in historical qualification. | Re-run on P37 integrated branch; P37 L6 process matrix, attention recovery and capacity profile. |
| MAC-P4 optional subagent and convergence | S1-DP06; P4 approval convergence; single-Agent stop condition | Design/architecture tests state no subagent action is registered; single-Agent public flows. | No subagent feature is required by the accepted v1 optionality stop condition. Remaining approval convergence belongs to P38/P39 integration and must be tested there. |

## Scenario-level functional acceptance

| Scenario | Present public evidence | Required completion evidence |
|---|---|---|
| **S1 — normal long-running progress** | Public happy path creates a Project, discusses a goal, obtains exact approval, creates Work, verifies PASS and records Acceptance. F10–F13 add rejection, transient provider recovery, FAIL and Unknown. F18/F19 add child result and dependency delivery. | Public/browser cases for discuss-vs-clarify, solo-vs-split, first-layer adjustment, child subdivision, asynchronous result sufficiency, supplementary Work, and stage-level summary. Model judgment must be scored separately from command shape and deterministic consumer transitions. |
| **S2 — observe, inspect, correct, stop** | Public tree/detail reads and foreign-workspace route isolation; F07/public SteerWork proves revision advance and later turn consumes the steer. P38’s Queue UI is focused approval evidence, not general intervention coverage. | A paired browser/process matrix: inspection leaves Work/execution unchanged; local correction preserves unaffected work and resumes autonomously; high-level change returns to Root; ordinary steer does not preempt; Critical Stop prevents new actions, preserves completed effects, and surfaces uncertain work for reconciliation. P38 Stop cancellation is pending in this baseline family. |
| **S3 — coordination and abnormal paths** | F18 and F19 public journeys; selected P6/P7 component tests; AH10 control action takeover evidence and P38 exact action approval on separate candidates. | Public Parent/Child message, query, decision request/reply, permission denial/adaptation, wait-with-independent-work, arrival while waiting vs busy, and Parent integration/supplementary Work journeys. P37’s L6 DeliverMessage + Attention crash matrix and F19 integration must pass on one integrated candidate. |
| **S4 — durable continuity and recovery** | F06/F09/F16/F22 public history/restart/inspection; P5/P9 mechanical continuity; named AH crash cases. | Idle means zero repeated model calls until a relevant event; preserved data upgrades without loss; re-entry receives a sufficient local work spine; changed requirements/environment alter only affected decisions; unknown effects get real read/reconcile evidence and no blind replay; only affected Work wakes/restarts. Include browser-visible attention/results after restart. |

## Decision-point matrix (all 49)

`D` denotes deterministic contract; `M` model judgment; `X` mixed. Functional oracle is the externally visible observation that a user or Parent can verify; internal ledger facts belong only in the separately named crash qualification.

| DP | Decision / owner | Evidence grade at audit baseline | Minimum additional evaluation and user-visible oracle |
|---|---|---|---|
| S1-DP01 | Ready to leave discussion? `M` | `Model eval missing`; P14 admission/storage is component coverage. | Real-provider paired goals with decisive ambiguity vs sufficient brief; ask a relevant clarification only in the former, visible in Root transcript. |
| S1-DP02 | Is first-layer division worthwhile? `M` | `Model eval missing`; Root assignment sentinel is narrow. | Real-provider solo task vs independent-parallel responsibilities; compare proposal rationale and avoid needless child creation. |
| S1-DP03 | Human confirms/adjusts first split? `D` | `PB historical` exact Inbox approval path. | Browser confirms/edits/rejects proposal; tree changes only after the exact decision and names match accepted changes. |
| S1-DP04 | What are first-layer scopes/interfaces? `M` | `Model eval missing`; formation schema/authority mechanics exist. | Score bounded responsibility definitions for coverage, non-overlap, dependencies, and verifiable outcomes; render proposed tree before approval. |
| S1-DP05 | What is the next Work action? `M` | `Model eval missing`; Work/Tool scripted paths. | Real-provider tasks with inspect/plan/act choice; visible Work progress and action match constraints, no unauthorized effect. |
| S1-DP06 | Self-do, serial split, or parallel split? `X` | `Model eval missing`; Runtime enforces placement and limits. | Paired simple/serial/parallel task; score when it delegates and prove tree/Work results publicly reflect only justified decomposition. |
| S1-DP07 | Start independent verification after claim? `D` | `PB historical` F05/F12/F13; verifier consumer unit/process coverage. | Public flow: claim creates a separately visible Verification; no PASS or Work completion before verifier result. |
| S1-DP08 | PASS, FAIL, or Unknown? `M` | `Model eval missing`; fake-provider verdict cases pass mechanics only. | Real-provider rubric with adequate evidence, contradictory evidence and unavailable environment; require evidence-linked verdict and visible reason. |
| S1-DP09 | Repair, gather evidence, or escalate after verdict? `M` | `Model eval missing`; repair/retry components. | Feed FAIL vs Unknown evidence; same owner repairs FAIL, adds evidence or asks for ruling on Unknown; show next Work/Verification state. |
| S1-DP10 | Is child PASS sufficient for Parent? `M` | `Model eval missing`; acceptance command guard only. | Paired complete/incomplete child outcomes; Parent accepts first and creates named supplementary Work for second without changing child PASS. |
| S1-DP11 | What result summary goes upward? `M` | `Model eval missing`; P6 payload/routing components. | Compare bounded summary against evidence; Parent can decide next step without raw transcript, while critical evidence and unknowns remain visible. |
| S1-DP12 | Has overall stage reached goal? `M` | `Model eval missing`; P5/P8 canonical lifecycle coverage. | Multi-Work stage with one open material gap; Root continues until resolved, then gives a grounded stage summary and no premature completion. |
| S1-DP13 | What next after stage completion? `M` | `Model eval missing`; P14 conversation input mechanics. | Real-provider completion then user has not authorized next stage; answer summarizes and asks/awaits direction without opening Work. |
| S2-DP14 | Does inspection remain read-only? `D` | `PB historical` route/view tests; component projection tests. | Browser inspect tree/detail while a Work is active; before/after public current Work, revisions and queue are identical. |
| S2-DP15 | Local steer or high-level change? `M` | `Model eval missing`; explicit `SteerWork` and Root conversation are separate. | Paired local constraint vs project-goal/ownership change; visible local Work update vs Root-level clarification/proposal, no silent transfer. |
| S2-DP16 | How should correction revise current work? `M` | `Model eval missing`; F07 verifies steer arrives, not quality of absorption. | Real-provider correction retaining valid artifact plus invalidating one assumption; later public action uses new fact and preserves unrelated progress. |
| S2-DP17 | Does input require Critical Stop? `X` | Explicit stop/steer mechanics are component-tested; natural-language classification `Model eval missing`. | Contrast “please reconsider” with explicit high-risk stop; measure false stop and missed stop; public queue/status proves the chosen path. |
| S2-DP18 | What is safely stopped/in flight? `X` | `Component` + partial `SQLite crash` for recovery; no complete browser stop journey. | Stop during read-only, idempotent and uncertain external effects; public result says stopped/reconcile required, preserves completed effect and blocks new tool calls. |
| S2-DP19 | Resume autonomy after correction? `X` | F07 gives narrow `PB historical`; no test of avoiding repeated asks. | After a complete local correction, real model proceeds to a concrete next action without “continue?”; if blocked, one specific request is visible. |
| S2-DP20 | Update responsibility or transfer it? `X` | `Model eval missing`; ownership transfer invariants/components exist. | Paired scope/owner-change prompts; no silent parent change; explicit transfer proposal includes artifacts/open Work and old owner history remains inspectable. |
| S3-DP21 | Self-resolve, tool, or decompose? `M` | `Model eval missing`; B02 tool and B03 control are narrow sentinels. | Real-provider local problem with allowed tool, missing capability and decomposable subtask; score useful choice and visible bounded action. |
| S3-DP22 | Query/read, communicate, or continue? `M` | `Model eval missing`; message and view command mechanics. | Provide a resolvable fact, unavailable fact and external peer result; observe justified query vs exact message vs local continuation. |
| S3-DP23 | Route result/wake correct Work? `D` | `PB historical` F19 wait→delivery order; P7 coordinator tests. | Same result declared before/after wait; correct exact consumer wakes once, public Dependency is Satisfied and unrelated Work stays unchanged. |
| S3-DP24 | Wait or do independent work? `M` | `Model eval missing`; P7 wait graph tests are mechanical. | Give one blocked dependency and one independent action; show the independent Work progresses while the exact dependency wait remains visible. |
| S3-DP25 | Ask direct Parent after local attempts? `M` | `Model eval missing`; P6 send route/authority tests. | Provide solvable vs genuinely blocked local cases; only latter creates a Parent DecisionRequest with exact needed ruling/resource. |
| S3-DP26 | Is help request sufficient? `M` | `Model eval missing`; message schema tests. | Score request includes objective, blocker, attempts, unresolved choice and requested action; Parent can answer without transcript dump. |
| S3-DP27 | Can Parent resolve or must escalate? `M` | `Model eval missing`; inbox and message transitions are component-tested. | Pair in-scope evidence with policy/authority gap; reply locally in first, forward bounded correlated request in second. |
| S3-DP28 | Escalate ruling or transfer ownership? `X` | Canonical tree constraints are mechanical; semantic distinction `Model eval missing`. | Parent cannot rule but remains owner vs owner truly changes; visible escalation leaves tree intact, transfer requires governed handoff. |
| S3-DP29 | Does ordinary request preempt busy Parent? `X` | Inbox/wait/critical gates are component-tested; relevance/urgency `Model eval missing`. | Busy Parent + ordinary child request vs explicit Critical Stop; ordinary request queues, critical path fences new work, each visible in Inbox/Attention. |
| S3-DP30 | Is operation authorized? `D` | `Component`; P4/P12 authority tests; no P38 default integration at audit baseline. | Public API/UI attempt out-of-scope operation; typed denial and no visible effect, then confirm valid exact grant admits only scoped operation. |
| S3-DP31 | Useful next move after denial? `M` | `Model eval missing`; denial mechanics only. | Give safe alternative, exact approval route, or no-safe-path scenario; model adapts once or asks Parent, never repeats denied action. |
| S3-DP32 | Retry, change method, escalate, or reconcile? `M` | `Model eval missing`; F11 provider 503 behavior covers one deterministic retry. | Contrast known transient provider error, terminal auth error, tool failure and ambiguous side effect; user sees bounded retry/alternative/request and truthful state. |
| S3-DP33 | How to handle unknown external effect? `X` | `SQLite crash` partial; AH7-DG-01/02 and AH10 Deliver gaps remain. | Crash after real effect before receipt; public recovery must query/reconcile or surface Unknown/Attention, never claim success/failure or blind replay. |
| S3-DP34 | Is producer ready to claim completion? `M` | `Model eval missing`; P5 claim transition tested with scripted inputs. | Near-complete vs unmet expectation; no premature claim in latter, user sees open Work and targeted next action. |
| S3-DP35 | Child verification verdict? `M` | F12/F13 prove scripted public branches; `Model eval missing` for evidence adequacy. | Real-provider evidence sets: sufficient, contrary, missing/unstable; visible criterion verdict is evidence-grounded and distinct from Parent acceptance. |
| S3-DP36 | Wake, queue, or integrate result upward? `X` | F18/F19 prove some routing/wake mechanics; Parent relevance/summary `Model eval missing`. | Result arrives while Parent waits vs busy; exact waiter wakes, busy Parent sees Inbox, real model integrates only decision-relevant facts upward. |
| S4-DP37 | Remain durable and idle until trigger? `D` | `Component`/`PB historical` restart and timer tests; no complete idle-zero-call journey. | Hold completed/no-work responsibility idle for bounded interval; no provider calls; event-triggered wake occurs once and is user-visible. |
| S4-DP38 | Which context restores enough continuity? `M` | `Model eval missing`; P5/P9 persistence and F06/F09 do not assert model-visible context. | Resume after new request and after crash; Provider request includes responsible Workspace, frontier, key verified result/failed path and relevant pending item without full old transcript. |
| S4-DP39 | What changed while stopped? `M` | P11 drift/staleness tests are `Component`; no semantic evaluation. | Add relevant and irrelevant changes during idle; model cites relevant change and adapts only affected Work; unrelated branch is preserved. |
| S4-DP40 | What actually happened around external effect? `X` | `SQLite crash` partial via AH/P9; no full real-world reconciliation behavior. | Use external canary whose state can be queried after kill; model reports complete/not done/unknown from query evidence and public action history. |
| S4-DP41 | May uncertain effect be replayed? `D` | `Component`/partial `SQLite crash`; AH7-DG-02 and AH10 Deliver fencing still open in records. | Inject effect-before-settlement for idempotent, non-idempotent and Reconcilable tools; public side effect count stays one or explicitly documented safe retry, otherwise visible Attention blocks. |
| S4-DP42 | When ask for a ruling? `M` | `Model eval missing`; P6/P9 routing mechanics only. | Make available reconciliation evidence insufficient; visible DecisionRequest names the unknown, attempted checks and exact ruling needed. |
| S4-DP43 | Limit recovery to interrupted part? `D` | `Component` P7/P9 recovery tests; local/public effect not fully asserted. | Kill one child while sibling remains active; restart recovers only affected Work and preserves sibling’s public status/result. |
| S4-DP44 | Return to normal S1/S3 or remain blocked? `M` | `Model eval missing`; fixed action recovery scripts only. | After cleared recovery, require next task/dependency action appropriate to frontier; no repeated recovery ritual or reopening completed Work. |
| S4-DP45 | Which historical conclusions are stale? `M` | P11 mechanical invalidation tests; semantic selection missing. | Change code/resource/environment behind one old conclusion; model rechecks invalidated claim and reuses still-current evidence, visible in action trace/result. |
| S4-DP46 | Reuse prior conclusions and failed paths? `M` | `Model eval missing`; P5 persistence only. | Re-enter recurring responsibility with a known failed approach and successful verified result; continue from former frontier and avoid repeating failure. |
| S4-DP47 | How much history is sufficient? `M` | `Model eval missing`; P3 context budget/data-shape tests only. | Long history with relevant and distractor facts; provider request carries minimum sufficient pulse; answer uses needed fact and does not expose irrelevant project history. |
| S4-DP48 | Which environment drift changes plan? `M` | P11 drift/ControlBasis tests are `Component`; impact interpretation untested. | Pair irrelevant environment update with a material resource change; continue in first, inspect/reconcile in second, cite changed source in visible result. |
| S4-DP49 | Continuation or new responsibility after long delay? `M` | `Model eval missing`; P5 continuity + P6 formation mechanics only. | Same owner/scope bug repair vs genuinely changed long-term owner/outcome; continue existing Workspace in first, propose governed transfer/new responsibility in second. |

## Minimal real-model evaluation plan

Do not make 41 scripted scenarios and call them model-behavior coverage. Keep deterministic and model-semantic evidence separate. A small, useful real-model suite can start with seven rubric-scored scenario families; each family should have counterfactual paired prompts and at least three independent runs on the supported production binding. Store provider/model/version/config fingerprint, prompt/context manifest, raw public inputs/outputs, selected actions and rubric adjudication. Human review decides ambiguous semantic scores; mechanics remain asserted through public views/process outcomes.

| Family | DPs | Minimal variation | User-visible oracle |
|---|---|---|---|
| Clarify vs organize | S1-DP01/02/04/06/13 | Ambiguous vs clear; simple vs independent parallel; no next-stage authorization. | Clarifying question, proportional work proposal, or wait; no unapproved Work or needless child. |
| Execute/check/repair | S1-DP05/08/09/12; S3-DP34/35 | Complete evidence, contrary evidence, missing evidence, temporarily unavailable checker. | Work remains Open until correct verdict/Acceptance; repair or evidence request matches result. |
| Parent sufficiency and reporting | S1-DP10/11/12; S3-DP36 | PASS result sufficient vs PASS but incomplete for parent; Parent waiting vs busy. | Accept vs supplementary Work; concise evidence-linked summary; wait wake or Inbox queue. |
| Human correction and control | S2-DP15–20; S3-DP29 | Local fix, high-level direction, responsibility transfer, ordinary message, critical stop. | Correct target changes; unaffected progress retained; no silent transfer/preemption; stop visibly fences new work. |
| Dependency, help, and authority | S3-DP21/22/24–31 | Independent task during wait; solvable vs unsolved Parent request; allowed alternative vs denied capability. | Relevant action continues, exact request routes to Parent, forbidden effect absent, dependency status visible. |
| Fault and external reality | S3-DP32/33; S4-DP40–42 | Transient known failure vs unknown external effect; queried complete/not complete/unsettled reality. | Bounded retry or real reconciliation; no fabricated success, no blind replay; explicit Attention/ruling if unresolved. |
| Long-term continuation and drift | S4-DP38/39/44–49 | Re-entry with relevant/irrelevant changes, failed path, old result, same vs changed owner/outcome. | Correct old Workspace and frontier resume; only stale/relevant work is revisited; new ownership requires governed proposal. |

Mechanical invariants in S2-DP14/17/18/20, S3-DP23/28/29/30/36, S4-DP37/41/43 still need their own public/API/browser or process qualification as specified above. A model rubric cannot replace those tests.

## Required release stratification and order

1. **Baseline correctness:** run `pnpm check` and `pnpm test:functional` on one exact candidate SHA, zero retries, retaining the full command output and test counts. The current audit SHA has no such terminal record; prior `6ee3ccd…` is historical.
2. **S1–S4 public journeys:** add the missing public-process/browser scenarios above and expose only public `/commands`, `/views`, transcript, Inbox, Current Work, Work Detail and provider-boundary call counts as pass oracles. A separate crash suite may read SQLite, but label it `SQLite crash` and do not credit it as journey acceptance.
3. **P37 dependency:** finish L6 source-only real-process matrix and F19 cross-work delivery/wake on the same integrated candidate. Include P9 durable DeliverReplay/Attention and P10 marker-before-ACK behavior after restart; select/document P12 capacity profile before claiming capacity.
4. **P38 executable approval:** retain the focused browser queue proof, then add end-user-only approval details and public outcomes for approve/reject/expire; qualify migrations, expiry/Stop races and two-daemon claim/consume boundaries separately. Re-run the full default suite after integration.
5. **P39–P41 convergence:** treat existing separate branch/worktree results as candidate evidence only. Merge approved implementation into the release candidate, move required cases into default discovery (or explicitly make them release gates), and prove recovery binding, maintenance/reality proof, Observation replay and decision-binding failure behavior through named layered tests and a final full batch.
6. **Existing user data:** create versioned, sanitized database fixtures from each supported prior schema and start the real daemon using normal startup/migrations. Verify public Work/tree/transcript/Inbox/Verification/artifact/config state before/after upgrade, issue a new command, hard-restart, and verify no duplicate provider/effect. A clean clone/F20 proves installability, not upgrade safety for an existing user database.
7. **Real configuration:** in an opt-in final qualification, use a real supported provider binding and user-provided configuration/secret references in a fresh isolated environment; verify resolved model fingerprint, authenticated provider call, Web flow, restart and continuation. Never serialize secret material into manifests or artifacts.

## Source index

- Frozen goals/scenarios: `docs/design/00-problem-goals.md`, `docs/design/01-scenarios.md`.
- Behavioral scenario maps and 49-row map: `planning/behavioral-eval/01-s1-decision-map.md` through `04-s4-decision-map.md`, `planning/behavioral-eval/06-coverage-matrix.md`.
- Functional contract/config: `planning/testing/functional/00-functional-test-strategy.md`, `planning/testing/functional/01-functional-journey-catalog.md`, `vitest.functional.config.ts`, `playwright.functional.config.ts`.
- Historical broad gate: `planning/results/P36-integrated-full-qualification.result.md` and `planning/results/P36-integrated-full-qualification.review.md`.
- P37/P38 staged evidence: `planning/results/P37-layered-qualification.result.md`, `planning/results/P37-L6-process-crash-matrix-checkpoint.result.md`, `planning/results/P38-layered-executable-approval-qualification.result.md`, `planning/results/P38-expiry-and-replay-runtime-checkpoint.result.md`.
- Existing functional journey audit: `planning/results/functional-release-coverage-audit.result.md`, `planning/results/FT-functional-oracle-audit.result.md`, `planning/results/S1-S4-black-box-validation.result.md`.

## 2026-10-12 integration status addendum

This matrix remains the read-only coverage audit for its stated `24598bb`
baseline. Later source integration is tracked in
[`full-delivery-integration-ledger.md`](../results/full-delivery-integration-ledger.md).
The integrated AH7 docs and focused P38 process/migration results do not close
AH7/P38 or provide broad S1–S4 acceptance. P37's unchanged L6 matrix now has
integrated split-run qualification: rerun 3's eight observed passes plus
rerun 4's three remaining passes, with F19 forward/reverse delivery 2/2. The
full default functional suite remains unrun on this candidate. F23 test source
is present, but its Vitest invocation was interrupted and is not a pass. No
full gate or model evaluation was run on the integration candidate, so the
historical `PB@24598` and `Model eval missing` labels are unchanged.

AH7's accepted classification adds focused accepted-baseline evidence (G0/G1
and live-lease process 2/2; Store 3/3). The copied-holder diagnostic run had a
strict RED, and its remaining Runtime diagnostics were not rerun after removing
a duplicate Store case. This does not change the matrix's broad scenario
coverage grades or close AH7.

## 2026-10-24 S3 AnyProducer public-process addendum

On exact candidate `617c34d6fea03e311701a7570df962bb84534f87`, the scripted
public-process case
`tests/functional/process/s3-any-producer-wait-recovery.functional.test.ts`
passed with command
`pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/s3-any-producer-wait-recovery.functional.test.ts --maxWorkers=1 --retry=0 --no-file-parallelism`
(exit 0, 1 file / 1 test, test 14,000 ms, total 36.13 s). It proves only the
public denial/recovery slice for an unsupported AnyProducer declaration: no
Dependency or WorkWait is committed and the model asks the user for
clarification. The provider is scripted. This is not real-model or real-provider
evidence, does not change the `PB@24598` historical baseline, and does not close
the broader S3 coordination/wait/integration scenario or S3 real-provider
qualification. Keep the existing S3 model-evaluation and end-to-end gaps open.

## 2026-10-24 S2 SteerWork revision scripted-process addendum

On exact candidate `410695f9fa1b58905d42c33b5ac0f9d1ad7e17c2`,
`tests/functional/process/s2-steer-work-revision.functional.test.ts` passed
1/1 with retry 0; test 44,593 ms, total 64.79 s. Command:

```text
pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/s2-steer-work-revision.functional.test.ts --maxWorkers=1 --retry=0 --no-file-parallelism
```

This scripted public-process journey covers DirectionGuidance,
revision-2 ContractAmendment, exact Critical Stop binding, old-Verification
rejection, hard restart and same-command replay, then revision-2 Verification
and Acceptance. For the stopped Execution, the oracle permits the held
pre-commit ProviderTurn to settle but requires no ToolInvocation or completion;
a newly scheduled revision-2 Execution is not part of that exact-execution
quiescence assertion.

This is one deterministic-provider process qualification, not real-provider or
model-quality evidence, not full S2 scenario closure, and not a complete release
gate. It does not change the audit labels and scope of the historical
`24598bb` baseline above. The two oracle corrections are documented in
[`S2-steer-work-revision-l2.result.md`](../results/S2-steer-work-revision-l2.result.md):
first, allow the already-held request's durable ProviderTurn; second, remove a
global provider-call count because a revision-2 Execution may legitimately be
scheduled after the stopped revision-1 Execution settles. Real-provider S2 and
the broader S1–S4 matrix remain OPEN.
