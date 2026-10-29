# Root Goal Placement & Work Initiation — 治理决策草案

**Date:** 2026-10-03
**Gap:** `RGI-DG-01`
**Status:** SUPERSEDED AS AN INDEPENDENT PROPOSAL — absorbed into MAC-DG-01 M1/M3
**Supersedes:** 本文件早期“Root assign_work 仅固定到根 Workspace”的未接受草案

## 1. 决策目标

用户只描述想达到的结果。Arbor 的 Root Agent 负责判断该目标应该：

1. 留在当前根 Workspace；
2. 分配给已有 Active Direct Child；
3. 提议创建新的长期责任 Workspace，并携带首个 Work。

用户不需要先理解 `Workspace / Work / Execution`，也不需要回答抽象的“是否独立一个
Workspace”。只有创建长期责任实体、修改组织结构或执行敏感 control 时，用户才审批
具体、可读、可修改的方案。

## 2. 不新增第三套编排抽象

`Goal Placement` 是同一 ProviderTurn 中的模型判断，不是新的 durable entity、
Command、ExecutionEpisode 类型或“Coordination”层。它通过现有输出分支表达：

```text
RootConversation
├─ text
├─ list_workspaces / read_workspace
├─ assign_work(current | direct-child-ref)
└─ propose_workspace(proposal with initialWork)
```

Runtime 仍只处理拆开的 typed control invocation；模型的解释文本不产生 canonical
effect。

## 3. WorkspacePlacementContext

Model Context Runtime 为 `RootConversation` 编译一个独立、版本化、受预算约束的
`WorkspacePlacementContext`：

```ts
interface WorkspacePlacementContext {
  readonly root: {
    readonly ref: "current";
    readonly name: string;
    readonly responsibilitySummary: string;
    readonly status: "Active" | "Retired";
    readonly resourceBoundarySummary: string;
    readonly currentWorkSummary?: string;
    readonly openWorkCount: number;
    readonly revision: number;
  };
  readonly directChildren: ReadonlyArray<{
    readonly ref: string; // Runtime-issued opaque ref; not a UI-facing raw ID
    readonly name: string;
    readonly responsibilitySummary: string;
    readonly status: "Active" | "Retired";
    readonly currentWorkSummary?: string;
    readonly openWorkCount: number;
    readonly revision: number;
  }>;
  readonly inFlightFormations: ReadonlyArray<{
    readonly proposalRef: string;
    readonly proposedName: string;
    readonly responsibilitySummary: string;
    readonly initialWorkSummary?: string;
    readonly governanceState: "Pending" | "Approved";
    readonly fulfillmentState:
      | "AwaitingDecision"
      | "PendingApplication"
      | "WorkspaceCreated"
      | "Blocked";
    readonly revision: number;
  }>;
  readonly hardConstraints: ReadonlyArray<string>;
  readonly nextCursor?: string;
  readonly snapshotFingerprint: string;
}
```

约束：

- 来源仅为 canonical Project/Workspace/Work/Formation/ResourceBoundary/Policy facts；
- 只列 current root 与 Direct Children，不泄露任意后代 Session；
- 列出该 root 下尚未 Rejected/Applied 的 Formation，防止异步窗口内重复 proposal；
- `ref` 仅供本次 control invocation 使用，Runtime 解析后绑定 exact WorkspaceId；
- 不允许静默截断；超出 context budget 时必须给出 deterministic `nextCursor`；
- 执行前重新验证 fingerprint/revision、Direct Parent、Active 状态和 authority；
- stale snapshot 返回 typed model-usable observation，允许同一 Episode 重新决策。

### 3.1 大树的渐进读取

RootConversation 增加两个只读 inspection tools：

```text
list_workspaces(cursor?, query?)
  → current root 的 Active Direct Children 与 in-flight Formation 摘要页 + nextCursor

read_workspace(ref, workCursor?)
  → current root 或一个已列出 Direct Child 的责任、状态、边界和 Open Work 摘要页
```

