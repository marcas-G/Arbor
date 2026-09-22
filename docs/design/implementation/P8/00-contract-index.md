# P8 — 00 Contract Index (FROZEN)

> Planning Agent 起草的设计收敛提案。人工治理确认 GQ1–GQ6 后正文落位
> `docs/design/implementation/P8/**` 冻结；此前不构成 Authority 来源。

**Authority:** DID v1.11 §3.5/§3.6/§3.7/§4.2/§5.3/§5.4/§6A.6/§6A.11/§8.16/§8.18/§8.4/§8.4A/§11 P8/§12.8/§12.10/§12.11/§10.4.1; v1.9 G4; v1.7 G5; SD v1.3 §9 全章/§11.4/§13.10/§14 No.22-27/44/46/49; S1 步骤 9–11, S2, S3 步骤 11–12; P2 `01`/`02`, P3 `02`/`03`/`05`/`07`, P5 `04`/`05`, P6 `00`/`01`/`04`/`05`, P7 `00`/`01`/`03`/`06`; `planning/results/P7.result.md`.
**Status:** FROZEN (first draft for contract review) — governed by DID v1.11 (GQ1–GQ8 decisions, 2026-09-21).

## Documents

| Doc | Owns |
|---|---|
| `01-verification-commands.md` | 五命令契约（StartVerification / RecordVerificationEvidence / ConcludeVerification / AcceptWorkOutcome / CompleteWork）：载荷、冻结 precondition 链、authority facts、事件载荷 |
| `02-verifier-execution.md` | Execution-bound Verifier spawn/驱动/回流、Producer 隔离的三层强制落点、Verification Program family（DID §8.4 P9）双层版本 |
| `03-chain-consumers.md` | CompletionClaimed→StartVerification 与 WorkOutcomeAccepted→CompleteWork 两条 deterministic consumer、FAIL/UNKNOWN 的 VerificationReturned wake 生产 |
| `04-evidence-binding.md` | EvidenceRecord 生命周期、criterion 级 verdict 结构（GQ2）、revision/artifact/environment 绑定规则、P7 Deliverable 消费与 P6 占位 mission 收紧 |
| `05-query-agent-scope.md` | Query Agent 语义裁决提案（GQ1）与 QueryCompleted 通道 |
| `06-acceptance-outline.md` | 验收故事概要 |

## Authoritative scope (DID §11 P8 + v1.9 G4 + 前向引用)

```text
CompletionClaimed → StartVerification → Verifier Execution → Evidence
→ ConcludeVerification(PASS/FAIL/UNKNOWN) → AcceptWorkOutcome → CompleteWork
Execution-bound Verifier spawn semantics（P2 generic admission 之上）
exact revision binding（targetWorkRevision / targetDeliverables / artifacts / environment）
Producer/Verifier/Acceptance 三层分离（L2+L4+L5 强制）
Verification Program family 正文与 eval（§13 表：PHASE CONTRACT P8）
VerificationChanged/VerificationReturned wake 生产（source phase = P8）
P7 交接：Verification.targetDeliverables 消费不可变 deliverables；satisfaction ⟂ quality
```

明确不在 P8：Work 生命周期语义修改（CompleteWork 是既有 Work 命令的接线）、Environment change 生产（P11）、Attention 呈现（P10）、生产 daemon（P12）。

## 实现基线（可复用 vs 待建）

可复用（冻结+测试绿）：domain verification.ts 三转移与重验证新 identity、completeWork 校验链与 Acceptance ADT、CompletionClaim→settlement 持久链（P5）、ExecutionBound admission + P6 spawn 模板、WorkerDispatchPort `workerKind:"Verifier"` 预留、blob/artifact/environment-revision 存储、DeliverableRepository（不可变）。

