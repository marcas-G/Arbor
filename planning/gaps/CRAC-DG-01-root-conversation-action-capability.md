# CRAC-DG-01 — 根对话被错误限制为纯文本，无法执行 Arbor 组织动作

## 状态

**RESOLVED / IMPLEMENTATION AUTHORIZED — System Design v1.7 / DID v1.29**

## 触发场景

2026-10-03，用户在根工作区对话中输入：

```text
创建子工作区
```

实际回复把 Arbor 当成未知外部平台，要求用户补充 Notion、Slack、GitHub、
Azure DevOps 等平台信息，以及父工作区 ID、成员、权限和继承设置。

这不是模型能力不足。当前冻结 `RootConversationRespond` TurnProfile 明确暴露：

```text
Executable tools = []
Control tools    = []
Output           = text only
```

因此模型虽然已经收到当前 Workspace 的责任和资源边界 Context，却看不到
`propose_workspace`，无法知道“子工作区”是 Arbor 内部受治理的组织动作，只能生成
通用咨询式回答。

## 设计冲突

现有冻结合同：

- P17 `04` §5：`RootConversationRespond | none | none | text final answer`；
- P17 `07` C15：根对话 Manifest 必须为 zero tools；
- 当前实现据此在 `TurnProfileResolver` 中清空全部 control tools。

但已冻结的 Agent Control Runtime 同时定义：

- `propose_workspace` 只写入 Pending FormationProposal；
- 它不会直接创建 Workspace；
- 后续必须经过人类 `RecordDecision(Approve/Reject/Modify)`；
- Formation consumer 才拥有批准后的创建权。

因此“根对话不能看到任何控制工具”与“用户通过自然语言操作 Arbor”发生直接冲突。
Coding Agent 不能静默推翻 C15，因此停止在治理边界。

## 推荐治理方向

不要增加意图分类器，也不要先让模型判断自己处于什么模式。根对话始终使用一个
明确的 `RootConversation` profile：

```text
Executable tools = []
Control tools    = conversation-safe allowlist
Output           = text or typed control invocation
```

第一版 allowlist 只包含：

```text
propose_workspace
```

它满足以下边界：

1. 模型可根据用户自然语言选择“回答”或“提出子工作区提案”；
2. 工具可见性不授予创建权，现有 Runtime authority/freshness/handler 检查保持；
3. 工具调用只形成 Pending proposal，人类审批仍是硬门；
4. 根对话继续禁止 read/list/patch/shell 等 executable tools；
5. ConversationResponseEpisode 保持 exact message binding；
6. 工具 Observation 回到同一 Agent Loop，模型再生成面向用户的最终说明；
7. 缺少必要字段时，只询问 Arbor 内部必要信息，不询问外部平台。

对于本次输入，合理回复应接近：

```text
可以。子工作区叫什么，主要负责什么？
如果沿用当前工作区的资源范围，我会先生成一份待你审批的创建提案。
```

## 不采用的方案

- **关键词/意图路由器**：需要第二套语义分类，仍可能把自然语言误分到错误 Loop；
- **暴露全部工具**：会让普通对话获得 Work/executable 工具面，扩大能力与 Context；
- **仅修改 Prompt**：只能让模型少问问题，仍然无法执行；
- **直接创建 Workspace**：绕过 FormationProposal 和人类治理门。

## 关闭条件

1. System Design / DID 明确 Root Conversation 的 conversation-safe control 边界；
2. P17 C15 从“zero tools”修订为“zero executable tools + bounded safe controls”；
3. `RootConversation` 只暴露 `propose_workspace`；
4. 无足够信息时只提出最小必要澄清；
5. 信息充分时形成 Pending proposal，并在最终回复中说明等待人工审批；
6. 普通“你好”仍然纯文本回答，不产生工具调用；
7. 黑盒、restart、真实 Provider 和 `pnpm check` 全绿。

## 提案

`planning/proposals/root-conversation-action-capability-decision-draft.md`

## Resolution

- 人工治理于 2026-10-03 接受
  `ACCEPT_ROOT_CONVERSATION_ACTION_CAPABILITY`；
- System Design v1.7 冻结 CRAC-1…CRAC-5；
- DID v1.29 与 P17/P14 owning contracts 记录
  `RootConversation + propose_workspace-only` 边界；
- 接受草案 SHA-256：
  `DEBD13AAB34B7556B221F12B647360E945F95F5D89BD0B03287963DB22B917A8`；
- 实施与验证证据记录在
  `planning/results/CRAC-root-conversation-action-capability.result.md`。