二者通过内部 query boundary 返回 typed observation：

- 不是 P4 文件/网络 executable tool；
- 无 canonical mutation，属于 intrinsic read-only authorization，不触发 human approval；
- scope 固定为 current root 与其 Direct Children；
- 不返回 Session transcript、工具日志、Secret、任意后代或原始数据库字段；
- cursor 与 ref 绑定 project/root/snapshot generation，跨 scope 或过期时 fail closed；
- `query` 只做确定性的名称/责任字段过滤，不由 query 工具替模型决定归属。

模型在初始摘要不足时自行分页或读取候选节点，不得因为 context 截断就误判“没有合适
Workspace”并创建重复责任。

如果 in-flight Formation 已覆盖目标，Agent 说明其真实状态并等待/引导处理现有提案，
不得创建第二个 proposal。如果候选 Workspace 可能已有相同 Open Work，Agent 先用
`read_workspace` 检查；除非用户明确要求独立重复研究，否则不得重复 `assign_work`。

## 4. Placement 判断规则

Prompt Program 升级为版本化的新 revision，并要求按以下顺序判断：

### 4.1 已有节点优先

- 用户显式指定 current/某个已有子 Workspace 时，在不越权的前提下遵循；
- 未指定时，先比较 current root 与已有 Direct Children 的责任；
- 先排除 in-flight Formation 或现有 Open Work 已覆盖同一目标的情况；
- 能由现有责任自然承接时，使用 `assign_work`，不创建新节点。

### 4.2 新 Workspace 只承载长期责任

建议新 Workspace 必须给出可审查 rationale，至少覆盖：

- 是否长期、可复用并会产生多个 Work；
- 是否需要独立所有权、上下文、资源或治理边界；
- 是否可形成稳定、可命名的责任；
- 并行收益是否超过协调成本；
- 为什么 current root 和已有 Direct Children 都不适合。

“大、复杂、步骤多”不能单独构成 formation 理由。

### 4.3 不把架构问题抛给用户

Agent 不得询问“你想创建 Workspace 还是 Work”。只有缺失的信息会实质改变目标、硬
约束、验收标准或组织边界时，才询问最小必要问题。

## 5. `assign_work` 的 Root 行为

RootConversation 增加 `assign_work` control，但 target 不再固定为 root：

```text
target = current | WorkspacePlacementContext 中的 Active Direct Child ref
```

Runtime 绑定并强制：

- current root 或 exact Active Direct Child；
- same Project、direct parent、fresh revision；
- predecessorWorkId = null（Root Conversation 不绑定父 Work）；
- Work/Command ID、principal、authority、target WorkspaceId 全部由 Runtime 生成；
- model 只提供 objective、why、constraints、completionExpectation、完整
  VerificationMission 和 bounded provenance reason；
- CAPA 默认 `Ask`，exact standing grant 才能 `AllowWithinGrant`；
- 用户明确禁止项必须原样保存在 constraints。

成功后返回 typed WorkAssigned observation。对话只能说明 Work 已创建并交由 Scheduler，
不能宣称结果已经完成。

## 6. `propose_workspace` 的 Root 行为

撤销 CRAC v3 prompt 对“名称和责任必须由用户逐字段提供、Agent 不得提出建议”的限制。
新规则是：

- Agent 可以从明确的长期目标提出 child name 与 responsibilityDraft；
- proposal 必须带对现有候选节点的比较理由；
- 具体用户目标触发 formation 时，`initialWork` 必填，并携带完整
  VerificationMission；
- 只有用户显式要求建立一个暂不启动工作的长期责任时，`initialWork` 才可省略；
- resourceBoundaryDraft 必须是 parent 有效边界的子集；
- proposal preview 必须展示责任、资源边界、initialWork、约束和权限姿态：
  effective capability ceiling 只会收紧；未展示的 standing grant 不会自动产生；敏感
  control 默认继续 Ask。

Root 第一层 proposal 仍走 exact revision 的 Human approve/modify/reject。批准后复用已
存在的 P6 链路：

