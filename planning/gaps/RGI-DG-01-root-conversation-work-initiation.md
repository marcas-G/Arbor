# RGI-DG-01 — 用户目标缺少自动归属与启动闭环

## 状态

**RESOLVED AT DESIGN — absorbed into accepted MAC-P1/MAC-P2; do not implement independently**

## 触发证据

用户只应描述目标，不应先理解 Arbor 的 `Workspace / Work / Execution` 再决定：

```text
这个目标应在根 Workspace 做？
应交给已有子 Workspace？
还是应创建新的长期责任 Workspace？
```

当前设计没有把这项判断闭环：

1. DID v1.29 的 `RootConversation` 只暴露 `propose_workspace`，不能建立正式
   `Work`；
2. `prompt:root-conversation:governed-action:v3` 要求子 Workspace 的名称和长期责任
   必须由用户显式提供，并禁止 Agent 提议这些值；
3. 原 RGI 草案准备增加 `assign_work`，但把 target 固定为根 Workspace，仍不能把
   目标交给已有的合适 Direct Child；
4. 因此模型不能完成“检查现有组织 → 判断归属 → 选择当前/已有子节点/新子节点 →
   启动工作”的完整链路，只能把组织结构问题重新抛给用户；
5. Formation 的治理状态只有 `Pending/Approved/Rejected`。`Approved` 后真正的
   `CreateChildWorkspace → AssignWork` 由异步 consumer 执行，但没有面向产品的
   fulfillment 状态来区分“已批准”“已创建 child”“首个 Work 已分配”。

这不是单纯的 UI 或提示词缺陷。它涉及 RootConversation 的上下文、控制面 allowlist、
模型判断边界、Runtime target 绑定、Formation 人工治理和 Scheduler 接续，属于冻结设计
语义。

## 已存在但尚未接通的能力

- P6 `ChildWorkspaceProposal.initialWork` 已存在；
- Formation approval 后的 Application consumer 已支持确定性地执行
  `CreateChildWorkspace → AssignWork`；
- `assign_work` control、CAPA 的 Ask/AllowWithinGrant、same-Execution approval resume
  已实现；
- P6 已冻结 Direct Parent 治理、Capability Ceiling 和 ResourceBoundary 子集约束。

所以缺口不是“再实现一套 Workspace 创建流程”，而是让 RootConversation 能够基于
canonical 组织事实做正确的 **Goal Placement**，并复用已有两条控制链。

## 推荐治理方向

### 1. 用户只表达目标，Agent 负责工作归属判断

RootConversation 根据目标与受限的 canonical 组织快照，选择：

```text
普通问答                         → text
当前根职责内的有界成果           → assign_work(current)
已有 Direct Child 的职责最匹配   → assign_work(existing child)
出现新的长期、可复用、独立责任   → propose_workspace(initialWork)
```

`Goal Placement` 是模型判断，不新增持久化领域实体，也不新增一个让用户填写的
“选择 Workspace”步骤。用户可以显式指定目标节点或禁止新建；否则由 Agent 判断。

### 2. 给模型最小、权威的 Placement Context

Model Context 只增加 Runtime 编译的 `WorkspacePlacementContext`：

- 当前根 Workspace 的名称、责任、状态和资源边界摘要；
- Active Direct Children 的稳定 ref、名称、责任、状态和当前 Work 摘要；数量超过
  context budget 时提供确定性 cursor，而不是静默截断；
- Root 第一层尚未终结的 FormationProposal 及 fulfillment 摘要，避免批准/应用期间重复
  提出同一责任；
- parent 可治理范围和不可放宽的 hard constraints；
- 不包含任意子树 Session、隐藏 ID、工具日志或模型自行推断的权限。

快照必须带 revision/fingerprint。Runtime 执行动作时重新读取 canonical facts，拒绝
stale/越权/Retired/非 Direct Child target；模型文本不能授予权限。

