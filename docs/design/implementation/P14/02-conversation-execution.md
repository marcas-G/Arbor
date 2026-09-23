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
→ user-visible ModelOutput
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

- 幂等锚：`messageId`。execution claim 写入 `claimed_by_execution_id`；
  `SettleExecution(Completed)` 同事务将 `state → Answered` 并写 transcript
  projection 的 response 关联（`03`）。
- crash/replay 不重复回复：重放同一 commandId → 幂等 receipt（`01` §2）；
  consumer 重扫只认 `Pending`；Claimed-without-execution 回滚（§2）；
  transcript response 行以 executionId 唯一键投影（upsert，天然重放安全）。
- 逻辑一次 = 用户可见恰好一条 Assistant turn；物理 at-least-once 由上述
  锚收敛（`05` seam-6 机械测试：注入 crash 于 claim/settle 两点）。
- **retry-until-response 语义**：execution 若以 Failed/OutcomeUnknown
  settle（未产出 user-visible 回复），Claimed 无后续 → 回滚 Pending 重试；
  每条消息仍恰好一条最终 user-visible turn（中间失败轮不投影 Assistant
  turn，可投影既有 kind 的失败条目——不违反 1→1 response episode）。

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
