# Clean-baseline reconciliation

- **Reviewed:** 2026-09-25
- **Baseline:** `master@9249c7b2923bbaaea9e39a49a1e4673c8dee0983`
- **Remote comparison:** `origin/master` points to the same commit
- **Baseline worktree:** detached clean worktree at `/tmp/arbor-behavioral-clean-9249c7b`
- **Scope:** read-only reconciliation of production-path claims in `07-findings-and-open-questions.md`

The main worktree remains dirty from earlier authorized work. No implementation, prompt, contract, or test file was changed for this reconciliation. The temporary worktree was removed only after evidence collection; the original worktree and its unrelated changes were left untouched.

## Status vocabulary

- **CONFIRMED** — the clean baseline directly shows the claim.
- **REFUTED** — the clean baseline directly contradicts the claim.
- **PARTIAL** — part of the claim is true, but its scope or source is outside clean master.
- **UNRESOLVED** — the checked-out code does not provide enough evidence to decide.

“Confirmed” in this document describes the status of the finding being tested. For example, “history is not loaded” is **CONFIRMED** means the negative finding is confirmed; “history is loaded” is **REFUTED**.

## Reconciliation table

| Claim from 07 / audit question | Status | Clean-master evidence | Interpretation |
|---|---|---|---|
| Six versioned P6/P8 text artifacts exist | **CONFIRMED** | `packages/agent-runtime/promptPrograms/{formation,communication,bootstrap,human-steer,verification,query-inspection}/v1.md`; `packages/agent-runtime/src/prompt-programs.ts:13–23,76–196` | All six files and registry entries are present in the clean commit. |
| The six text artifacts have a production load/use call path | **CONFIRMED (negative finding)** | Production-source search finds no `loadProgram(...)`/`assertProgramGate(...)` call outside `packages/agent-runtime/src/prompt-programs.ts`; `loadProgram` use is in `packages/agent-runtime/test/*` and `tests/p6-acceptance.test.ts`, `tests/p8-acceptance.test.ts` | They are file-backed registry/gate assets, but no production selection/use call was found. |
| The production driver selects `BASE_AGENT_PROTOCOL` for Human Conversation | **REFUTED** | Clean `packages/agent-runtime/src/driver.ts:11–20,259–285` imports/selects only `WORK_EXECUTION_PROGRAM`; there is no `conversationInputOf`, `isHumanConversation`, or `BASE_AGENT_PROTOCOL` branch | This statement in the earlier dirty-tree review came from pre-existing uncommitted changes, not clean master. |
| The production driver selects `WORK_EXECUTION_PROGRAM` for its provider turns | **CONFIRMED** | `packages/agent-runtime/src/driver.ts:259–285` passes `program: WORK_EXECUTION_PROGRAM` on every `prepareTurn` in the driver loop | The clean path has one observed Program selection for all driver turns, including Coordination if it reaches this driver. |
| `InstructionFragment.contentRef` is materialized/resolved before compilation | **REFUTED** | `packages/model-context/src/compiler.ts:79–86` maps `text: fragment.contentRef`; no resolver/materializer call appears between `prepareTurn` and `compileTurn` | The clean compiler treats `contentRef` as the final instruction text. |
| `work:<executionId>` is sent as model-visible instruction text | **CONFIRMED** | `packages/agent-runtime/src/driver.ts:91–107` constructs `contentRef: \`work:${execution.executionId}\``; `:270–275` passes it; compiler `:82–86` copies it into `request.instructions[].text`; `packages/ports/src/provider.ts:55` defines the request field | This is a source-level production-path conclusion. A provider capture test would be the strongest runtime confirmation, but no such clean-master test was found. |
| Work `messages` are assembled in the clean production Driver | **CONFIRMED (negative finding)** | Clean `PrepareTurnInput` has no `messages` field (`packages/model-context/src/prepare-turn.ts:45–60`); clean `ModelContextPlan` has no messages field (`packages/model-context/src/compiler.ts:22–34`); compiler emits `messages: []` (`:102–106`) | There is no clean Driver message assembly path. |
| Work `contextFragments` are populated in the clean production Driver | **CONFIRMED (negative finding)** | `packages/agent-runtime/src/driver.ts:275` passes `contextFragments: []`; `packages/model-context/src/prepare-turn.ts:102–119` plans exactly that empty collection | The context planner exists, but this driver path supplies no dynamic context fragments. |
| Work body skills are populated in the clean production Driver | **CONFIRMED (negative finding)** | `packages/agent-runtime/src/driver.ts:284` passes `bodySkillIds: []`; `packages/model-context/src/prepare-turn.ts:132–136` only loads listed IDs | Skill infrastructure exists, but no body skills are supplied on this path. |
| Tools are exposed in the clean production Driver | **CONFIRMED** | `packages/model-context/src/prepare-turn.ts:127–130` calls `toolCatalog.visibleRefs()` and resolves every returned definition; `driver.ts` does not disable tools | Tool exposure is broad at this layer; Query-specific read-only filtering was not observed. |
| `SessionRepository` history is loaded into a subsequent Provider request | **REFUTED** | Driver obtains `SessionRepository` only to `appendEntry` (`packages/agent-runtime/src/driver.ts:154,415–434,553+`); no `findById`/`listEntries` call occurs before `prepareTurn`; `packages/ports/src/repositories.ts:173–224` exposes reads, but the driver does not use them | Session persistence and transcript projection do not prove model-visible continuity. |
| Session entries persist across executions/restart | **CONFIRMED** | `apps/single-workspace/test/p5-session-continuity.test.ts`, `p5-restart-continuity.test.ts` | This is storage/recovery evidence only; it does not change the previous row. |
| The “real-provider” test is an actual model call | **REFUTED for clean master / PARTIAL for dirty worktree** | `git cat-file -e HEAD:apps/single-workspace/test/p14-real-provider-conversation.test.ts` fails at clean `9249c7b`; the untracked dirty-tree file uses `OpenAICompatibleFetchClient` with custom `fetch`, fixed SSE, and constant `assistantAnswer` | The earlier finding is accurate for the dirty untracked test, but that file is not part of clean master and cannot be attributed to it. |
| P3 eval executes model behavior | **REFUTED** | `packages/model-context/src/eval.ts:53,61–83,148–160`; `CaseRunner` returns boolean and `programCaseRunner` compares program hashes | The P3 suite is a deterministic static contract/hash gate despite its test title. |
| P6 eval executes model behavior | **REFUTED** | `packages/agent-runtime/src/prompt-programs.ts:412–429`; `packages/agent-runtime/test/p6-prompt-programs.test.ts`; `tests/p6-acceptance.test.ts:1766+` | P6 checks headers, versions, hashes, mandatory clauses, forbidden phrases, and scripted runtime stories. No model call. |
| P8 eval executes model behavior | **REFUTED** | `packages/agent-runtime/test/p8-programs.test.ts`; `tests/p8-acceptance.test.ts:1503+`; P8 acceptance uses fixed domain/test inputs | P8 text gates and verification command/consumer stories are static or scripted pipeline tests. No real-model behavior evidence found. |
| Any true behavioral eval exists in the clean repository | **UNRESOLVED → no evidence found** | Search of clean `packages`, `apps`, and `tests` found no actual-model scenario runner or provider call in eval suites; `tests/p3-integration.test.ts` uses `FakeProviderLive` | “No evidence found” is not proof that no external/manual experiment exists outside the repository. |