```text
RecordDecision(approve | modify)
→ deterministic formation consumer
→ CreateChildWorkspace
→ AssignWork(initialWork)
→ Scheduler reevaluation
→ WorkEpisode
```

不新增另一套 Workspace 创建机制。

## 7. 生命周期与恢复

### 7.1 当前/已有 Workspace

```text
HumanMessage
→ ConversationResponseEpisode
→ WorkspacePlacementContext
→ assign_work
→ CAPA authorization/approval
→ WorkAssigned observation
→ conversation final text + settlement
→ Scheduler
→ WorkEpisode
```

### 7.2 新 Workspace

```text
HumanMessage
→ ConversationResponseEpisode
→ WorkspacePlacementContext
→ propose_workspace(initialWork)
→ Pending FormationProposal + Governance Inbox
→ proposing ConversationResponseEpisode settles
→ Human approve/modify/reject
→ approve/modify: PendingApplication
→ asynchronous formation consumer
→ CreateChildWorkspace
→ AssignWork(initialWork)
→ fulfillment = Applied
→ durable wake marker
→ same root conversation gets a successor ConversationResponseEpisode
→ Scheduler
→ child WorkEpisode
```

恢复与一致性要求：

- control/action/command 使用确定性 identity，crash/replay 不重复创建；
- Formation 的 WorkspaceCreated 与后续 initial Work 分配沿现有 P6 consumer 可重试；
- 不允许报告半完成的 formation 为成功；
- reject 后不得自动把相同目标改派到 root；
- ConversationResponseEpisode settlement 先于同 Workspace main WorkEpisode admission。

### 7.3 Formation fulfillment 是异步事实，不是同步返回值

治理决定与应用结果必须分开：

```text
Governance state:  Pending | Approved | Rejected
Fulfillment view:  AwaitingDecision
                 | PendingApplication
                 | WorkspaceCreated
                 | Applied
                 | Blocked(typed reason)
```

实现为 durable、可重建的 `FormationFulfillmentProjection`，不是新的领域命令：

```ts
interface FormationFulfillmentProjection {
  readonly proposalId: FormationProposalId;
  readonly proposalRevision: number;
  readonly expectedChildWorkspaceId: WorkspaceId;
  readonly expectedInitialWorkId?: WorkId;
  readonly state:
    | "AwaitingDecision"
    | "PendingApplication"
    | "WorkspaceCreated"
    | "Applied"
    | "Blocked";
  readonly typedBlock?: FormationApplicationBlock;
  readonly lastAttemptAt?: string;
  readonly revision: number;
}
```

`expected*Id` 必须复用 formation plan 的 deterministic ID derivation。projection 可以从
proposal/decision 与 canonical WorkspaceCreated/WorkAssigned events 重建；consumer 只在
收到 non-retryable typed receipt 时记录 `typedBlock`，日志字符串不具备状态权威。

- `Approved + PendingApplication`：已经授权，但后台 consumer 尚未完成；
- `WorkspaceCreated`：child 已 canonical 创建；若 proposal 有 initialWork，仍不能声称
  已闭环；
- `Applied`：child 已创建，并且 required initialWork 的 `WorkAssigned` 已存在；
- `Blocked`：确定性前置条件或恢复上限阻止继续，携带 typed、可展示、可处理的原因；
- 没有 initialWork 的显式 formation，在 WorkspaceCreated 后即可投影为 Applied；
- fulfillment 优先由 canonical `WorkspaceCreated` / `WorkAssigned` 和 proposal revision
  的 deterministic derived IDs 投影，不能依赖内存回调或日志文本；
- retryable persistence/worker 暂不可用保持 PendingApplication 并记录尝试信息，不把
  临时故障误判为终止失败。

旧的 proposing Episode 可以先 settle。后续 `Rejected / Applied / Blocked` 通过 durable
wake marker 进入同一个 root conversation delivery surface，创建 successor
ConversationResponseEpisode；不得复活 settled Execution，也不得假设人工审批与后台
consumer 同步完成。

