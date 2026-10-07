# Arbor — Agent Guide

Arbor is a multi-agent work system organized around long-lived Responsibilities, not chat sessions. Read `docs/design/00-problem-goals.md` first; the rest of the chain explains HOW.

## Document chain (ownership)

| Doc | Owns | Status |
|---|---|---|
| `docs/design/00-problem-goals.md` | WHY/WHAT: P1–P8, G1–G8, mission, success criteria | FROZEN |
| `docs/design/01-scenarios.md` | Observable end-to-end behavior S1–S4 | FROZEN |
| `docs/design/02-system-design.md` | Domain semantics, Runtime boundaries, 76 system invariants | FROZEN |
| `docs/design/03-detailed-implementation-design.md` | Executable contracts: ADT/Command/Event/Ports/SQL/Package DAG/phases | TOP-LEVEL FROZEN |

These four files are the latest frozen baselines (Problem & Goals v1.3,
Scenarios v1.3, System Design v1.9, DID v1.31).

## Design governance (docs/design/**)

```text
docs/design/** = manually governed source of truth
               = MUST NOT be modified by the Planning Agent
               = MUST NOT be modified by the Coding Agent
```

Only manual governance changes design documents, and only in the document that owns the semantics. Never silently rewrite upstream semantics from implementation code or planning artifacts.

Manual-governance delegation exception (authorized 2026-10-01): after the
user/manual governor explicitly accepts a fixed governance proposal, Codex may
apply that exact accepted landing package to `docs/design/**` on the governor's
behalf. The proposal hash, decision record, owning-document revisions and
post-landing consistency review must remain auditable. This exception does not
permit Codex to invent unaccepted semantics or silently resolve a new gap.

If a code implementation discovers a design gap: **stop implementation and raise a Design Gap** (with failure evidence: failing test, concurrency counterexample, or recovery failure) for manual governance — do not edit the design directly.

DID v1.18 governance adoption (`REDUCE_TO_INTERNAL_AGENT_ACTION_ADT`):
model-facing tools decode to provider-neutral typed invocations; executable
tools route through P4 `ToolRuntime`; control tools route through Agent
Runtime `ControlToolRegistry` → process-local `AgentAction` → shared Agent
Runtime policy → owning Application/settlement boundary. `AgentAction` is
neither a wire/output contract nor persisted. `decodeTurn` does not construct a
universal `AgentDirective`.

DID v1.19 governance authorization (`AGENT_CONTROL_IMPLEMENTATION_AUTHORIZED`,
ACR-6…ACR-8): agent control implementation, S01 qualification (redefined as
Control/Executable Route Qualification, carried by the L3 capability suites),
and Wave 2 (scope = `planning/tool-surface-review/51` module map sequenced by
`52` DAG) are AUTHORIZED. The four historical field-source gaps were
subsequently CLOSED by the manually accepted DID v1.26 VDC-1…VDC-8 contract:
AssignWork provenance is Runtime-bound from the current parent Work (or null)
plus model-authored bounded reason; ToolObservation identity is the exact
ToolInvocationId/observationRef/executionId/callRef binding; summaryRef is
Runtime-created content-addressed Blob storage durably retained by the
Verification/event; child initialWork carries the Parent-approved complete
VerificationMission. B10 is authorized and has a repeatable real-provider L3
sentinel.

DID v1.28 governance adoption
(`ACCEPT_EXECUTION_EPISODE_GOAL_PLAN_CONVERGENCE`, EGP-1…EGP-10):
`ExecutionFocus=Work|Coordination` is superseded for all new writes by exact
ExecutionEpisodeBinding (Work / ConversationResponse / Inbox / Decision).
Work is the durable Goal contract; Plan is optional tool-maintained progress
state without completion authority; every Episode uses the same Agent Loop.
Migration 0024 and implementation Waves A–E are AUTHORIZED. Historical
Coordination rows remain read-only migration evidence; ambiguous active rows
fail closed and MUST NOT be reconstructed from Session text.

EGP implementation state (2026-10-03): Waves A–E are COMPLETE and evidenced by
`planning/results/EGP-execution-episode-goal-plan-wave-a-d.result.md` and
`planning/results/EGP-wave-e-legacy-removal.result.md`. Migration 0025 rebuilt
`executions` without focus columns; migration 0026 rebuilt
`agent_execution_state` around `episode_json`; CRAC recovery migrations
0027/0028 backfill actionable Governance Inbox entries for Pending formation
proposals and consume stale entries for settled proposals.
Agent Runtime and Model Context
no longer produce Coordination/QueryCompleted branches. Historical names exist
only in migration/decoder compatibility and MUST NOT regain new-write semantic
authority.

DID v1.29 governance adoption
(`ACCEPT_ROOT_CONVERSATION_ACTION_CAPABILITY`, CRAC-1…CRAC-5):
`RootConversation` supersedes the zero-tool response-only profile. It exposes
no executable/Work tools and exactly one v1 conversation-safe control,
`propose_workspace`; that control creates only a Pending FormationProposal and
its human Governance Inbox entry atomically, and cannot bypass human
RecordDecision. Governance Inbox entries are never promoted into an Agent
Session; RecordDecision consumes the exact pending Queue entry.
Same-execution tool results re-enter the
conversation loop; unrelated Workspace Session history remains excluded.
Accepted proposal SHA-256:
`DEBD13AAB34B7556B221F12B647360E945F95F5D89BD0B03287963DB22B917A8`.

