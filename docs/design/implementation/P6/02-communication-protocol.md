# P6 — 02 Communication Protocol

**Authority:** DID v1.9 §4.2, §1.8(Message), §2 表(Inbox), §5.4, §12.10 表, §8.4A; SD v1.3 §7.1–§7.5, §13.5, 不变量 20/21/31/36; P3 `03` §3. Resolved D2.
**Status:** FROZEN (manual governance adoption).

## 1. P6 的 Message 语义子集（D2 冻结闭合）

work-plane primitives 共 6 种（SD §7.2）；P6 冻结其中 4 种为 Model-visible Message kinds：

```text
Query            — 允许的 Workspace 间查询（Observer 语义，非治理）
Reply            — 对 Query 的回复
Report           — Child → Parent 重要发现向上暴露
DecisionRequest  — Child → Parent 请求高层裁决
```

- `Assign` 走 P1 `AssignWork` 命令（不是 Message）；`Deliver` 绑定 `Deliverable`，归 P7。
- **D2 冻结负定义：`Report` ≠ `Deliverable`，且不能满足任何 Dependency。** Dependency satisfaction 只能由 P7 的 structural matcher（`producerBinding` + `expectedDeliverable` 对 `DeliverableMatchView`）完成；Report 的到达不产生任何 Dependency 状态变化，也不得被 promotion 规则映射为 satisfaction 事实。
- `Message` 只用于需要认知处理的通信，不是 universal system envelope（DID §1.8）；Inbox 是未消费输入的 projection（DID §2 表）。
- 普通消息默认不抢占当前执行（SD §7.3）；Message arrival ≠ execution preemption（不变量 21）。到达只触发 runnable reevaluation（DID §5.4）。

## 2. `OutboundMessage`（P6 冻结载荷，补齐 P3 `03` 留名）

```ts
interface OutboundMessage {
  readonly kind: "Query" | "Reply" | "Report" | "DecisionRequest";
  readonly recipientWorkspaceId: WorkspaceId;
  readonly bodyRef: ContentRef;                   // 正文进 Artifact/Blob，Model Context 只进 bounded view（DID §8.14）
  readonly correlationId?: CorrelationId;         // Query/Reply 必填其一侧；Report/DecisionRequest 可选
  readonly causationId?: CausationId;             // 触发本消息的既往事件/消息引用
  readonly urgency: "Normal";                     // P6 仅 Normal；Critical 属治理通道（04）
}
```

- `correlationId` 实现 SD §13.5 的 Correlation；`causationId` 实现 Causation；均由 Communication Runtime 分配/校验，不由模型自填自证。
- `Query` 的合法收件人集合：ancestor 链与同 Project 内允许被查询的 Workspace（observability 可覆盖 subtree，SD §8.1；写权限不随之流动）。

## 3. `SendMessage` command（P6 实现冻结命令）

DID §4.2 Coordination 组命令、§12.10 表行：`SendMessage → MessageSent`，store = `MessageStore`，pipeline = application / communication。

### Payload

```ts
{
  readonly messageId: MessageId;                 // caller-preallocated
  readonly senderWorkspaceId: WorkspaceId;       // 由 authority fact 绑定，不接受自由填写
  readonly message: OutboundMessage;
  readonly idempotency: { commandId, fingerprint } // 沿用 P1 §8 幂等规则
}
```

### Preconditions / rejections

| Condition | Rejection |
|---|---|
| recipient not found | `CommandRejection.WorkspaceNotFound` |
| recipient 不在同一 Project | `DomainError.AuthorityDenied` |
| recipient lifecycle != Active | `DomainError.TerminalLifecycleMutation` |
| sender authority fact 与执行 Workspace 不符 | `DomainError.AuthorityDenied` |
| kind=Query 且收件人不在合法查询集合 | `DomainError.AuthorityDenied` |
| bodyRef 超过 sender 上传配额 | `CommandRejection.ResourceExhausted`（**P6 冻结新增枚举**，P1 未定义） |

### Events

```text
MessageSent
```

- `SendMessage` 是 durable communication，不是 canonical mutation envelope（DID §12.10 表注）；它不直接改 Domain 状态，后果经 Inbox promotion（§4）生效。

## 4. Inbox：Admission → Promotion → Consumption（SD §7.5 直译）

### Admission（Communication Runtime）

验证来源、authority、结构并持久化。进入 recipient Workspace Inbox。Admission 是 upsert-by-key（`messageId` 为 key；D3 同型规则），at-least-once 投递下重复 admission 是 no-op。

### Promotion（deterministic first）

Runtime 将确定性后果直接提交为 Canonical State。P6 冻结的 promotion 规则：

```text
Reply(correlationId=Q)              → Q 标记 answered（correlation 状态）
DecisionRequest 到达 Parent Inbox   → 触发 parent runnable reevaluation（仅此）
Report                              → 无 canonical 后果（认知性输入；D2）
```

Promotion 不调用模型（Receive != Promote != Consume）。**P7 之前的 promotion 集不含任何 Dependency satisfaction**（D2）。

### Consumption（cognitive，Agent 侧）

Context Builder 只选择与 Current Work、Interrupt 或高价值事项相关的未消费输入（SD §7.4：Inbox != Next Context）；消费标记是 Session 认知事件，不是 canonical mutation。

### Wake

Inbox arrival 是 wake-signal source（DID v1.7 G3 职责划分：source phase 产信号，P2 拥有 durable wait 机制）。P6 Communication Runtime 在 admission 后发布对应 wake signal；不重复实现 timer。

## 5. `Communicate` directive 的兑现

P5 `03` §2 中 `Communicate` 仅记录 Observation（no outbound routing）。P6 起：

```text
Communicate(OutboundMessage)
  ↓ decodeTurn 校验（P3 Output Contract）
  ↓ directive handler
SendMessage command（§3）
  ↓
MessageSent → recipient Inbox admission → promotion → wake
  ↓
发送方收到 model-visible Observation：MessageDelivered(messageId, admitSummary)
```

- 发送是 durable 事实（MessageSent + Inbox admission 同一可靠提交边界，不变量 36 模式）。
- 发送成功 ≠ 对方已认知（SD §7.1：Message 到达不表示 Agent 已经理解）。

## 6. `RequestGovernance` 的最小路由

P5 `03` §2 中 RequestGovernance 仅记录 Observation。P6 冻结两个最小路由目标（完整 governance 体系仍 deferred）：

```text
GovernanceRequest { kind: FormationApproval, proposalId, proposalRevision }
  → FormationProposal admitted + human Inbox（01 §4；D1 链）

GovernanceRequest { kind: DecisionRequest, question, correlationId }
  → parent Workspace Inbox（作为 DecisionRequest Message 消费）
```

- 路由本身不产生 canonical mutation；裁决仍走 `RecordDecision`。
- 其余 kind 保持 P5 行为（Observation 记录）。

## 7. Must Not Decide

- No `Deliverable` / `Deliver` / `DeclareDependency` / `SatisfyDependency`（P7）。
- No 把 Report（或任何 Message）转化为 Dependency satisfaction 的规则（D2 禁令；P7 拥有 satisfaction）。
- No 消息优先级/抢占调度语义（Critical 通道属治理，`04`）。
- No Inbox 永久历史库语义（Inbox 是未消费集合；历史归 Session/Journal，SD §7.4）。
- No 跨 Project 通信。
- No anonymous/未验证来源 admission（Admission 必须验证来源与 authority）。
