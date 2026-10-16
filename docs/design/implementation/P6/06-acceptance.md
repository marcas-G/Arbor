# P6 — 06 Acceptance Stories

**Authority:** S1.4 步骤 1–6, S2 §3–§7; DID v1.9 §11 P6, §5.4, v1.47 P8 UnboundLegacy route amendment; P5 `05`（验收故事风格先例）; P6 `01`–`05`（含 D1–D4 约束断言）.
**Status:** FROZEN (manual governance adoption).

全部故事使用 deterministic Fake Provider（沿 P5 决策），同一 durable DB，`apps/` 既有 composition root 扩展，不新建第二套 runtime。

## 1. Story A — 第一层分工形成（含 human gate，D1 全约束）

1. `CreateProject` bootstrap 出 Root Workspace。
2. Root main Execution 与"用户"讨论后发出 `ProposeChildWorkspace(proposal-A)`。
3. 断言：无 `WorkspaceCreated`；FormationProposal admitted（Pending, revision=1）；human Inbox 含 governance 引用；`RequestGovernance` 观察 model-visible。
4. 用户 `RecordDecision { outcome: modify(proposal-A') }`。
5. 断言：proposal revision=2，内容为 A'，仍 Pending。
6. 用户 `RecordDecision { expectedProposalRevision: 1 }`（stale）→ `DomainError.RevisionConflict`，不产生任何 governance fact。
7. 用户 `RecordDecision { expectedProposalRevision: 2, outcome: approve }`。
8. 断言：`DecisionRecorded { proposalId, proposalRevision: 2 }` 产生；**此刻仍无 `WorkspaceCreated`**（approve 只是 governance fact）。
9. Application consumer 执行（deterministic CommandId）。
10. 断言：`WorkspaceCreated`（parent=Root，depth=1）+ `WorkAssigned`（initialWork）；子 Workspace Inbox 含 bootstrap 输入。
11. 重放步骤 7 的 decision 投递 → 幂等 Receipt，不重复 create。
12. 子 Workspace 首次 admission 的 Context 含五项 bootstrap 来源（01 §5），`rationale` 标注为 DataOnly。

## 2. Story B — 深层自主 formation（无 gate）

1. 子 Workspace（depth=1）执行中发出 `ProposeChildWorkspace(proposal-B)`。
2. 断言：**不经过** human Inbox / FormationProposal 实体；authority fact 投影判定（03 §3）后直接 `WorkspaceCreated`（depth=2）。
3. 构造 `resourceBoundaryDraft ⊄ parent 边界` 的反例 → `AuthorityDenied`，Execution 不失败，观察可续。
4. sibling 试图为非自己 parent 的 Workspace 发起 formation → `AuthorityDenied`（R3）。

## 3. Story C — specialist spawn 与结果回流（D3 全约束）

1. 父 Execution 发出 `SpawnSpecialist(spec)` → `ExecutionAdmitted(ExecutionBound)`，原子带 `ExecutionScoped` Session。
2. specialist 执行两 Turn 后 `Completed`。
3. 断言：父 Workspace Inbox 收到 SpecialistSettled（dedup key = specialistExecutionId + settlementFingerprint）；父 Session **零写入**（条目数不变为机械断言）；reevaluation 触发。
4. **重放 SpecialistSettled 投递两次** → Inbox 仍恰有一条（upsert-by-key）；无重复 canonical 副果。
5. `StopExecution` 提交后的父 Execution 再发 `SpawnSpecialist` → 拒绝新 admission（quiescence 列表）。

## 4. Story D — Communication 全链路（D2 约束）

1. Child 发 `Communicate(Report)` → `MessageSent` → parent Inbox admission（同一提交边界）。
2. 断言：parent 当前 active main **不被抢占**（不变量 21）；wake signal 已注册。
3. **断言：Report 到达不产生任何 Dependency 类事件/状态变化（D2：Report ≠ Deliverable，无 satisfaction 语义）**。
4. parent 消费 Report 后发 `Communicate(Reply, correlationId)` → child 侧 correlation 关闭（promotion）。
5. `Query` 发往非法收件人（sibling 之外/跨 Project）→ `AuthorityDenied`。

## 5. Story E — Human Steer（S2 切片）

1. 用户对 depth=1 Workspace 的 Open Work 发 `SteerWork(Normal)`。
2. 断言：无执行中断；`WorkSteered` revision++；下次 admission Context 含 guidance（bounded）。
3. `SteerWork(Critical)`：同一提交边界内 `WorkSteered` + `StopExecution`；active main 进入 quiescence，无新 ProviderTurn/ToolInvocation/spawn。
4. Work 保持 Open；reevaluation 后重新 admission（恢复自治，S2 §7）。
5. sibling 对该 Work 发 steer → `AuthorityDenied`。

## 6. Story F — Prompt Program 版本纪律（D4 约束）