DID v1.30 governance adoption
(`ACCEPT_CONTROL_ACTION_PERMISSION_APPROVAL_ARCHITECTURE`, CAPA-1…CAPA-7):
Control visibility, authorization and execution approval are separate.
PermissionGrant v2 is subject/capability/target/time-bound; unbound legacy
grants are revoked. Sensitive controls resolve to Authorized, Denied or a
durable ApprovalRequired interruption. Approve/Reject resumes the same active
Execution/AgentLoopStep; approval never widens Sandbox/ResourceBoundary.
Migrations 0029/0030 carry grants and control approvals. Accepted proposal
SHA-256:
`74C0A20BCED0C7800B2EB21933967810AAB73423132D9FE06E86A7E56EA26FB9`.

Agent Control implementation state (2026-10-03): the DID v1.26 VDC-5
`AssignWork` action is implemented and evidenced by
`planning/results/agent-action-assign-work.result.md`. The model authors Work
semantics and provenance reason; Runtime binds target, ids, revisions,
predecessor and authority. After CAPA adoption it is visible in WorkspaceWork
only and defaults to human approval; RootConversation exposure remains gated
by `RGI-DG-01`.

Minimal Architecture Convergence governance (2026-10-03):
`ACCEPT_MINIMAL_ARCHITECTURE_CONVERGENCE` accepted proposal SHA-256
`44B549EA81E21B3D4BE5D545EA446B544D50CCA0061C83E6FC40CDC2ADCCA932`.
Owning contracts landed as Problem & Goals v1.3 / Scenarios v1.3 / System
Design v1.9 / DID v1.31 plus `docs/design/implementation/MAC/**`. The active
vocabulary is reduced; Plan is Workspace-local cognition; Specialist is
superseded as a first-class concept; model output uses one ActionCall facade;
async decisions require separate fulfillment truth. MAC-P1 implementation is
AUTHORIZED after landing review. MAC-P2…P4 remain sequentially gated by their
accepted phase contracts. RGI-DG-01 and SDO-DG-01 are resolved at design level
through MAC and MUST NOT be implemented as independent proposals.

MAC implementation state (2026-10-04): governance landing consistency PASS
(`planning/results/MAC-design-landing-review.result.md`). MAC-P1 Wave A is
complete (`planning/results/MAC1-001-003-wave-a.result.md`): RootConversation
advertises only current-Workspace `assign_work`; later-phase formation,
cross-Work messaging/dependency and legacy Specialist new-write surfaces are
hidden; Runtime enforces current target and constraint preservation. Full
`pnpm check` passes. MAC-P1 remains OPEN: Root approval black-box, LocalPlan
relocation, WorkspaceKnowledgeView and Verification/Acceptance closure remain.

MAC-P1 subsequent closure (2026-10-04): **COMPLETE / FORMALLY CLOSED**
(`planning/results/MAC-P1.result.md`). Root natural-language goal → exact
approval → Work → AgentLoop → independent Verification → root Acceptance →
CompleteWork is public-process black-box and hard-restart proven. LocalPlan is
Runtime/Cognition-owned; WorkspaceKnowledgeView promotes accepted PASS outcomes
only; verification/completion consumer errors are typed. Real DeepSeek B01,
B03 (including Root assign) and B11 pass. MAC-P2 implementation is AUTHORIZED.

MAC-P2 closure (2026-10-04): **COMPLETE / FORMALLY CLOSED**
(`planning/results/MAC-P2.result.md`). PlacementContext, opaque refs,
list/read workspace controls, existing-child AssignWork, migration 0031
FormationFulfillment, deterministic child+initial Work application and Parent
Agent `accept_result` are implemented and restart/replay tested. Real DeepSeek
B07 Root formation passes. `pnpm check` passes. MAC-P3 is AUTHORIZED.

MAC-P3 closure (2026-10-04): **COMPLETE / FORMALLY CLOSED**
(`planning/results/MAC-P3.result.md`). Production now wires model-facing
declare/produce/deliver, producer Inbox admission, deterministic
SatisfyDependency coordinator and exact wake. Real DeepSeek B09 passes both
declaration and produce→deliver with model-free satisfaction. `pnpm check`
passes.

MAC-P4 and final MAC closure (2026-10-04): **COMPLETE / FORMALLY CLOSED**
(`planning/results/MAC-P4.result.md`,
`planning/results/MAC-final-convergence.result.md`). The accepted optionality
stop condition is applied: v1 does not register or advertise a subagent action;
historical Specialist codecs/fixtures are replay/audit-only and single-Agent
correctness is unchanged. Migration 0032 converges control/executable exact
approvals into one physical `action_approvals` ledger, fails unprovable legacy
bindings closed, removes the two old tables and preserves atomic
single-consumption. Real DeepSeek B08 disabled-mode qualification passes L1/L2/L3;
full local gates pass (architecture 152, core 1669 + 3 skipped, Web 216).

Release functional-test foundation (2026-10-04): **FOUNDATION COMPLETE;
RELEASE VALIDATION OPEN**
(`planning/results/functional-test-foundation.result.md`). The production
process journey no longer reads SQLite/internal stores: approval is observed
through Inbox and Work through Current Work. `pnpm test:functional` builds the
real daemon/Web client, starts a fresh isolated DB + HTTP provider boundary,
and runs 4 public-process plus 1 Playwright browser/restart journey with zero
retry. `pnpm check` remains green (architecture 154, core 1671 + 3 skipped,
Web 216). This is not yet a release-readiness claim; F10–F20 remain in the
functional journey catalog.