**迁移面（v1.11 已变更，非"可复用"）**：
- M-1 `VerificationChanged` WakeCondition 形状（scheduler.ts:32-36 P0 冻结旧形）→ work-level `{workId, targetWorkRevision}`：P0 类型修改 + 持久 WaitSpec 行迁移 + P2/P3 既有测试回归（v1.11 G2 申报）。
- M-2 `VerificationMission.criteria`（verification.ts:17 `string[]`）→ 结构化（v1.11 G1 申报）：P0 Schema + P1 AssignWork 载荷/测试 + P6 placeholder mission 迁移（必要时正式 migration）。
- M-3 `ExecutionBound.parentExecutionId`（P2 `01` §5 冻结必填）→ 可选化：Verifier spawn 无因果父执行（隔离语义；P6 `AdmitExecutionAuthority` 扩 origin 的 inherited-evolution 先例）。
- M-4 `ExecutionSettled` 事件（P0 events.ts:111 空壳）与 settlement workId 解析：Consumer A 依赖其载荷（workId/workRevision/claimRef）——P2 事件面充实申报 + settlement 载荷补 workId（现 execution.ts:38-41 只有 workRevision/claimRef）。

待建（P8 全部新建）：五命令 handler、两条 deterministic consumer（0 行代码现状；Consumer A 前置 M-4）、四表 verifications / verification_executions / verification_evidence / work_acceptances（DID §9.3 表名对齐；migration 8）、verify 侧查询（listBySourceWork 等）、三个空壳事件充实、Verifier 驱动接线、Verification Program v1 + eval、P6 占位 mission 收紧。

## Unresolved-items classification

### A. Upstream frozen-design defects（需治理裁决；多数可经"最小解释冻结"闭合而不改 DID）

| # | 缺陷 | 证据 | 处置建议 |
|---|---|---|---|
| UD-1 | **Query Agent 无正文定义**：仅 §11 关键词 + PG non-goal（共用 Runtime）+ QueryCompleted settlement 分支 | DID:3737; PG:266; DID:1107/1882/3850 | **GQ1**：裁决为"非独立实体"的最小解释（`05` 提案）或 DEFER |
| UD-2 | **criterion 级 verdict 结构不在 DID ADT**：SD §9.6 冻结 per-criterion PASS/FAIL/UNKNOWN + 确定性聚合，但 Verification 聚合只有整体 `Verdict?` | SD:1048-1060 vs DID:1161-1185 | **GQ2**：裁决 criterion results 属 MissionSnapshot/EvidenceRecord 内容（value object，P8 契约冻结）而非聚合新字段——最小 DID 变更路径 |
| UD-3 | **`VerificationChanged(id, observedRevision)` 的 revision 语义悬空**：Verification 聚合无 revision 字段 | DID:2876 vs DID:1161-1185（无 revision） | **GQ5**：澄清 observedRevision := observedWorkRevision（等待"该 Work revision 上出现已结论的验证"），与 refine→新 Verification 的 identity 规则自洽 |
| UD-4 | **CompleteWork 提交者/自动性未定义**：precondition 冻结但 PASS+Acceptance 后是治理动作还是管线闭合未写；不提交则 Work 恒 Open | DID:4053, 4140 | **GQ4**：裁决 WorkOutcomeAccepted→deterministic CompleteWork consumer（链两端对称，`03` 提案）；Acceptance 本身保持 Parent 语义决定 |
| UD-5 | **Acceptance 无拒绝命令**：Parent 判"不足"只能不提交 + 组合治理命令 | DID:1459-1466 | 折叠为 `01` §4 契约注记（SD §9.7 已完全决定：不提交即不接受+补充 Work；显式 Reject 不新增）——原 GQ3 撤销 |
| UD-6 | **mission schema 无法表达冻结语义**：P0 冻结 `VerificationMission.criteria: string[]`（无 required/optional、无 criterionId），但 SD §9.6 冻结 required/optional 区分与聚合规则；P1 AssignWork 载荷引用该类型 | verification.ts:15-19 vs SD:1050-1060 | **GQ2（重写）**：schema 演进裁决——(a) 治理批准演进：criteria 结构化 {criterionId, requirement, required}（P0 Schema + P1 载荷 + P6 placeholder 迁移；P7 migration-7 先例）【推荐】；(b) 维持 string[] 全部视为 required（弱化 SD §9.6 optional 透明性，需明示）；(c) 升 DID §3.5 ADT |
| UD-7 | **WakeCondition `VerificationChanged` 形状与等待语义矛盾**：P0 冻结 `{verificationId, observedRevision}`（verificationId-keyed），但"等该 Work revision 出现已结论验证"无法预知 verificationId 表达 | scheduler.ts:32-36 | **GQ5（重写为形状变更）**：改为 `{workId, observedWorkRevision}`（与 DependencyChanged 同构），与 GQ6 并案 |

