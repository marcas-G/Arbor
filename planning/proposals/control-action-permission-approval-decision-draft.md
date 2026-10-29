# Control Action Permission & Approval Architecture — 治理决策草案

**Date:** 2026-10-03
**Gap:** `CAPA-DG-01`
**Status:** DRAFT / AWAITING MANUAL ACCEPTANCE

## 1. 决策目标

采用与 Codex 相同的核心分离思想，但保持 Arbor 自己的领域语义：

```text
模型提出动作
→ Runtime 绑定 exact action intent
→ Permission / structural authority 决策
→ Approval policy 决策
→ Allow | Deny | InterruptForApproval
→ 允许后才进入 CommandGateway / ToolRuntime
```

Sandbox/ResourceBoundary 继续限制实际工具副作用；Approval 不扩大 Sandbox，
Sandbox 也不替代 Approval。

## 2. PermissionGrant v2

现有 Grant 必须增加明确 subject 和有效期：

```ts
type PermissionSubject =
  | { _tag: "HumanPrincipal"; principal: Principal }
  | { _tag: "WorkspaceAgent"; workspaceId: WorkspaceId }
  | { _tag: "Execution"; executionId: ExecutionId }

interface PermissionGrantV2 {
  permissionGrantId: PermissionGrantId
  projectId: ProjectId
  subject: PermissionSubject
  capability: string              // stable control id or wildcard family
  target: Project | Workspace | Work | ResourceRegion
  validFrom: Instant
  expiresAt: Instant | null
  issuer: Principal
  state: Active | Revoked
  revision: Revision
}
```

Resolver 必须同时匹配 subject、capability、target、state 和时间；不存在“项目里有一条
grant，所有 Agent 都能用”的解释。

## 3. ControlActionAuthorityResolver

新增 data-in / decision-out 的纯 Resolver：

```ts
ControlActionDecision =
  | Authorized { authorityFact, grantRef, actionDigest, controlBasisDigest }
  | ApprovalRequired { request }
  | Denied { reason }
```

输入至少包含：

- authenticated principal；
- exact Execution / Workspace / optional Work binding；
- AgentAction stable identity + canonical arguments digest；
- target facts；
- active subject-bound grants；
- structural parent/child governance facts；
- Workspace/Project policy；
- current ControlBasis and time。

Control handler 不再自行构造 `AssignWorkAuthority` 等事实；它只消费 Resolver 返回的
exact authority。

## 4. Approval policy

Project/Workspace policy 对每类 Control Action 选择：

```text
Deny                // 永不执行
Ask                 // 每个 exact action 进入人工审批
AllowWithinGrant    // subject-bound grant + scope 命中时自动执行
```

建议默认：

| Action | Default |
|---|---|
| update_plan / wait / claim_completion | AllowWithinGrant（当前 Work exact-bound） |
| propose_workspace | Allow proposal；Workspace 创建仍由 Formation RecordDecision |
| assign_work / spawn_specialist | Ask |
| send_message | AllowWithinGrant for structural target；其他 Ask/Deny |
| executable side effects | 继续由 ToolRuntime authority + approval + Sandbox 决定 |

## 5. Durable approval interruption

ApprovalRequired 必须：

1. 持久化 exact action digest、target、ControlBasis、requesting Execution、expiry；
2. 写入人类 Queue；
3. 将当前 AgentLoopStep 标记为等待审批，不执行 handler；
4. 人类 Approve/Reject 后恢复**同一个 Execution / AgentLoopStep**；
5. 恢复时重新校验 grant、target、revision、ControlBasis 和 expiry；
6. approval 单次消费；crash/replay 不重复执行；
7. Reject 作为 typed ControlResult 返回模型，不伪装异常。

不得通过新 HumanMessage、新 Execution 或重新让模型猜一遍参数恢复。

## 6. RootConversation Work initiation

`RGI-DG-01` 在本架构之后处理：

- `assign_work` 可以对模型可见；
- 默认 policy = Ask；
- 用户自然语言是目标输入，不自动等于对模型生成的完整 Work payload 审批；
- Queue 展示 objective、constraints、completion expectation、verification mission、
  target 和权限依据；
- 用户批准 exact payload 后，从同一 ConversationResponseEpisode 恢复并提交 Work。

管理员可为可信 WorkspaceAgent 配置 `AllowWithinGrant`，获得类似 Codex
workspace-write + on-request/never 的不同自治等级，但组织策略可禁止最宽模式。

## 7. 迁移与兼容

- 旧 PermissionGrant 无 subject，不能自动解释成全局 grant；迁移为 inactive legacy
  record，要求人工重新绑定 subject；
- 已暴露 Control Actions 分批迁移到 Resolver；未迁移 Action fail closed；
- ToolRuntime InvocationApproval 保留，Control approval 不与 executable approval
  混成一个含糊表，但共享 interruption/resume 基础设施；
- 审计记录必须能关联 ProviderTurn/callRef → AgentAction → permission/approval →
  Command/Event/settlement。

## 8. 验收门

1. 无 subject 的 grant 不能授权任何新动作；
2. 错 subject、错 target、过期、撤销均 Deny；
3. Ask 在 handler 前暂停，canonical state 无变化；
4. Approve 从同一 Step 恢复且只执行一次；
5. Reject 成为模型可用信息；
6. stale basis 审批后仍 fail closed；
7. Sandbox/ResourceBoundary 不因审批扩大；
8. Root `assign_work` 默认需要审批；
9. restart / concurrent approval / replay / expiry tests 全绿；
10. 真实 Provider 与完整 `pnpm check` 通过。

## 9. Owning contract updates

```text
docs/design/02-system-design.md
docs/design/03-detailed-implementation-design.md
docs/design/implementation/P12/**
docs/design/implementation/P17-conversation-delivery-runtime/**
docs/design/implementation/P3/08-agent-loop-step-handoff.md
```

## 10. 接受令牌

```text
ACCEPT_CONTROL_ACTION_PERMISSION_APPROVAL_ARCHITECTURE
```