Functional Wave 2 (2026-10-04): **F10–F20 COMPLETE; F21 BLOCKED BY OPEN
DESIGN GAP** (`planning/results/functional-test-wave2.result.md`). Release
functional coverage now includes rejection, transient provider recovery,
Fail/Unknown verification, browser approval/acceptance, crash restart,
three-page history, child-result Parent acceptance, true
Artifact→Deliverable→Delivery→Dependency satisfaction, and a frozen-install
clean-clone smoke. The tests found and closed missing parent PASS routing,
InboxEpisode production admission/settlement, Artifact creation/composition,
and provider loss of artifact/canonical refs. The remaining gap is
`FT-DG-01`: browser CreateProject has no trusted resource-admission flow and
therefore creates an empty executable boundary.

Functional-oracle audit (2026-10-04): F07 now proves that a public SteerWork
advances the Work revision and reaches a later Agent turn. F05 now explicitly
proves PASS keeps Work Open before Acceptance and that Acceptance clears the
current selection. It cannot prove that the terminal Work is user-inspectable:
F22 shows the old Work link renders “未找到该工作” after completion. This is the
separate open `FT-DG-02` design gap with a pending browser test and draft
public Work-detail proposal; see
`planning/results/FT-functional-oracle-audit.result.md`.
F19 now also proves the reverse order (Dependency wait before child Delivery),
which exposed and fixed numeric `wait` revision decoding; full `pnpm check`
and `pnpm test:functional` pass. F21/F22 remain open governance gaps.
Later F22 test strengthening exposed a Web AcceptanceId prefix mismatch
(`acp_` versus frozen `acc_`), fixed with a Web regression test. A separate
public-process F23 test proves malformed typed `MessageId` can still be
Committed through `/commands`; `FT-DG-03` governs the cross-command runtime
codec and receipt boundary. F23 remains isolated pending governance.

DID v1.20 governance adoption (`AHT-1`…`AHT-8`) freezes the durable Provider
result handoff: persisted `AgentLoopStep`, replayable complete Provider success,
idempotent sourced Session/action progression, generation-scoped Application
Command identity, unresolved-side-effect gate, deterministic successors,
evidence-gated legacy adoption, and P14 final convergence. Design landing is
complete; at the v1.20 checkpoint **implementation was NOT AUTHORIZED**. Migration
`0017_agent_loop_step_handoff`, recovery implementation, and replay/mutation of the
preserved DOGFOOD database require separate implementation authorization plus
AH1–AH14 and equivalent-fixture evidence. `DOGFOOD-DG-01`'s design question is
RESOLVED by v1.20; that resolution is not implementation evidence.