### B. P8 phase-scoped closure（契约权限内冻结）

1. **verifier authority fact**：exact-bound `VerifierExecutionAuthority { verificationId, executionId }`——RecordVerificationEvidence/ConcludeVerification 仅 Verifier Execution 可提交（§12.11 "verifier authority" 的落法，照 P6/P7 模式）。
2. **StartVerification 提交者**：deterministic consumer（CompletionClaimed）+ human/Parent 显式（含重验证触发：任何时点对 Open Work 显式 Start——新 identity 已冻结）。authority `StartVerificationAuthority`。
3. **AcceptWorkOutcome actor**：Parent Workspace 治理链 authority（Root 内=Main Agent/human；milestone=User——SD §9.7 语义直接落 authority fact 形态）。
4. **FAIL/UNKNOWN 接线**：ConcludeVerification(FAIL|UNKNOWN) 同事务产 `VerificationReturned` wake → Producer Workspace reevaluate（S1 步骤 9 返工不换人；UNKNOWN≠FAIL 不触发返工只触发 reevaluate/补证据认知——`03` 细化）。
5. **Evidence lifecycle**：append-only（仅 Verifier Execution authority）；immutable；evidence 是 runtime record（DID §3.7）——**无独立 domain event**（§5.3/§12.10 无 evidence 行，如实不加）；criterion results 存 EvidenceRecord/MissionSnapshot（v1.11 G1）。
6. **并发 Verification（v1.11 G2 已裁决）**：同一 (workId, targetWorkRevision) 至多一个 Open（typed `VerificationAlreadyOpen` 拒绝）；concluded 历史不受限；孤儿 re-Start 先 Unknown(Orphaned) 结论（G5）。
7. **Environment 绑定可选性规则**：mission 含可执行验证（运行 tests/复现）→ `targetEnvironmentRevision` 必填；纯静态审查可缺省（不变量 26 的精确化——Artifact 版本恒必填）。
8. **verification-runtime 包边界**：spawn 经 application gateway（AdmitExecution ExecutionBound）+ WorkerDispatch Verifier kind 接线；不依赖 agent-runtime/execution-runtime（§10.4.1 遵守，`02` wiring）。
8a. **Verifier owning workspace（v1.11 G4 已裁决）**：= StartVerification 时目标 Work 的 owning Workspace **snapshot**；此后 retirement/move 不自动 abort/retarget——允许自然结论，无法继续时 Unknown/Attention；新 Verification 用当前 owner（`02` §1、`06` Story G）。
9. **Verification sub-execution**：P8 最小面不实现嵌套 sub-execution（Verifier 经 InvokeTool 完成调查）；`verification_executions` 表记录主 Verifier Execution 绑定；sub-execution 留缝（SD §9.2 许可不冻结）。
10. **"正确但不够"路径**：Parent 经 AssignWork 产生补充 Work（P1 命令组合，无新语义；契约写明禁改判 FAIL）。
11. **P6 占位 mission 收紧**：P8 定义 minimal mission schema 校验（goal 必填非空 + criteria 数组），formation-plan 的 "p6-placeholder" 迁移路径。
12. **Verification Program family（DID §8.4 P9）**：v1 文本 + D4 双层版本（contractRevision/textRevision，P6 `05` 模式直接套用）+ 行为 eval。

### C. Implementation choices（任务级）

三表 DDL 细节（migration 8 编号）；DeliverableRepository 查询扩展形态；空壳事件载荷充实；consumer 死信接 P1 基建；Verifier 驱动 loop 形态（复用 driver 或专用最小 loop）；verdict 聚合纯函数位置；evidence blob 复用细节。

