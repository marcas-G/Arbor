# Root Conversation Action Capability — 治理决策草案

**Date:** 2026-10-03
**Gap:** `CRAC-DG-01`
**Status:** DRAFT / AWAITING MANUAL ACCEPTANCE

## 1. 问题

根工作区对话被实现为纯文本客服面。用户说“创建子工作区”时，模型看不到 Arbor
已有的 `propose_workspace`，于是把请求误解成外部 SaaS 操作并索取无关参数。

## 2. 决策

采用统一的 `RootConversation` TurnProfile，不预先分类“聊天”还是“动作”：

```text
RootConversation
├─ context: exact HumanMessage history + current Workspace responsibility/boundary
├─ executable tools: none
├─ control tools: conversation-safe allowlist
│  └─ propose_workspace
└─ output: text or typed control invocation
```

`RootConversationRespond` 名称被 `RootConversation` supersede，因为一次对话 Episode
可以先调用安全控制工具，再输出最终回复；它仍使用同一个 Agent Loop，不产生新的
Agent 模式。

## 3. 安全边界

`propose_workspace` 的可见性不等于创建权限：

```text
model tool call
→ provider-neutral ToolInvocation
→ ControlToolRegistry decode
→ AgentAction.ProposeChildWorkspace
→ Runtime authority/freshness checks
→ Pending FormationProposal
→ human RecordDecision
→ approved Formation consumer
→ child Workspace created
```

任何一步失败都作为 typed Observation 回到 Loop；Prompt 文本不承担权限约束。

根对话继续禁止：

- filesystem / shell / patch / read / list；
- `claim_completion`、`update_plan` 等 Work-only control；
- verifier controls；
- `spawn_specialist` 和跨 Workspace `send_message`（本决策不授权）。

## 4. 缺参行为

模型必须优先使用当前 Workspace Context，不要求用户重复提供父 Workspace ID。

若无法形成合法 proposal，只询问尚缺的最小语义：

- 子工作区名称；
- 长期责任/用途；
- 只有当前边界无法推导时才询问资源范围。

禁止询问 Notion、Slack、GitHub、Azure DevOps 等无关平台，也禁止虚构“逻辑创建”。

## 5. Settlement

- 纯文本回复：`ConversationResponseProduced(messageId)`；
- 工具调用：记录 ControlResult/Observation，继续同一 ConversationResponseEpisode；
- 随后的最终文本仍以 `ConversationResponseProduced(messageId)` 结算；
- Pending FormationProposal 不代表 Workspace 已创建。

## 6. 合同修订

接受后需要人工治理更新：

```text
docs/design/02-system-design.md
docs/design/03-detailed-implementation-design.md
docs/design/implementation/P17-conversation-delivery-runtime/04-turn-profile-resolver.md
docs/design/implementation/P17-conversation-delivery-runtime/07-acceptance.md
docs/design/implementation/P14/02-conversation-execution.md
```

P17 C15 修订为：

```text
RootConversation manifest has zero executable tools and only the frozen
conversation-safe control allowlist.
```

## 7. 实施波次

1. TurnProfile contract + resolver allowlist；
2. Root Conversation tool/text loop tests；
3. black-box：你好、缺参创建、完整提案、拒绝/审批等待；
4. real-provider qualification；
5. full `pnpm check` 与结果记录。

## 8. 接受令牌

```text
ACCEPT_ROOT_CONVERSATION_ACTION_CAPABILITY
```
