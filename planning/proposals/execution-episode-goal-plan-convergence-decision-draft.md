# Execution Episode / Goal / Plan 收敛 — 治理决议草案

**状态：ACCEPTED / IMPLEMENTATION AUTHORIZED — 人工治理于 2026-10-03 接受。**

**Decision token：**

```text
ACCEPT_EXECUTION_EPISODE_GOAL_PLAN_CONVERGENCE
```

## 1. 决策摘要

废除 `ExecutionFocus = Work | Coordination`。Arbor 不再把“没有 workId”解释成
一种 Agent 模式。所有 Agent 执行复用同一个 Agent Loop，区别只由四项 exact
runtime facts 决定：

```text
1. 本次 Episode 为什么启动（binding）
2. Context 从哪些 authoritative refs 编译
3. 当前 Turn 可见哪些 typed tools
4. 什么 settlement 满足本 Episode contract
```

领域映射：

```text
Work       = 持久 Goal contract：最终什么必须成立
Plan       = Agent 通过工具维护的可变步骤清单：准备怎么做
Tool Call  = 当前执行的一个动作
Execution  = 推进 Goal 或处理一个 exact-bound input 的可恢复 episode
```

Plan 不产生领域 authority，不代替 Work，不完成 Work。

## 2. 删除错误抽象

以下概念退出新写路径：

```text
ExecutionFocus
Coordination
WorkspaceCoordination purpose
workspace-coordination-context-v1
CoordinationCompleted
```

`QueryCompleted` 也退出泛化结算；“回答消息”和“处理决策”必须保留各自身份，不能
再通过一个无字段 terminal result 猜测发生了什么。

“coordination”仍可作为自然语言描述（例如团队协调成本），但不得再是 Domain ADT、
数据库 discriminant、Agent mode、TurnProfile purpose 或 Context source selector。

## 3. 新 Execution Episode Binding

Workspace 主执行改用封闭、精确引用的 ADT：

```ts
type WorkspaceEpisodeBinding =
  | {
      readonly _tag: "WorkEpisode";
      readonly workspaceId: WorkspaceId;
      readonly workId: WorkId;
      readonly targetWorkRevision: WorkRevision;
    }
  | {
      readonly _tag: "ConversationResponseEpisode";
      readonly workspaceId: WorkspaceId;
      readonly messageId: MessageId;
      readonly responseJobRevision: number;
    }
  | {
      readonly _tag: "InboxEpisode";
      readonly workspaceId: WorkspaceId;
      readonly entryKey: InboxEntryKey;
      readonly inputKind: InboxInputKind;
    }
  | {
      readonly _tag: "DecisionEpisode";
      readonly workspaceId: WorkspaceId;
      readonly decisionId: DecisionRequestId;
      readonly decisionKind: "SelectCurrentWork";
      readonly requestRevision: number;
    };
```

硬规则：

- 不允许 `{ _tag: "Input"; ref: string }` 一类无语义兜底变体；
- 每个变体的 ref 必须指向可读取、可 CAS、可审计的 durable record；
- Episode 类型由 admission command 显式携带，不从缺失字段、Session 内容或模型输出
  反推；
- `ExecutionBoundAgentBinding` 继续承载 Specialist；Verifier 继续由 exact
  Verification binding 证明身份，后续可单独收敛，不塞进 Workspace catch-all；
- 一个 Workspace 仍最多一个 active main Execution。

## 4. Work 就是 Arbor 的 Goal contract

Work 保持 long-lived outcome，而不是执行步骤：

```text
objective            希望最终成立什么
status               Open | Completed | Cancelled
revision             当前目标版本
acceptance/verification 完成证据
responsible Workspace 谁对此结果负责
```

一个 Work 可以经历多个 Execution；一次 Execution 可以调用多个工具。Execution
失败、重启或让出不会重建 Work，也不会把 Goal 降级成聊天记录。

Work 的自动继续由 durable scheduler facts 驱动，而不是模型自旋：线程/Workspace
空闲、Work 仍 Open、等待条件满足、预算和 policy 允许时才 admission 下一 Episode。

