# P14 — 02 Conversation Execution（trigger/admission/排队/精确一次）

**Owns:** durable human message → bounded Coordination Execution 的 server-side 闭环
**Does not own:** 命令语义（`01`）、read model（`03`）

## 1. 执行链（frozen，G-B）

```text
SubmitHumanMessage（durable pending）
→ Root Inbox admission（HumanConversation）
→ deterministic conversation trigger（本合同 §2）
→ scheduler / Application admission
→ AdmitExecution(WorkspaceMain, focus=Coordination)     ← server-side wiring
→ 既有 P2/P3 agent 链（ProviderTurn/ToolInvocation 任意多轮）
→ AgentLoopStep 幂等接受 user-visible ModelOutput / actions / settlement proposal
→ SettleExecution(Completed(QueryCompleted))
→ transcript projection + human_messages.state=Answered
```

- **复用**：`ExecutionFocus=Coordination`、`Completed(QueryCompleted)`、
  WorkspaceMain admission、WorkspacePrimary Session（认知连续）。
- **不发明** conversational/synthetic Work（`05` seam-4 机械锁定：
  Coordination execution 不得绑定 workId；Work 路径不受影响）。
- **浏览器/UI 不得直连 external `AdmitExecution`**（`05` seam-8：web 源码
  架构扫描 AdmitExecution 零出现；P13 `02` U-3 的 UI 面不推翻）。

## 2. Deterministic conversation trigger（frozen）

- 触发器 = Application 端确定性 consumer（沿既有 offset-driven consumer
  模式），订阅 `HumanMessageSubmitted`：
  1. 观察到 `state=Pending` 的 human message；
  2. root workspace 无 active main execution → claim → admission；
  3. 有 active main → 留 Pending（§3 排队）。
- **claim 语义**：同一事务内 `Pending → Claimed(claimed_by_execution_id)`
  （CAS）；claim 后 consumer 崩溃 → 恢复扫描发现 Claimed 无对应活跃
  execution（execution 表核对）→ 回滚 Pending 重试（`05` seam-6）。
- claim 顺序：`created_at` 升序（FIFO；同 project）。

## 3. One-active-main 排队（frozen）

```text
Root 已有 Active Main Execution：
  human message durable Pending
  → 不开第二个 WorkspaceMain
  → 不打断当前 execution
  → 当前 main settle 后，trigger 依 FIFO claim 下一条 Pending
```

- v1 接受串行模型；需立即干预当前工作 = 冻结的 `SteerWork`/`StopExecution`
  （chat 永不携带 interrupt/steer 语义——`05` seam-3/4）。

## 4. Exact-once logical response（frozen）

```text
1 accepted HumanMessage → 恰好 1 user-visible response episode
```

### 4.1 Durable two-step recovery protocol（reconciliation 2026-09-23）

响应写回**不是**与 settlement 同事务的单步操作，而是 P14 拥有的
**durable two-step recovery protocol**：

```text
Step 1（canonical，P2 冻结，P14 不参与）
  SettleExecution(Completed(...)) 提交：Execution + receipt + event 原子
  —— 该事务由 P2 拥有且不含 conversation 依赖；P14 不 reopen P2。

Step 2（P14 拥有，settlement durable 之后）
  conversation tick sweep 观察已 settle 的 execution →
  幂等 CAS 写回（state → Answered + bounded response body）。
```

- **显式 crash window（settle → writeback）**：Step 1 提交后、Step 2 完成前，
  message 处于 `Claimed` 且无 `Answered`/response body。该窗口是**协议
  的一部分**（可见且安全），不是实现缺陷：
  - 不产生双重 admission（`Claimed` 门禁止再 claim）；
  - 不丢消息（sweep 扫描全部 `Claimed`，重启后继续）；
  - 不产生第二条回复（`markAnswered` CAS `WHERE state='Claimed'`，重复
    sweep/重放为 no-op）。
- **sweep 是 correctness mechanism**（非优化）：系统对"恰好一条回复"的保证
  由 `Claimed` 门 + 确定性扫描 + CAS 共同构成，不依赖 Step 1/2 的原子性。
- 幂等锚：`messageId`；execution claim 写 `claimed_by_execution_id`。
- crash/replay 不重复回复：重放同一 commandId → 幂等 receipt（`01` §2）；
  consumer 重扫只认 `Pending`；Claimed-without-execution 回滚（§2）；
  transcript response 以 messageId/executionId 关联投影（重放安全）。
- 逻辑一次 = 用户可见恰好一条 Assistant turn；物理 at-least-once 由上述锚
  收敛（`05` seam-6 机械测试：claim/settle 两点注入 crash）。

### 4.2 Settlement 分支处理（DID v1.24 / P17 superseded）

| Settlement | 写回 | 理由 |
|---|---|---|
| `Completed(QueryCompleted)` | Job `Answered` + bounded response body | 产出唯一 user-visible response |
| `Failed` | settle Attempt → typed failure classification → `RetryScheduled` 或 `NeedsAttention` | Failed 本身不授权重试 |
| `OutcomeUnknown` | Job `NeedsAttention(ReconciliationRequired)` | 永不自动 replay |
| `Interrupted` | Job `Cancelled(ControlledStop)`，或若有可恢复 state 则同 Attempt pause/resume | 不伪装 `Answered(null)` |