## Governance decisions (DID v1.11, 2026-09-21 — all GQ resolved)

| GQ | Decision (v1.11 clause) |
|---|---|
| GQ1 | P14 Query/Inspection Program **owned by P8**: read-only contract + version/hash/eval frozen here (`05`); P10/P12 consume only (G6) |
| GQ2 | Mission schema fixed upstream, SD not weakened: `criteria: {criterionId, requirement, required}[]`; aggregation frozen (required Fail→Fail; required unresolved→Unknown; all required Pass→Pass; optional never blocks Pass). P0/P1/P6 inherited evolution, formal migration if needed (G1) |
| GQ4 | `WorkOutcomeAccepted` → deterministic consumer → `CompleteWork` via CommandGateway; Acceptance = Parent/User decision; CompleteWork = mechanical canonical mutation with full re-validation of exact bindings (G3) |
| GQ5/GQ6 | `VerificationChanged` wait is work-level `{workId, targetWorkRevision}` (no VerificationId); fires on **any** verdict; FAIL/UNKNOWN additionally fire `VerificationReturned`. **One Open Verification per (workId, targetWorkRevision)**; concluded history unrestricted (G2) |
| GQ7 | Verifier owning workspace = owner snapshot at StartVerification; later retirement/move never auto-aborts/retargets — natural conclusion, or Unknown/Attention when impossible; new Verification uses current owner (G4) |
| GQ8 | Explicit orphan re-Start allowed, but the prior Open Verification must first conclude `Unknown` with conclusionReason `Orphaned`; no silent automatic restart; no identity reuse (G5) |

## Contract review (four-way)

| Pass | Scope | Findings |
|---|---|---|
| Design fidelity | contract → DID v1.11 / SD / P2-P7 traceability | round 1 (proposal review, independent): 24+ citations verified; see below |
| Dependency / coverage | §11 P8 keywords + P7 hand-off notes all owned | PASS after fixes (see R-fixes) |
| Executability | stories mechanically checkable | PASS after fixes |
| Risk / gaps | new frozen surfaces traceable to v1.11 | PASS after fixes |

Review round 2 (contract, independent): 6 Blocking (5 High + 1 Medium) — ALL FIXED:
R8 concurrency old stance removed (one-Open-per-revision everywhere); R9 G4 owner-snapshot landed (`02` §1, B-list home, Story G); R10 Orphaned path expressible (conclusionReason payload + governance-authority conclusion + evidence-precondition waiver); R11 parentExecutionId optionality filed as P2 inherited evolution (M-3); R12 ExecutionSettled payload enrichment + workId resolution filed (M-4); R13 wake/mission migration surfaces reclassified from "reusable" to M-1/M-2 with migration notes. Plus M-fixes: stale proposal framing removed, aggregation wording pinned to required-qualified semantics, new `VerificationAlreadyOpen` enum instead of P0-error reuse, acceptance-story coverage for PASS channel-1 wake / one-Open rejection / orphan flow / owner-snapshot, observed comparison pinned to exact (workId, targetWorkRevision) equality.

Review round 1 (independent, on the proposal): 4 Blocking + 3 Medium — all carried into the governed drafts:
R1 wake dual-channel (any verdict → VerificationChanged release; FAIL/UNKNOWN → VerificationReturned routing only — PASS-no-wake was a lost-wake-up defect); R2 GQ5 rewritten as an honest shape change (work-level wait), decided by v1.11 G2; R3 spawn crash-window closed (verifierExecutionId caller-preallocated in StartVerification payload; replay re-spawns idempotently); R4 mission schema defect promoted upstream and decided by v1.11 G1 (structured criteria); R5 Acceptance double-uniqueness idempotency; R6 Verifier Yield continuity permitted (P2 generic wait); R7 four-table naming aligned to DID §9.3.

**Blocking = 0.** (after round-2 fixes)

## Status

```text
FROZEN — P8 phase-scoped contracts; review Blocking = 0 (P8 FORMALLY CLOSED).
After governance confirmation this directory freezes and
planning/phases/P8.md may be authored. No implementation yet.
```