## 5. Plan / Todo 是工具维护的工作状态

新增无品牌模型工具：

```text
update_plan
```

建议输入：

```ts
interface UpdatePlanInput {
  readonly expectedRevision: number;
  readonly items: ReadonlyArray<{
    readonly itemId: string;
    readonly text: string;
    readonly status: "Pending" | "InProgress" | "Completed" | "Blocked";
  }>;
}
```

Plan scope：

```text
Work Episode         → Work-scoped plan，可跨 Execution 恢复
Conversation/Inbox   → Execution-scoped plan，通常不需要
Decision Episode     → Execution-scoped plan
```

Plan 的硬边界：

- 是模型可更新的 scratch/progress state，不是 Domain command queue；
- item status 不产生 WorkCompleted、Verification、Acceptance 或权限；
- Runtime 不自动执行 Plan item；模型仍须发出真实 ToolCall；
- Plan 可以展示给用户，但 completion 只由领域证据判断；
- 简单任务允许完全不创建 Plan。

## 6. 统一 Agent Loop

所有 Episode 走同一条机械链：

```text
EpisodeBinding
  → Context Compiler（按 exact refs）
  → ResolvedTurnProfile（按 binding + authority + capability）
  → ProviderTurn
  → typed ModelOutput
      ├─ Text
      ├─ Executable ToolCall
      └─ Control ToolCall
  → ToolRuntime / ControlToolRegistry
  → durable observations
  → next Turn 或 typed settlement
```

禁止出现：

```text
if Coordination then ...
if no workId then conversation ...
if text exists then guess QueryCompleted ...
```

模型不需要感知 Arbor、Episode、Workspace 或内部 ID；模型只看到当前任务所需的
instructions、data 和无歧义工具名称。Binding 只在 Runtime 内决定 Context、授权和
结算。

## 7. Context 规则

| Binding | Authoritative context | 明确禁止 |
|---|---|---|
| WorkEpisode | Responsibility + exact Work revision + Work plan + closed Work Session frontier | Human conversation history、其他 Work 工具记录 |
| ConversationResponseEpisode | answered conversation turns + exact current message | Workspace Work Session、Work tools、Plan、未闭合调用 |
| InboxEpisode | exact Inbox entry +所需 Responsibility facts | 整个 Workspace Session 的无界回放 |
| DecisionEpisode | exact DecisionRequest + candidate snapshots/revisions | 从 Session 文本猜候选或决策原因 |

Context Compiler 必须从 Binding 开始查找来源；Session 只能提供该 Episode 明确拥有的
闭合 frontier，不能因为共享 Workspace 就自动继承。

## 8. Tool Surface

工具按当前 Episode materialize，而不是按 Agent 模式：

| Binding | 典型工具 |
|---|---|
| WorkEpisode | read/list/shell/patch、wait、declare_dependency、claim_completion、update_plan |
| ConversationResponseEpisode | 默认无工具；需要产品动作时只开放明确授权的工具 |
| InboxEpisode | 与 inputKind 匹配的 send_message / deliver / domain command tools |
| DecisionEpisode | select_current_work，以及完成该 decision 所需的只读工具 |

`claim_completion` 仍只是提交 Work 完成声明；Verification、Parent Acceptance 与
Work Completed 保持分离。

## 9. Settlement 取代

删除：

```text
CoordinationCompleted
QueryCompleted
```

新增精确结果：

```ts
type EpisodeCompletedResult =
  | CompletionClaimed
  | Yielded
  | { readonly _tag: "ConversationResponseProduced"; readonly messageId: MessageId }
  | { readonly _tag: "InboxInputHandled"; readonly entryKey: InboxEntryKey }
  | { readonly _tag: "DecisionSubmitted"; readonly decisionId: DecisionRequestId }
  | VerificationConcluded;
```

Settlement 必须与 Binding 匹配；例如 WorkEpisode 不得 settle
`ConversationResponseProduced`，Conversation Episode 不得 settle CompletionClaimed。

