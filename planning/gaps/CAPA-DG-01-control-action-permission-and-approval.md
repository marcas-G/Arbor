# CAPA-DG-01 — Control Action 缺少统一权限、审批与恢复边界

## 状态

**RESOLVED / IMPLEMENTED — System Design v1.8 / DID v1.30**

## 触发证据

在准备把 `assign_work` 暴露给 RootConversation 时发现：

1. 当前 Control Action handler 直接构造 `VerifiedCommandAuthority`，没有调用
   production `AuthorityResolverPort`；
2. `PermissionGrant` 只有 `scope / issuer / lifetime / state`，没有 grantee/subject，
   `matchGrant` 也不按调用者匹配；同 Project 的匹配 grant 可能被任意 Agent
   principal 使用；
3. `lifetime` 只是字符串，`activeGrants` 只按 state 过滤，没有可机械执行的
   validFrom/expiresAt；
4. P4 `InvocationApproval` 只覆盖 executable ToolRuntime，Control Action 没有
   ApprovalRequired → durable interruption → same-Episode resume 路径；
5. DID 仍把 approval production 标为 deferred。

因此，“工具可见”目前可能直接变成“handler 自行声明有权执行”。结构父子检查只能
限制目标范围，不能替代权限和审批。

## Codex / OpenAI 官方设计依据

- Codex 将 `approval_policy` 与 `sandbox_mode` 分开配置；审批决定何时暂停询问，
  sandbox 决定文件系统与网络边界；权限 profile 可复用：
  https://learn.chatgpt.com/docs/config-file/config-basic
- OpenAI Agent 审批生命周期是：记录 interruption，不执行工具；返回可恢复 state；
  应用批准/拒绝；从同一 state 恢复，而不是制造新用户轮次：
  https://developers.openai.com/api/docs/guides/agents/guardrails-approvals
- Tool annotations 只是提示，服务器仍必须执行自身授权：
  https://developers.openai.com/plugins/reference#annotations

## 所需设计闭合

Arbor 需要把 Control Action 分成三个独立问题：

```text
Visible?      TurnProfile / purpose / readiness
Authorized?   subject-bound PermissionGrant + structural governance + policy
Executable?   risk/approval decision + exact action digest + current ControlBasis
```

缺一不可。Prompt 和 tool description 均不能授予权限。

## 阻塞范围

- `assign_work` 已实现内部 codec/handler，但从所有模型 profile 隐藏；
- RootConversation Work initiation 被阻塞；
- 后续 `ProduceDeliverable / Deliver / AcceptWorkOutcome` 等 Action 也不得在该边界
  闭合前新增模型暴露；
- 已暴露 Control Actions 需要在实施期逐一迁移，不能长期保留 authority synthesis。

## 提案

`planning/proposals/control-action-permission-approval-decision-draft.md`

## Resolution

- 人工治理接受 `ACCEPT_CONTROL_ACTION_PERMISSION_APPROVAL_ARCHITECTURE`；
- 接受草案 SHA-256：
  `74C0A20BCED0C7800B2EB21933967810AAB73423132D9FE06E86A7E56EA26FB9`；
- System Design v1.8 / DID v1.30 / P12/P17/P3 owning contracts 已落字；
- migrations 0029/0030、PermissionGrant v2、ControlActionAuthorizer、
  ResolveControlApproval、same-Execution resume 与 Queue UI 已实现；
- 证据记录：
  `planning/results/control-action-permission-approval.result.md`。