1. 四个 Program v1 全量 eval 绿（05 §3 E1–E4）。
2. 机械断言：每个 Program 文件头含 `contractRevision + textVersion + textHash`；Manifest hash 一致。
3. 变更实验：textVersion bump 后未跑 eval → CI/验证门拒绝（合入条件 = eval 全量绿）。
4. 诱导性 eval：模型试图以 Report 充当交付/依赖满足 → E3 违禁断言触发。

## 7. Story I — P8 UnboundLegacy current-route Governance Inbox（DID v1.47）

1. 用可识别但无法证明 permanent replay origin 的历史成功
   `RetryVerification` receipt 建立 fixture；migration 同一事务留下不可变
   `UnboundLegacy/OriginEvidenceIncomplete` disposition 和一个 P6 Governance
   Inbox entry。Inbox 使用现有 `Governance` kind 与
   `retry-verification-unbound:<commandId>` stable key，不新增 P6/P7/P14/P10
   kind/Attention source。
2. 验证 typed `RetryVerificationUnboundLegacy` 内容只含 CommandId、ProjectId、
   source WorkId/VerificationId、固定 disposition/reason 与 Inbox row
   timestamps/revision；任何 receipt JSON、summary、event JSON、fingerprint、
   path/host detail 都不出现在该条目。Agent/Session consumer 不获得条目；人类
   读取不消费、不 ACK、不 clear、不发 command/wake/ProviderTurn。
3. Root Work current route 只对当前 Root-local human 可见；child Work current
   route 只对当前 exact direct-Parent Workspace human 可见。Foreign/unauthenticated
   human 与 Agent 读取 fail closed。P12 每次按当前 canonical owner/Parent 与
   current P8 auth re-evaluate，Inbox row 本身不授予权限。
4. Owner/Parent route move 在同一 P1 command transaction 更新 canonical route 与
   同一个 Inbox stable key。Commit 前旧 route 与 canonical owner 都不变；commit
   后旧 recipient 立刻不可见、新 recipient 得到同一 key，无 duplicate/asynchronous
   visibility window。Inbox createdAt 保持；真实 move 的 revision 只加一次并更新
   updatedAt；重复/no-op reconciliation 不改 timestamps/revision。
5. 若该 move 无法在同一 transaction 完成，命令必须走 P1 Gateway 并返回
   `TerminalRejected(AuthorityDenied)`（或最窄现有 typed rejection），提交正常
   terminal receipt/attempt；canonical Work/Workspace/Event/Inbox/disposition 均零
   mutation。相同 CommandId/tuple 返回同一拒绝 receipt；不同 CommandId 独立拒绝。
   覆盖 receipt transaction commit 前/后 crash；禁止 pre-Gateway rejection/read。
6. 只移除 disposable fixture 的 Inbox projection row，然后 prunе/corrupt receipt
   JSON 与相关 Domain Events；从 disposition 与当前 canonical Work/Workspace
   facts rebuild 一个当前 recipient row，不查询/解码 receipt、不依赖 Event
   retention。相同 stable key 的 source/disposition 内容不一致为 typed integrity
   corruption，不覆盖原行。
7. Ordered P8 migration 的 commit 前 crash 不留下 disposition 或对应 Inbox row；
   commit 后二者均存在。Migration ID/physical DDL 仍按 P1 `04` 后续
   implementation package 冻结，不在本验收中发明。

## 8. 机械断言清单（汇总）

```text
- 01 §4 两条 formation 链的每步事件序列与拒绝集与契约逐条一致
- D1：approve 与 create 是两个可观测步骤（DecisionRecorded ≠ WorkspaceCreated；stale revision 拒绝；幂等重投）
- D2：Report 无任何 Dependency 副果（负断言）
- D3：Inbox upsert-by-key 重放幂等；Parent Session 零写入
- D4：双层版本字段齐全；text 变更 → eval 强制门
- depth 判定纯结构计算（无模型参与）的单元证明
- capability ceiling 四项 validate-only 检查各有正/反例
- Inbox admission/promotion/consumption 三段各有独立可观测断言
- Story I：Governance kind/key/payload、current P8 authorization、same-P1-transaction route move、Gateway rejection receipt replay、disposition-only rebuild 与 no-consume 断言
- Normal/Critical steer 的中断差异可由 Execution 动作计数判定
- 既有 P5 验收故事不回归（重构护栏）
```

## 9. Must Not Decide

- No 真实 provider / 真实人类在线作为 gating 条件（human 角色由测试驱动）。
- No P7/P8 owner behavior enters the assertions except the fixed DID v1.47
  P8 `UnboundLegacy` trigger/disposition/replay boundary explicitly accepted
  for Story I; dependency/verification behavior outside that fixed boundary
  remains out of scope.
- No UI/projection 呈现验收（P10）。