DID v1.21 (`ALS-N1`, `ALS-I1`) renames the current durable record from the
reviewed proposal's historical `AgentTurn` to `AgentLoopStep` and AUTHORIZES
implementation. `AgentLoop` = overall runtime algorithm; `AgentLoopStep` = one
durable recoverable iteration; `ProviderTurn` = one logical model decision.
Authorized scope is migration 0017, stores/ports, runtime/recovery integration
and AH1–AH14. The preserved dogfood database remains read-only until the
equivalent fixture and migration verification pass.
AH1–AH2's atomic Provider Success commit and AH3 ProviderTurn-settled →
AgentLoopStep ProviderResultAvailable now have real-process two-sided crash
qualification; see `planning/results/AH1-AH2-atomic-provider-success-crash.result.md`
and `planning/results/AH3-process-crash-qualification.result.md`.
AH4 terminal Provider failure and repair exhaustion now also have two-sided
process crash evidence; see `planning/results/AH4-terminal-failure-repair-crash.result.md`.
AH5–AH6 sourced Session output / OutputAccepted now have two-sided process
crash evidence; see `planning/results/AH5-AH6-sourced-output-atomic-crash.result.md`.
AH7, AH10 and AH14 remain open and MUST NOT be inferred from AH1–AH6/F16.
AH7 has PARTIAL process-crash evidence (ReadOnly action/P4 intent/settlement/
Observation four sides and Reconcilable intent/effect-before-settlement
fail-closed), not phase closure;
see `planning/results/AH7-partial-crash-qualification.result.md`. Ordinary
successful A→B multi-action restart and same-ToolInvocationId SQLite two-
connection/two-OS-process synchronized competition now have focused PASS
evidence (`planning/results/AH7-two-action-interleaving.result.md`,
`planning/results/AH7-cross-connection-concurrency.result.md`). They do not
prove crash/restart concurrency or close active reconciliation, approval
atomicity, or non-Success observation replay.
The non-Success replay gap is `AH7-DG-01` with an isolated failing test and
draft governance proposal. At `26f80f2`, `pnpm test:functional` passes
(public process 29, browser 2); this does not include the pending gap test.
AH8 A Applied / B SkippedStale after public SteerWork and process restart
has a real-process qualification in
`planning/results/AH8-action-b-stale-process-crash.result.md`; AH7 remains
partial. AH9 terminal-action transaction before/after process-crash
qualification is in `planning/results/AH9-terminal-action-process-crash.result.md`:
A Applied, B SkippedEarlySettlement, proposal durable, no second Work or
Provider request. At `3e339ae`, `pnpm check` passes (architecture 155, core
1680 + 3 skipped, Web 216) and `pnpm test:functional` passes (public process
33, browser 2). AH10 is PARTIAL: AssignWork receipt-first takeover has two
deterministic regression tests, but other controls and real-process takeover
remain open (`planning/results/AH10-generation-command-takeover-gap.result.md`).
AH11 Observation → StepEffectsCommitted has two-sided real-process crash
evidence in `planning/results/AH11-observation-step-effects-process-crash.result.md`;
AH12 SettlementProposed → SettleExecution now also has two-sided real-process
crash evidence in `planning/results/AH12-settlement-command-process-crash.result.md`;
AH13 Execution settled → P17 ResponseJob/Attempt convergence has two-sided
real-process crash evidence and one public reply in
`planning/results/AH13-conversation-response-convergence-process-crash.result.md`;
AH14 positive equivalent legacy adoption has two-sided real-process crash
evidence, but remains PARTIAL: ambiguous legacy action evidence lacks durable
public Attention (`AH14-DG-01`, pending red test); see
`planning/results/AH14-legacy-adoption-partial.result.md`. AH7/AH10/AH14
are not closed.
2026-10-07 增量：AH7 新增 approval 前效应重入与模拟唯一约束并发单测，
不构成真实进程资格；AH10 新增 `ProduceDeliverable` receipt-first 路径和
真实双 daemon 30s lease takeover，仍缺其他控制动作及提交两侧 kill/restart。
证据分别见 `planning/results/AH7-approval-pre-effect-reentry.result.md`、
`planning/results/AH7-concurrent-invocation.result.md`、
`planning/results/AH10-generation-command-takeover-gap.result.md`。
`4720f65` 上 `pnpm check` PASS（架构 155、核心 1687 + 3 skipped、Web
216），`pnpm test:functional` PASS（公开进程 42、浏览器 2，含 F20）。
后续 `a22a4a5`/`d7e5782` 将 AH10 handler 级覆盖扩至 DeclareDependency、
AcceptResult、SendMessage；`32ae550` 统一五类 Gateway handler 的旧
receipt 查询。AH7 单连接真实 SQLite 并发 1/1 PASS，但审批消费与 P4
settlement 同事务的冲突是拟议 AH7-DG-03，隔离红测见
`tests/functional/pending/ah7-approval-settlement-atomicity.functional.test.ts`。
`32ae550` 上 `pnpm check` PASS（架构 155、核心 1701 + 3 skipped、Web
216），AH10 双 daemon 与 F20 干净检出定向各 1/1 PASS；未重跑完整
`pnpm test:functional`。AH7/AH10/AH14 和 F21–F23 仍未关闭。
`02e42ac` 增补 AH10 `SelectCurrentWork` handler 级跨代资格，保留 gen0
DecisionId CommandId；`pnpm check` PASS（架构 155、核心 1705 + 3 skipped、
Web 216），F20 干净检出 1/1 PASS。`Deliver` 过期代仍可写 Message/Event/Inbox，
拟议 AH10-DG-01 的隔离红测与治理稿已提交；AH10 仍 PARTIAL，不能把以上
定向/单测当作两侧完整进程崩溃资格。
`02e42ac` 上完整 `pnpm test:functional` 亦 PASS（公开进程 42、浏览器 2）。
验证控制动作新增两条隔离红测：RecordVerificationEvidence 同 ID 重试的
`recordedAt` 指纹漂移，以及 ConcludeVerification 缺 P8 已冻结的
`criteriaResults` 持久快照；拟议 VCS-DG-01 见
`planning/results/verification-evidence-replay-and-snapshot-governance.review.md`。
时间来源和历史结论行处置未获人工治理，不能凭绿色功能批次宣布验证
命令重放或 AH10 闭合。
P9 `07` §4 的密集 SSE/TTL/3 实际续租资格新增
`tests/functional/process/p9-dense-sse-lease-renewal.functional.test.ts`：
真实 SQLite 同 generation `expires_at` 在活跃 SSE（已消费 >512 帧）期间
前移，ProviderAttempt/Turn 最终成功且请求只一次；见
`planning/results/P9-dense-sse-lease-renewal.result.md`。它不是 AH7/AH10
进程崩溃矩阵的替代证据。
`c39004f` 上 `pnpm check` PASS（架构 155、核心 1705 + 3 skipped、
Web 216）；F20 + P9 密集 SSE 定向 2/2 PASS。此提交未重跑完整
`pnpm test:functional`，不能把定向验证扩大成全功能批次。
AH10 后续真实进程补测：旧 gen0 FencingRejected receipt 落盘后杀旧
daemon，新代唯一提交；以及旧 canonical Command/Deliverable 已提交而
Action Pending、Observation 未写时杀进程，新代从旧 Committed receipt
收敛。两案定向 2/2 PASS，见
`planning/results/AH10-generation-command-takeover-gap.result.md`；
旧拒绝 receipt 事务提交前与其他动作的两侧矩阵仍未通过，AH10 PARTIAL。
AH10 后续在仅测试子进程显式装配的 Gateway 事务内探针处，补了旧
`FencingRejected` 回执**提交前**杀进程；提交前/后及已提交新命令但
Action Pending 三案合跑 3/3 PASS。提交前独立 DB 读不到旧回执，
杀进程回滚后新代唯一提交。见同一 AH10 结果文件；其他动作及
Deliver/验证控制的开放缺口仍使 AH10 保持 PARTIAL。
`f6ae77f` 上完整 `pnpm check` PASS（架构 155、核心 1705 + 3 skipped、
Web 216）；未在该提交重跑完整 `pnpm test:functional`。
AH10 `DeclareDependency` 新增真双 daemon 旧 `FencingRejected` receipt
提交前/后杀进程接管 2/2 PASS：前态独立 SQLite 读不到未提交旧回执，
杀进程后回滚；后态 gen1 查询已提交旧回执。同一 LogicalAction、新代
CommandId、唯一
Unsatisfied Dependency 与 Observation、Provider 一次。见
`planning/results/AH10-generation-command-takeover-gap.result.md`；其他动作
仍开放，AH10 PARTIAL。`29b9ce2` 上完整 `pnpm check` PASS（架构 155、
核心 1705 + 3 skipped、Web 216）；参数化增量未重跑完整 `pnpm check`。
`afe8a20` 上完整 `pnpm test:functional` PASS（真实进程/公开 API 21 文件、
48/48；Playwright 2/2），含 AH10 五场景和 F20 干净检出。此结果不关闭
AH10 其他动作及治理缺口。
AH10 `AcceptResult` 真双 daemon takeover 现覆盖旧 FencingRejected receipt
提交前与提交后两个 kill/restart 边界：提交前独立 SQLite 看不到回执且旧进程
退出回滚，新代通过 Parent `list_workspaces` 取得真实 resultRef 后唯一
Acceptance、Child Work Completed；两支保留同一 LogicalAction/ProviderTurn。
`SendMessage` Query 另覆盖旧拒绝 receipt 提交后 takeover，唯一 Message、Inbox/
correlation、Observation 与 Provider 调用。当前本地复跑 AH10 主文件与 SendMessage
文件共 8/8 PASS，完整 `pnpm check` PASS（Biome 943 files、architecture 155、
core 1708 + 3 skipped、Web 216）。结果分别见
`planning/results/AH10-generation-command-takeover-gap.result.md` 和
`planning/results/AH10-send-message-process-takeover.result.md`。AH10 仍 PARTIAL：
其余控制动作、SendMessage 其他边界，以及 Deliver/验证控制治理缺口仍开放。
`d5dca49` 推送后 F20 干净检出 1/1 PASS（44.37s），完整
`pnpm test:functional` PASS（Vitest 22 files/51 tests、Playwright 2/2）；
这些广义绿色结果不消除 AH10 的剩余控制动作和治理缺口。
后续 `SendMessage` 真双 daemon 覆盖 Query 的旧 FencingRejected receipt
提交前/后接管（2/2），以及 Query Inbox 已消费且 correlation 已关闭后，Reply
Committed/Action Pending/无 Observation 的 kill/restart receipt-first 收敛
（1/1）；最新 SendMessage 文件定向 3/3 PASS。`SelectCurrentWork` 的真实
Scheduler DecisionEpisode 双 daemon 提交前/后 receipt takeover 2/2 PASS，修复
了 `main.ts` 仅恢复 WorkEpisode 的实现缺口；按 P2-06 §4A/P9/EGP 现有合同处置，
无新设计语义或 `docs/design/**` 改动。原 pending RED、实现依据与结果见
`planning/results/AH10-select-current-work-takeover.result.md` 和
`planning/proposals/AH10-decision-episode-takeover-dispatch-gap-draft.md`（现为
implementation disposition）。本次 `pnpm check` PASS（Biome 944 files、
architecture 155、core 1708 + 3 skipped、Web 216）；AH10 仍 PARTIAL，其他控制
动作/状态组合及 Deliver/验证控制治理缺口仍开放。
P9 集成复核：`47e9249` 上完整 `pnpm test:functional` 首次为 Vitest 21/22
files、52/53 tests；唯一失败是 P9 首次 lease-renewal snapshot 的
`framesConsumed=481` 未达既有 `>512` 阈值，Playwright 因 Vitest 失败未运行。
定向诊断确认两次孤立 P9 在该提交均通过，问题是高负载下只采首次续租且网络
enqueue 前计数不代表持久观察。`101e009`/`3ffb17a` 的 P9 专属测试修复在同一
真实续租采样核对同代 lease row expiry 增长、活跃 SSE、网络写/读帧及 SQLite
canonical TextDelta 持久数均 `>512`，并在首轮不足时等待下一次有界真实续租；
未改生产代码或降低阈值。最终 `3ffb17a` 上 F20 1/1 PASS（66.36s），完整
`pnpm test:functional` PASS（Vitest 22/22 files、53/53 tests；Playwright 2/2）。
此前 `pnpm check` 在 `47e9249` 上 PASS（Biome 944、architecture 155、core
1708 + 3 skipped、Web 216）；P9 后续测试专属变更的 test typecheck/Biome PASS，
但未在 `3ffb17a` 重跑完整 `pnpm check`。AH10/AH7 仍未闭合。
AH10 DecisionEpisode 续发实现修复位于本地提交 `5e389e8`：daemon 恢复同一
active Workspace Execution 时不再仅筛 WorkEpisode，既有 pre-dispatch、Pending
approval 与 fencing/runExecution 路径保持不变；拟议 AH10-DG-02 按现有 P2-06/P9/
EGP 合同归类为已修复实现缺陷，不涉及 `docs/design/**`。SelectCurrentWork 提交前/
后 receipt 双 daemon 2/2，AH10 主文件+SendMessage 10/10，完整 `pnpm check` PASS
（Biome 944、architecture 155、core 1708 + 3 skipped、Web 216），F20 1/1；本地
`5e389e8` 完整功能 PASS（Vitest 23 files/55 tests、Playwright 2/2）。AH10 其他
控制动作/状态组合及 Deliver/验证治理缺口仍开放。本次 cherry-pick 推送尝试遭
GitHub Remote Internal Server Error，远端同步状态须另行确认。
2026-10-08 增量：AH10 current-Workspace `AssignWork` 新增双 daemon receipt
提交前/后和 Committed-but-Pending 三案，独立定向 3/3 PASS；使用 exact
Workspace CAPA GrantPermission，不覆盖 direct-child placement。AH7 新增 A 已
Applied 后 B Idempotent patch effect 已发生、settlement 前杀 daemon，重启按同一
ToolInvocation/Action identity 收敛，定向 1/1 PASS；不宣称 executor 单次调用。
见 `planning/results/AH10-assign-work-process-takeover.result.md` 与
`planning/results/AH7-B-idempotent-effect-before-settlement.result.md`。该增量
完整 `pnpm check` PASS（Biome 946 files、architecture 155、core 1708 + 3 skipped、
Web 216）；AH7/AH10 仍 PARTIAL。
`7f71058` 首次完整功能批次出现 24/25 Vitest files、58/59 tests：AH7 B effect
case只因 snapshot 合法停留在 `StepEffectsCommitted/cursor2`，而测试过度要求后续
`NextStepReady`。按 P9 冻结状态机修正状态断言为同一 Step/cursor2 且仅接受这两个
合法阶段，唯一 ToolInvocation/Result/Artifact/Observation、文件 effect、Provider
一次断言均保留。修后单测 2/2 PASS；`9157e9c` 上 F20 1/1 PASS，完整
`pnpm test:functional` PASS（Vitest 25/25 files、59/59 tests，Playwright 2/2）。
该增量仍不关闭 AH7/AH10。
后续 `SendMessage` 增 DecisionRequest 旧 FencingRejected receipt 提交前/后双 daemon
两案：同一ProviderTurn持久ToolCall顺序为send_message→wait；ActionResult gate前
workflow-signals offset落后是预期暂停，释放后child WorkEpisode settle、offset推进且
唯一Parent InboxEpisode入账。当前 SendMessage文件5/5（Query2、Reply1、DecisionRequest2），
`pnpm check` PASS（Biome946、architecture155、core1708+3 skipped、Web216）；AH10仍PARTIAL。
AH7 新增普通 A/B 双动作真实进程测试：同一 ProviderTurn 两个成功
Idempotent patch，重启后 cursor 0→1→2、A/B 各一条 ToolInvocation/
ToolResult/Artifact，原 Provider 决策只一次；见
`planning/results/AH7-two-action-interleaving.result.md`。它不关闭
AH7-DG-01/02/03 或其他多动作失败/并发分支。
AH7 同一 NonIdempotent ToolInvocationId 的真实 SQLite 双独立连接竞争
扩至两个独立 OS 进程同步竞争，定向 3/3 PASS：唯一主键 intent、唯一
Success settlement、外部 effect 仅一次；见
`planning/results/AH7-cross-connection-concurrency.result.md`。
完整 `pnpm check` PASS（架构 155、核心 1707 + 3 skipped、Web 216）。
该次门禁仅包含前两项双连接测试；第三项加入后完整 `pnpm check` 再次
PASS（架构 155、核心 1708 + 3 skipped、Web 216）。并发证据不替代
多进程 crash/restart 资格，AH7 仍 PARTIAL。
At `b4c0fd6`, `pnpm check` passes (architecture 155, core 1677 + 3 skipped,
Web 216) and `pnpm test:functional` passes (public process 24, browser 2).
At `6dd3dda`, `pnpm check` passes (architecture 155, core 1677 + 3 skipped,
Web 216) and `pnpm test:functional` passes (public process 23, browser 2).
At `1812991`, `pnpm check` passes (architecture 155, core 1677 + 3 skipped,
Web 216) and `pnpm test:functional` passes (public process 19, browser 2).

