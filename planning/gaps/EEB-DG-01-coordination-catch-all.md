# EEB-DG-01 — `Coordination` 把不同 Execution Episode 混成一个兜底类型

## 状态

**RESOLVED / IMPLEMENTATION AUTHORIZED — DID v1.28 / System Design v1.6**

## 触发证据

2026-10-03 的真实单 Agent 对话中，用户只发送“你好”，但 Root Conversation
ProviderTurn 同时携带了此前 Work Execution 留下的 Shell ToolCall、ToolResult 和
测试输出。DeepSeek 连续三次返回 `finish_reason=stop` 且没有可消费文本，最终进入
`NeedsAttention(DeterministicModelFailure)`。

直接调用同一 `deepseek-flash` deployment 能正常回答“你好”，证明 Provider、模型名
和凭据不是根因。生产 Manifest 则证明错误请求同时出现：

```text
turnProfile.purpose = RootConversationRespond
contextRefs          = human-input + historical Work tool call/result refs
inputFrontier        = historical Workspace Session frontier
```

本轮止血修复已让 Conversation 只消费 Human Conversation history，并以真实黑盒证明：

```text
用户：你好
Arbor：你好！有什么可以帮你的吗？

contextRefs  = [human-input:<messageId>]
toolRefs     = []
inputFrontier = { firstSequence: null, lastSequence: null }
```

但进一步审计发现，根因不是一处 Context 判断，而是冻结领域模型将所有“不绑定
Work 的 Workspace Execution”压成 `ExecutionFocus=Coordination`。这个单一标签同时
承担：

- Human Conversation response；
- 多个 runnable Work 的语义选择；
- Inbox / decision / query 输入处理；
- Workspace 层工具调用；
- 无 Work 的兼容/恢复执行。

`rg` 在 Domain、Runtime、SQLite、应用和测试中发现约 350 处
`Coordination/coordination` 依赖。它已进入 frozen ADT、DDL、Scheduler、Settlement、
P14 合同和历史迁移，不能通过改名或局部分支根治。

## 为什么这是 Design Gap

当前冻结合同明确要求：

```text
ExecutionFocus = Work(workId) | Coordination
CompletedResult 包含 CoordinationCompleted / QueryCompleted
Human Conversation 复用 WorkspaceMain + Coordination
多 runnable Work 时 Scheduler Admit Coordination
```

用户已经明确治理方向：Agent 内部组织动作全部通过 typed tool calling；`Work` 承担
类似 Codex Goal 的持久目标；计划是 Agent 可维护的工作清单；不应存在一种特殊的
`Coordination` Agent/Loop 模式。

两者直接冲突。Coding Agent 无权用实现静默推翻 frozen System Design / DID，因此
受影响实现必须先停在治理边界。

## 所需治理决定

唯一提案：

```text
C:/Arbor/planning/proposals/execution-episode-goal-plan-convergence-decision-draft.md
```

它必须明确：

1. 用 exact `ExecutionEpisodeBinding` 取代 `ExecutionFocus`；
2. Conversation、Work、Inbox、Decision 分别绑定自己的 durable ref；
3. 删除 `CoordinationCompleted` / 泛化 `QueryCompleted`；
4. 多 runnable Work 的语义选择如何形成 exact-bound Decision episode；
5. Work 作为 Goal contract，Plan/Todo 作为非权威、工具维护的工作状态；
6. 历史 `coordination` 行如何 forward-only 迁移和 fail-closed；
7. Agent Loop、Context Compiler 和 Tool Runtime 如何保持统一而不按“模式”分叉。

## 禁止事项

- 不把 `Coordination` 简单改名为 `Input`、`General`、`Orchestration` 等新兜底桶；
- 不用 prompt 文案隔离 Context；
- 不根据“没有 workId”反推 episode 类型；
- 不让 Todo/Plan 成为第二套 Work lifecycle 或绕过 Verification/Acceptance；
- 不修改 `docs/design/**`，直到人工治理接受并在 owning docs 落字；
- 不删除无法精确归类的历史 Execution；必须保留审计并 fail-closed。

## 关闭条件

1. 人工治理接受替代 ADT、settlement 和迁移合同；
2. owning design documents 完成 supersession；
3. 新 Execution 不再写入 `focus_kind=coordination`；
4. Agent Runtime 中不存在 `Coordination` purpose/mode/context branch；
5. Conversation/Work/Decision/Inbox 黑盒均证明 exact context 与 exact tools；
6. 历史 ambiguous Coordination 不会被猜测恢复；
7. 全仓检查与真实 Provider 资格测试通过。

## Resolution

- 人工治理于 2026-10-03 接受
  `ACCEPT_EXECUTION_EPISODE_GOAL_PLAN_CONVERGENCE`；
- System Design v1.6 冻结 EGP-1…EGP-10；
- DID v1.28 冻结 exact EpisodeBinding、Plan boundary、migration 0024 与
  Waves A–E 授权；
- P2/P3/P14 phase indexes 已记录 supersession；
- implementation evidence 由后续 Wave result 记录，本 gap 不再阻塞实施。