大树使用 Root-safe 的只读 inspection tools `list_workspaces` / `read_workspace` 渐进加载
Direct Children、在途 Formation 和 Open Work 摘要。它们只能读取 canonical 组织事实，
不能读取 Session、文件或任意后代，不产生 mutation，也不需要 human approval。

### 3. 两条现有控制链共同完成闭环

```text
assign_work
  target = current | listed direct child ref
  → CAPA authorization/approval
  → AssignWork / WorkAssigned
  → Scheduler / WorkEpisode

propose_workspace
  proposal = name + long-lived responsibility + boundary + rationale + initialWork
  → exact Formation approval
  → CreateChildWorkspace
  → AssignWork(initialWork)
  → Scheduler / WorkEpisode
```

对于一个具体目标，若选择新建 Workspace，`initialWork` 必须存在；只有“建立一个长期
责任但暂时没有首项工作”这类显式请求才允许省略。

### 4. Agent 可以提出名称和责任，Human 决定是否生效

撤销 v3 prompt 中“不得提出名称/责任”的限制。Agent 可以根据用户目标生成建议，但：

- proposal 必须说明为什么当前根和已有 Direct Children 不适合；
- “任务很大/很复杂”本身不足以新建 Workspace；
- 建议名称、责任、ResourceBoundary、initialWork 和 permission posture 都进入 exact
  proposal preview；
- Root 第一层 Workspace 仍必须由 Human approve/modify/reject；
- proposal 永远不等于创建，未批准不能产生 Workspace 或 Work。

用户批准的是可读的组织变化与权限边界，而不是被要求理解内部架构后替 Agent 选路。

### 5. 判断标准

只有同时存在足够证据时才建议新 Workspace：

- 职责会长期存在并反复产生多个 Work；
- 需要独立所有权、上下文、资源边界或治理边界；
- 能形成稳定、可命名的责任，而不是一次性步骤；
- 独立并行的收益大于协调成本；
- 当前根和已有 Direct Child 都不自然承接。

一次性成果、串行步骤、短期分析或仅仅“比较复杂”，默认作为当前/已有 Workspace 的
Work，不创建新节点。

## 安全与权限边界

- Workspace 创建时确定 Responsibility、ResourceBoundary 和由 parent ceiling 收紧后的
  effective capability ceiling；
- Formation approval 不自动产生未展示的 standing PermissionGrant；敏感 control 没有
  exact grant 时继续走 CAPA `Ask`；
- `assign_work(existing child)` 只能指向 context 中列出的 Active Direct Child；
- RootConversation 始终没有文件、shell、网络等 executable tools；真正执行只发生在
  后续 WorkEpisode；
- 用户的禁止项（例如“不要下单”）必须逐字进入 initial/current Work constraints，不能
  被 placement 判断弱化。

## 恢复与闭环要求

- proposal/approval/replay 使用确定性 identity，不重复建 Workspace 或 Work；
- approve/modify 后复用 P6 consumer，失败可恢复，不把半创建状态报告成成功；
- Formation 必须有由 canonical events + deterministic derived IDs 投影出的 fulfillment
  状态：`AwaitingDecision | PendingApplication | WorkspaceCreated | Applied | Blocked`；
- `Approved` 只是允许后台应用，不等于 `Applied`，更不等于 Work 已开始或完成；
- rejection、Applied 或 Blocked 通过 durable wake marker 触发同一根会话的 successor
  ConversationResponseEpisode；不得复活已经 settled 的旧 Execution；
- rejection 后 Agent 解释结果，不自动退化为在根节点创建 Work；
- WorkAssigned 只说明“已建立并等待/开始调度”，不得声称任务完成；
- ConversationResponseEpisode settle 后 Scheduler 才 admission 同 Workspace 的主
  WorkEpisode，保持 one-active-main invariant。

## 提案

`planning/proposals/root-conversation-work-initiation-decision-draft.md`