## Clean production turn, reconstructed

For a provider turn driven by clean `AgentDriverLive`:

1. Driver resolves the Agent capability and current environment revision.
2. It calls `ModelContext.prepareTurn` with `WORK_EXECUTION_PROGRAM`.
3. It supplies two instruction fragments: `"runtime safety"` and `work:<executionId>`, plus any bounded repair fragment after a decode violation.
4. It supplies `contextFragments: []` and `bodySkillIds: []`.
5. ModelContext resolves those fragments against the WorkExecution slot contract, plans an empty context set, exposes all `ToolCatalogPort.visibleRefs()`, and selects the first output contract (`agent-directive-v1`).
6. The compiler emits instruction text exactly from each fragment’s `contentRef`, `messages: []`, model-facing tool definitions, output contract, and cache hints.
7. ProviderRuntime receives that request. The driver later appends ModelOutput and Observation entries to the Session; it does not read those entries into the next request.

This is a static source reconstruction. A request-capture test would make the conclusion observable at runtime, but adding such a test is outside this review.

## Reconciled disposition of the earlier findings

- **F-01 Prompt activation:** confirmed and strengthened. The clean driver does not load any of the six text artifacts; it selects only the P3 WorkExecution contract.
- **F-02 `contentRef`:** confirmed and strengthened. The clean compiler has a direct copy, and the clean Driver constructs the `work:<executionId>` value.
- **F-03 Session continuity:** confirmed as a negative runtime-path finding. Persistence tests pass their intended storage/restart scope but do not demonstrate request history.
- **F-04 real-provider test:** narrowed to **PARTIAL** because the cited test is untracked in the dirty worktree and absent from clean master. Its contents are fixed/mock SSE, but that is not clean-master evidence.
- **F-05 eval classification:** confirmed. P3 is static contract/hash; P6/P8 combine static gates with scripted pipeline stories; true behavioral coverage remains unproven.
- **F-06 Query boundary:** remains **UNRESOLVED/conditional**. The Query text exists, but no clean production Query activation or Query-specific capability filter was found. General tool exposure is confirmed.

## Reconciliation stop

No source, test, prompt, or contract was changed. This document records evidence only. The Batch-1 case design below intentionally avoids relying on unproven production activation and treats actual model execution as a later, separately authorized phase.
