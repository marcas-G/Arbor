# P6 — 06 Acceptance Stories

**Authority:** S1.4 步骤 1–6, S2 §3–§7; DID v1.9 §11 P6; P5 `05`（验收故事风格先例）.
**Status:** PROPOSAL DRAFT.

全部故事使用 deterministic Fake Provider（沿 P5 决策），同一 durable DB，`apps/` 既有 composition root 扩展，不新建第二套 runtime。

## 1. Story A — 第一层分工形成（含 human gate）

1. `CreateProject` bootstrap 出 Root Workspace。
2. Root main Execution 与"用户"讨论后发出 `ProposeChildWorkspace(proposal-A)`。
3. 断言：无 `WorkspaceCreated`；governance request 进入 human Inbox；`RequestGovernance` 观察 model-visible。
4. 用户 `RecordDecision(approve, proposal-A)`。
5. 断言：`WorkspaceCreated`（parent=Root，depth=1）+ `WorkAssigned`（initialWork）；子 Workspace Inbox 含 bootstrap 输入。
6. 子 Workspace 首次 admission 的 Context 含五项 bootstrap 来源（01 §5），`rationale` 标注为 DataOnly。

## 2. Story B — 深层自主 formation（无 gate）

1. 子 Workspace（depth=1）执行中发出 `ProposeChildWorkspace(proposal-B)`。
2. 断言：**不经过** human Inbox；authority fact 投影判定（03 §3）后直接 `WorkspaceCreated`（depth=2）。
3. 构造 `resourceBoundaryDraft ⊄ parent 边界` 的反例 → `AuthorityDenied`，Execution 不失败，观察可续。
4. sibling 试图为非自己 parent 的 Workspace 发起 formation → `AuthorityDenied`（R3）。

## 3. Story C — specialist spawn 与结果回流

1. 父 Execution 发出 `SpawnSpecialist(spec)` → `ExecutionAdmitted(ExecutionBound)`，原子带 `ExecutionScoped` Session。
2. specialist 执行两 Turn 后 `Completed`。
3. 断言：父 Workspace Inbox 收到 specialist 完成观察（D3）；父 Session **未被直接写入**；reevaluation 触发。
4. `StopExecution` 提交后的父 Execution 再发 `SpawnSpecialist` → 拒绝新 admission（quiescence 列表）。

## 4. Story D — Communication 全链路

1. Child 发 `Communicate(Report)` → `MessageSent` → parent Inbox admission（同一提交边界）。
2. 断言：parent 当前 active main **不被抢占**（不变量 21）；wake signal 已注册。
3. parent 消费 Report 后发 `Communicate(Reply, correlationId)` → child 侧 correlation 关闭（promotion）。
4. `Query` 发往非法收件人（sibling 之外/跨 Project）→ `AuthorityDenied`。

## 5. Story E — Human Steer（S2 切片）

1. 用户对 depth=1 Workspace 的 Open Work 发 `SteerWork(Normal)`。
2. 断言：无执行中断；`WorkSteered` revision++；下次 admission Context 含 guidance（bounded）。
3. `SteerWork(Critical)`：同一提交边界内 `WorkSteered` + `StopExecution`；active main 进入 quiescence，无新 ProviderTurn/ToolInvocation/spawn。
4. Work 保持 Open；reevaluation 后重新 admission（恢复自治，S2 §7）。
5. sibling 对该 Work 发 steer → `AuthorityDenied`。

## 6. 机械断言清单（汇总）

```text
- 01 §4 两条 formation 链的每步事件序列与拒绝集与契约逐条一致
- depth 判定纯结构计算（无模型参与）的单元证明
- capability ceiling 四项 validate-only 检查各有正/反例
- Inbox admission/promotion/consumption 三段各有独立可观测断言
- Normal/Critical steer 的中断差异可由 Execution 动作计数判定
- 4 个 Prompt Program v1 的 eval 集（05 §3）全绿
- 既有 P5 验收故事不回归（重构护栏）
```

## 7. Must Not Decide

- No 真实 provider / 真实人类在线作为 gating 条件（human 角色由测试驱动）。
- No P7/P8 行为进入断言（依赖/验证词出现即越界信号）。
- No UI/projection 呈现验收（P10）。