## Planning

- `planning/phases/` — one file per phase P0–P12 (see DID §11)
- `planning/tasks/` — task breakdown per phase
- `planning/results/` — completion evidence, verification output per phase

Current authorization state: **P0–P14 COMPLETE; P14 FORMALLY CLOSED; D-1 Product UI
Contract Closure COMPLETE; D0–D3 Web Product UI Foundation COMPLETE; D4–D6 Web Product UI
Core Workbench COMPLETE / PHASE-BOUNDARY CLOSED; D7–D9 Web Product UI COMPLETE /
PHASE-BOUNDARY CLOSED at `master@09d0b81a6e27e2b20f2a7b28f1fea89c1400984c`; D10 Web
Product UI Final Convergence COMPLETE — **Web Product UI FORMALLY CLOSED** at
`master@7752e0e5bba1cf4ffd7351895c1e405bb7158855`.** Evidence:
`planning/results/D4-D6-web-product-ui-core-workbench.result.md`,
`planning/results/D7-D9-web-product-ui-surfaces.result.md`, and
`planning/results/D10-web-product-ui-final-convergence.result.md`.
Next activity: **Dogfooding / Release Validation** — use Arbor for real tasks;
Web v1 implementation is closed.
Provider-result handoff governance: **DESIGN CLOSED at DID v1.20;
IMPLEMENTATION AUTHORIZED at DID v1.21**. `DOGFOOD-DG-01` is RESOLVED at the
design layer; implementation still requires TDD/AH1–AH14 evidence before any
preserved-database recovery.
Session / Context Runtime convergence: **SCRC-1…SCRC-12 ACCEPTED; owning
contracts landed as System Design v1.4 / DID v1.22 at `75589c5`;
post-landing review Blocking = 0; `SCRC-DG-01` RESOLVED**. Migration 0019 and
SCRC code implementation are AUTHORIZED by the manual token
`AUTHORIZE_SESSION_CONTEXT_RUNTIME_IMPLEMENTATION` (2026-10-01). SCRC planning is COMPLETE
(`planning/phases/SCRC.md`; 8 task contracts; T01–T30 acceptance matrix;
planning review Blocking = 0). Execute SCRC-001…SCRC-008 strictly by the phase
DAG; only SCRC-008 may claim full completion. Current implementation state:
**SCRC-001…008 COMPLETE; FORMALLY CLOSED; SCRC-DG-01/02 RESOLVED**
(`planning/results/SCRC-001.result.md`, `planning/results/SCRC-002.result.md`,
`planning/results/SCRC-003.result.md`).
See also `planning/results/SCRC-004.result.md`.
See also `planning/results/SCRC-005.result.md`.
See also `planning/results/SCRC-006.result.md`.
P17 (Conversation Delivery Runtime convergence): **COMPLETE / FORMALLY CLOSED**.
Governance proposal accepted
2026-10-01 by `ACCEPT_CONVERSATION_DELIVERY_RUNTIME_CONVERGENCE`; owning
contracts landed as System Design v1.5 / DID v1.24 plus
`docs/design/implementation/P17-conversation-delivery-runtime/**`.
Implementation and migration 0021 landed in order: Context Gate →
ResponseJob/Attempt → Recovery/Scheduler/Breaker → TurnProfileResolver →
Commands/UI → migration/restart/live qualification. C1–C20 and `pnpm check`
passed; legacy booleans/fallback and the old P14 trigger/sweep/rollback runtime
were removed; `DOGFOOD-DG-02` is CLOSED. Evidence:
`planning/results/P17.result.md`. Do not restore P14's unbounded
`Failed -> Pending -> retry-until-response` path.
P16 (Provider Extension Architecture — DID-side implementation design under
`docs/design/implementation/P16-provider-extension/`, governance-authorized
2026-09-29): **Gate A design contracts FROZEN**; **Gate B Design Closure =
ACCEPTED, implementation = AUTHORIZED (2026-09-29)** with two acceptance
clarifications merged (E4 split into E4a compatible-provider / E4b
protocol-family extensibility; CapabilityQualification binds a
ResolvedModelBinding fingerprint with full identity/version records,
INV-P16-9/10 frozen). Exit = mechanical evidence E1–E5 incl. E4a/E4b
proofs; **STOP if either E4a or E4b fails — no further provider family
onboarding**. Scope guards: no real new provider family, zero agent-runtime
diff, no Model Context semantic compilation change, no cache-usage/native
continuation implementation, no CanonicalProviderEvent extension.
**Final Closure Audit COMPLETE (2026-09-29, baseline 59958f8)**: G-B1 —
fingerprint contract==implementation restored (pure-TypeScript SHA-256 in
ports, environment-neutral, no node:crypto; reference-digest asserted by
spec; both qualification records rebound to SHA-256 fingerprints); G-B2 —
provider-testecho now carries the DISTINCT protocol-family identity
`testecho-echo-v1` (registry resolves by that identity; adapter owns an
independent protocol path; E4b re-proven as a true new-family onboarding).
E1–E5 re-passed, pnpm check green, git diff --check clean, scope guards
re-verified. **Gate B = FORMALLY CLOSED.** Gate C NOT entered (no new
authorization). Subsequent state (evidence in
`planning/testing/provider-qualification/` and the git log): Gate C
Infrastructure CLOSED (canonical usage, continuation/reasoning substrate,
qualification matrix + runner); Gate D1 live qualification of dep-env
(DeepSeek) COMPLETE — final matrix PROVEN 8 / UNSUPPORTED 4 / FAILED 0 /
NOT_RUN 0 (fragmented-args root cause graded BEST_SUPPORTED_PROVIDER_SIDE;
remediated fail-closed), cache extraction landed with declaration aligned.
The extension protocol is plug-and-play: any reachable OpenAI-compatible
deployment onboards as pure data (env vars → ModelDeployment → registry
resolution → qualification runner), as E4a proved — no code change, no
bespoke procedure per deployment. **Gate B IMPLEMENTATION COMPLETE (2026-09-29)**: B-1..B-10 evidenced —
registry/binding/env wiring landed; E1/E2 arch gates (tests/architecture/
p16-architecture.test.ts) green; E3 conformance suite A1–A10 green on
provider-openai / provider-fake / provider-testecho / provider-openai@
dep-openai-compat-echo (41 specs; found & fixed two real adapter taxonomy
defects: 403 pre-classified as invalid_api_key, transport TypeErrors
pre-wrapped as 503); E4a compatible-provider proof exit 0 (dep-openai-
compat-echo: catalog data + deployment fixture + qualification, zero
core/adapter diff); E4b protocol-family proof exit 0 (provider-testecho
in-process family; provider-runtime/model-context/agent-runtime/provider.ts
diff empty); E5 qualification bound to binding fingerprints (p16fp_*) for
dep-env (DeepSeek, stableRuns=3) and dep-openai-compat-echo (offline
proof); pnpm check green (arch 19 / core 236 / web 31); capability
gray-box green; scope guards re-verified (agent-runtime 0-line diff,
CanonicalProviderEvent 0-line diff, all capability flags false).
**SYSTEM IMPLEMENTATION COMPLETE** — **FINAL CLOSURE PASS**
(`planning/final-system-closure.md`; `planning/results/ARBOR_FINAL.result.md`).
P14 (Chat-First 主工作区对话面 — DID v1.16 G-A–G-F: SubmitHumanMessage +
WorkspaceMain/Coordination conversation execution, root-only, no streaming):
design closure + planning + implementation COMPLETE and FORMALLY CLOSED
(`planning/results/P14.result.md`; 10/10 seams S1–S10 evidenced; G-gate 8/8;
recorded mechanism note: settle write-back via P14 tick sweep).
D-1 (Product UI Contract Closure — DID v1.17 TR-WPU-A–D): presentation-only
supersession adopted; Tree carries server-projected `parentWorkspaceId`; current-work carries
canonical `Work.revision`; selected Verification carries frozen `targetWorkRevision` paired with
`verificationId`; `/p/:projectId` is the formal Root Workbench landing. No command/event/DDL/
authority/transport/System Design change and no Web visual/route implementation. **G1a, G1b and
G6 CLOSED; G2–G5 remain DEFERRED.**
P13 (Product Web Client — post-core product-surface phase, DID v1.15 G1–G4):
design closure + planning + implementation COMPLETE and FORMALLY CLOSED
(`planning/results/P13.result.md`; 14/14 exit criteria PASS; no open Design
Gap; recorded deviations: tree depth-field TR deferred, external
AdmitExecution + chat-first deferred to P14+).
(P7-GAP-01 dispositioned: DEFERRED to P10, non-blocking). P6 result:
`planning/results/P6.result.md`; P7 result: `planning/results/P7.result.md`
(11/11 exit criteria PASS; no open implementation Design Gap).
P8 is COMPLETE and FORMALLY CLOSED: `planning/results/P8.result.md`
(11/11 exit criteria PASS; no open Design Gap; migrations M-1..M-4
landed as frozen contracts). P9 is COMPLETE and FORMALLY CLOSED: `planning/results/P9.result.md`
(11/11 exit criteria PASS; no open Design Gap; GQ1–GQ5 fidelity
held; three closure deviations reconciled under DID v1.12 G1/G2).
P10 is COMPLETE and FORMALLY CLOSED: `planning/results/P10.result.md`
(11/11 exit criteria PASS; P7-GAP-01 CLOSED as the
WaitingOnVacantProducer derived view; DID v1.13 G1–G8 fidelity
held). P11 is COMPLETE: `planning/results/P11.result.md` (11/11 exit
criteria PASS; CI-1..CI-5 mechanically proven; no open Design Gap;
three P12 convergence items recorded). P12 design closure COMPLETE (DID v1.14
governance rulings GQ1–GQ8 landed; P12 contracts FROZEN, Blocking=0) and P12
planning COMPLETE (planning review Blocking=0). P12 implementation COMPLETE and
FORMALLY CLOSED: `planning/results/P12.result.md` (14/14 exit criteria PASS; all
nine completion blockers mechanically evidenced; no open P12 Design Gap).