## 10. Scheduler / DecisionRequest

Scheduler 只做机械决定：

```text
exact runnable Work = 1  → Admit WorkEpisode
exact runnable Work > 1  → 持久化 WorkSelectionDecisionRequest
                           → Admit exact DecisionEpisode
Conversation Job eligible → Admit ConversationResponseEpisode
Inbox semantic input      → Admit exact InboxEpisode
无 eligible input         → Idle
```

Decision Agent 通过 `select_current_work` 工具提交选择。选择是工具调用，但
DecisionRequest 是这次执行为什么存在的 durable input；二者不能混为一物。

能由确定性 consumer 处理的 WorkflowSignal 不启动模型，也不创建伪 Work；只有确实
需要模型判断时才形成 typed DecisionRequest。

## 11. Persistence 与历史迁移

新增 forward-only migration 0024：

```text
executions.episode_kind
executions.episode_ref
executions.episode_revision
```

并建立按 kind 校验的引用/约束。旧 `focus_kind/focus_work_id` 在兼容窗口保留为只读
迁移来源，不能继续作为新写 truth。

可机械迁移：

```text
focus=work                         → WorkEpisode
conversation_attempts.executionId → ConversationResponseEpisode
claimed legacy HumanMessage       → ConversationResponseEpisode + legacy provenance
verification_executions           → 保持 exact verifier binding
```

无法精确归类的历史 `focus=coordination`：

- 保留原 row、manifest、session 和 settlement 供审计；
- 已 settled 的记录只读展示，不重解释；
- active/unsettled 进入 `NeedsAttention(LegacyEpisodeBindingAmbiguous)` 或
  `ReconciliationRequired`；
- 禁止根据 Session 文本或“看起来像对话”猜测绑定；
- 新代码不得创建新的 ambiguous row。

## 12. 实施波次

### Wave A — Domain / migration contract

- 冻结 EpisodeBinding、exact settlement、DecisionRequest；
- 写 migration/restart/legacy ambiguity tests；
- owning docs 落字。

### Wave B — Conversation + Work

- Conversation trigger 写 exact message binding；
- Work scheduler 写 exact Work binding；
- Context Compiler 从 binding 选来源；
- 删除两条路径对 Coordination 的依赖。

### Wave C — Scheduler decision + Inbox

- 多候选选择迁移为 DecisionRequest；
- semantic Inbox 迁移为 InboxEpisode；
- deterministic consumers 保持无模型路径。

### Wave D — Plan tool

- Plan store / revision / `update_plan`；
- Work-scoped restart recovery；
- UI 展示，不参与完成 authority。

### Wave E — 删除兼容写路径

- 删除 Agent Runtime / Model Context 的 Coordination branches；
- 禁止新 `focus_kind=coordination`；
- 删除旧 settlement 生产能力；
- 保留只读历史 decoder。

## 13. 验收门

1. 新生产代码中不存在 `_tag: "Coordination"`、`WorkspaceCoordination`、
   `CoordinationCompleted` 的可达写路径。
2. “你好”请求只携带 exact message conversation context。
3. Work tool frontier 只能进入同 Work/plan scope。
4. 多 runnable Work 产生 exact DecisionRequest，模型通过工具选择。
5. Inbox Episode 不能看到无关 Session 历史。
6. Plan 更新可 crash/restart 恢复，但不能完成 Work。
7. 每个 settlement 与 EpisodeBinding 有机械匹配检查。
8. 历史 ambiguous Coordination fail-closed 且审计可读。
9. 所有 L1/L2、黑盒、restart、真实 Provider 资格测试通过。
10. `pnpm check` 全绿，架构测试禁止重新引入 catch-all episode。

## 14. 治理影响

接受后需要由人工治理更新：

```text
docs/design/02-system-design.md
docs/design/03-detailed-implementation-design.md
docs/design/implementation/P2/**
docs/design/implementation/P3/**
docs/design/implementation/P14/**
```

本草案不直接修改 `docs/design/**`。在上述 owning contracts 完成 supersession 前，
实现保持 blocked。