## 8. 权限语义

创建 child 时确定的是长期责任边界：

```text
ChildEffective
  = ParentEffectiveCeiling
    ∩ responsibilityScope
    ∩ resourceBoundaryDraft
    ∩ effectiveConstraints
    ∩ workspacePolicy
```

Formation approval 不能偷偷扩大权限，也不能自动创建 proposal 中未展示的 standing
PermissionGrant。敏感 control 若没有 exact subject/capability/target/time-bound grant，
仍由 CAPA 产生 durable `ApprovalRequired`。因此“父创建子时分发权限”表现为：父级确定
并批准 child 的责任/资源/能力上限；额外免询问权限必须单独、明确、可撤销地授予。

## 9. 验收场景

1. “你好”只返回文本，不创建 Work/Workspace；
2. 一次性“检查后端类型错误”选择 current root 的 Work；
3. 已有“量化研究”Direct Child 时，“研究动量策略，不下单”分配给该 child，并保留
   “不下单”；
4. 没有合适 child，且用户要求长期负责量化研究/回测/风控时，Agent 提出“量化研究”
   Workspace，包含 rationale、边界与 initialWork，而不反问用户懂不懂 Workspace；
5. 仅因为任务复杂但责任不独立时，不创建 child；
6. formation 未批准前，不产生 Workspace/Work；批准后自动创建 child 并分配 initial
   Work，无需用户再次下令；
7. `Approved + PendingApplication` 不显示为“已创建”或“已开始”；只有 Applied 才报告
   formation 已落地；
8. create 已提交但 assign 尚未完成时投影 `WorkspaceCreated`，restart 后继续 exact
   initial Work，不重复 child；
9. proposal 被拒绝后不偷偷改派；
10. stale/ref 指向非 Direct Child/Retired child 时 fail closed，并返回 typed observation；
11. duplicate/restart 不产生第二个 Workspace 或 Work；
12. Direct Children 超出首屏 context budget 时，Agent 通过 deterministic cursor 查到后页
    的合适节点，不重复创建相同责任；
13. 同一责任处于 PendingApplication，或相同目标已经是 Open Work 时，不产生重复
    proposal/Work；
14. Root Conversation 只有上述 canonical inspection/control tools，没有文件、shell、网络
    executable tools；实际工作执行仍只在 WorkEpisode；
15. 真实 DeepSeek 场景矩阵稳定通过，并且 `pnpm check` 全绿。

## 10. Owning contract updates（接受后）

```text
docs/design/02-system-design.md
docs/design/03-detailed-implementation-design.md
docs/design/implementation/P17-conversation-delivery-runtime/04-turn-profile-resolver.md
docs/design/implementation/P17-conversation-delivery-runtime/07-acceptance.md
docs/design/implementation/P14/02-conversation-execution.md
docs/design/implementation/P6/01-formation-semantics.md
docs/design/implementation/P6/03-authority-delegation.md
docs/design/implementation/P6/05-prompt-programs.md
docs/design/implementation/P6/06-acceptance.md
docs/design/implementation/P6/07-formation-fulfillment.md  # new
```

## 11. 实施边界（接受后）

1. 先以失败测试冻结 Placement Context、target binding、formation fulfillment projection
   和 formation-with-initialWork 行为；
2. 修改版本化 prompt/context/TurnProfile，并实现 scoped `list_workspaces` /
   `read_workspace` query controls；
3. 复用 `assign_work`、CAPA、P6 formation consumer，不创建第二套 command path；
4. 增加机械测试、行为评估、restart/replay 和真实 provider 资格；
5. 不在本决策中新增任意深度跨树调度、自动 standing grants、AgentId 或新的 Episode
   类型。

## 12. 接受令牌

> **已失效。** 本独立提案已被 `MAC-DG-01` 的 M1/M3 吸收；旧令牌不得用于治理接受。

```text
ACCEPT_ROOT_GOAL_PLACEMENT_AND_WORK_INITIATION
```