旧的无界 `retry-until-response` 已被撤销。新 attempt 仍使用
`(messageId, attemptNo)` 派生确定性 executionId/commandId，但仅在 P17
Recovery Policy 对 terminal transient failure 作出 durable RetryScheduled
决定且 nextEligibleAt 到期后创建。Approval/reconciliation/compaction/可恢复
stream interruption 恢复同一 Attempt/Execution。

### 4.3 Reconciliation record（P14-owns；不 reopen P2）

**问题**：P14 合同初版 §4 写"SettleExecution 同事务将 state → Answered"，
实现是 tick sweep + 幂等 CAS。机械判定 frozen invariant 要求哪一种：

- **A（必须同事务、不可分离）**：不成立。P2 `SettleExecution` handler 由 P2
  冻结且依赖集仅 `executions` + `workWaits`（无 conversation 概念）；要求 A
  必须改 P2 → 违反"P14 不 reopen P2"。transcript 是 P10 派生 read model
  （明确 "NOT TRUTH"），派生状态不需要与 canonical settlement 原子。
- **B（settlement durable 后允许 crash-visible 中间窗口，但必须可确定性
  重发现 / 重启继续 / CAS exactly-once / 重复 sweep 安全 / 已写不重写 /
  不永久 stuck / one-active-main 与 FIFO 保持）**：成立，且是本架构既有规范
  （P8 先例：spawn crash-window closed，replay re-spawns idempotently）。

**裁决**：上游只要求 B。本合同按 B 精确修订（§4.1/§4.2）；P2 不 reopen。

### 4.4 AgentLoopStep → HumanMessage final convergence（DID v1.20 successor）

P14 的两步协议继续有效，但 Execution settlement 之前新增了由 P3/P9 拥有的
持久交接前置条件：

```text
complete Provider success
→ AgentLoopStep.ProviderResultAvailable
→ sourced ModelOutput exactly once
→ actions/observations converge
→ unresolved-side-effect gate clear OR OutcomeUnknown proposal
→ AgentLoopStep.SettlementProposed
→ SettleExecution
→ existing P14 sweep converges HumanMessage
```

- `ProviderResultAvailable` / `OutputAccepted` 中的 crash 不释放消息、不创建
  第二个 conversation attempt；原 Execution 在新 generation 下继续交接，同一
  ProviderTurn 禁止再次请求。
- `SettlementProposed` 已持久化但 Execution 仍 Active 时，恢复提交当前-
  generation SettleExecution；不得从 Session 文本猜 settlement。
- Execution 已 settle、HumanMessage 仍 Claimed 时，继续使用 §4.1 sweep；不执行
  新 Agent action，不生成第二条 Assistant turn。
- 只有 terminal `Failed` 且 P17 classifier 判为 transient、预算允许时，才形成
  RetryScheduled；OutcomeUnknown/ReconciliationPending 进入 Attention/同 run
  对账，禁止自动新 attempt。
- `Interrupted` 按 §4.2 收敛为 Cancelled 或同 run pause/resume；Runtime Safety
  Stop 仍须先通过 unresolved-side-effect gate。

DOGFOOD-DG-01 等价 fixture 的目标收敛是：原 Claimed message 在原 Execution
的 settled Provider result 上恢复，得到恰好一个 sourced ModelOutput 和一个
Assistant turn，Provider 请求计数不增加。

### 4.5 P17 Context/Eligibility gate

Conversation trigger 不再扫描 HumanMessage Pending/Claimed；它只消费
ResponseJob `Queued` 或到期的 `RetryScheduled`。Admission 前必须同时满足：

- Project Open、root main vacant、Job revision current；
- SessionContextGate Ready；
- deployment breaker admits；
- TurnProfileResolver produces RootConversationRespond v1；
- attempt/time/fingerprint budgets 未耗尽。

任何 Blocked/Attention/Cancelled/Answered 都产生零 Provider bytes。完整合同见
P17 `02`–`04`。


## 5. Session 连续性（frozen）

- 同一 Root Workspace 的所有 Coordination executions 绑定**同一**
  WorkspacePrimary Session（`GQ-E`）；execution 各自 bounded。
- Control Reinjection（DID §8.13）：每轮 bootstrap 从 Canonical State 重建
  ——对话历史经 transcript/session 认知面进入，不依赖进程内存。

## 6. Must Not Decide

- 不决定回复内容/model 行为（agent 链既有）；
- 不决定 transcript DTO（`03`）;
- 不引入 streaming；
- 不给 chat 加 priority/preemption（排队只有 FIFO）。

## 7. Verification

单测/注入测试：trigger FIFO；one-active-main 排队（有 active 时零
admission）；claim CAS；crash@claim / crash@settle 恢复 exact-once；
Coordination execution 无 workId 绑定；`HumanConversation` inbox 条目
不产生 steer 事件。

DID v1.20 successor 另要求 P9 `07` AH13 与 DOGFOOD 等价 fixture：
AgentLoopStep settlement proposal → Execution settlement → HumanMessage sweep 的
每个 crash 窗口均收敛，且完整成功 ProviderTurn 零重复请求。