```text
P12 design closure COMPLETE (contracts FROZEN; four-way review Blocking=0)
P12 planning COMPLETE (phase plan + task contracts; planning review Blocking=0)
P12 implementation COMPLETE; P12 FORMALLY CLOSED
```

P12 completion blockers (must remain explicit throughout closure):
region-encoding correctness fix; ToolCatalogPort inherited contract correction;
full §8.16A Runtime Safety closure; Authority Resolver production plane;
SecretStorePort / SecretRef + real adapter; observability / health / usage plane;
StorageScaleAssessment + DurabilityEnvelope; Remote Worker transport / identity
boundary; Plugin SDK / compatibility / trust model.

P5 result: `planning/results/P5.result.md` (11/11 exit criteria PASS; no open Design Gap). P5-DG-01 was resolved by the decision/execution split: the scheduler evaluator owns the selection decision, the Application owns the `SelectCurrentWork` canonical mutation (P5 `01` §3.1).

## Technical baseline (versioned, from DID §14)

```text
Node 24.21.0 | TypeScript 7.0.2 | effect 4.0.0-rc.115 (exact pin) | pnpm 12.4.2
Vitest 5.0.1 | Biome 2.5.14 | ESM only | tsc -b build
```

Commands: `pnpm build` / `typecheck` / `test` / `lint` / `format` / `architecture` / `check`.
`pnpm check` = lint + typecheck + architecture + test. All must be green before a phase is done.

## Hard engineering rules

1. `Effect<A, E, R>` is an architecture contract: A = success semantics, E = narrow typed failure, R = exact capabilities. No `Effect<A, Error, AppEnv>`, no service locators, no catch-all errors.
2. Domain is pure: `R = never` in domain transitions; no infrastructure imports in `domain`.
3. Port = Effect service; Adapter = Layer. Adapter-specific errors never cross a semantic boundary.
4. Hard invariants are enforced by code (Domain/Command/Persistence/Runtime/Sandbox/Projection, DID-6), never by prompt text.
5. Package dependency follows the allowed-edge matrix in DID §10.4.1; enforce with architecture tests in `tests/architecture/`.
6. Prompt/Model Context changes are behavior code: version them, keep provenance, regression-test them.
7. TDD: write the failing test from design-doc requirements (not from existing code) before implementation.

## Key concepts (do not confuse)

```text
Workspace  = long-lived responsible identity (not folder/session/process)
Work       = phase outcome requirement (Open | Completed | Cancelled)
Execution  = recoverable execution episode (one active main per Workspace)
Agent      = runtime execution role, not a long-term entity (no AgentId)
Verification PASS != Parent Acceptance != Work Completed
```
