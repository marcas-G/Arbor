# Minimal Architecture Convergence — 治理决策草案

**Date:** 2026-10-03
**Gap:** `MAC-DG-01`
**Status:** DRAFT / AWAITING MANUAL ACCEPTANCE

## 1. 决策目的

停止以单个缺口为单位继续横向增加工具、状态机和表。先收敛出一条最小、真实、可恢复
的用户价值链，再按必要性恢复长期组织、跨 Work 协作和并行执行能力。

奥卡姆标准：一个概念只有在拥有不可由其他事实推导的 identity、lifecycle 或 invariant
时，才进入 Domain/Product vocabulary。仅为实现、恢复、传输或模型认知服务的状态保留
在 Runtime/Cognition 内部。

## 2. 最小词汇

### 2.1 用户与领域可见

```text
Project       长期工作的治理容器
Workspace     长期责任主体
Work          正式目标与完成合同
Artifact      可引用现实产物
Verification  独立质量判断
Acceptance    结果是否被责任上级/用户接受
Permission    能否执行某类动作
```

### 2.2 Workspace 内部认知

```text
LocalPlan            当前 Work 的可变工作参照
WorkspaceKnowledge   责任相关、可信、可重建的知识视图
Session              一个认知时间线/Provider continuity 载体
```

这些不是用户要编排的项目管理对象。LocalPlan 没有调度、授权、完成或验证能力。

### 2.3 Runtime 内部

```text
Execution / Episode
AgentLoopStep
ProviderTurn / ProviderAttempt
ActionCall / ActionResult
ToolInvocation
ResponseJob / Attempt
Inbox / Wake / ConsumerOffset
Lease / Fence
```

UI 可以显示诊断信息，但不得要求用户理解这些对象才能发起或完成普通工作。

## 3. Agent 定义

```text
Workspace = durable responsible identity
Agent     = Runtime 在一次 Execution 中扮演的认知执行角色
```

删除“长期 Agent entity”语言。长期连续性来自 Workspace、Responsibility、Knowledge、
Binding 和历史证据；没有 AgentId，也没有永久在线 Agent process。

## 4. Plan 决策

- `WorkPlan` 从 core Domain vocabulary 下沉为 Workspace Cognition / Agent Runtime record；
- 仍按 exact WorkId + WorkRevision 持久化，可跨 Execution 恢复；
- `update_plan` 仍是 Agent 自用工具；
- Runtime 不执行 PlanItem，不因 PlanItem 自动 spawn、schedule、verify 或 complete；
- Plan 不绑定 Workspace formation、Dependency、Specialist/subagent 或 ToolInvocation；
- UI 默认只作为可折叠的工作过程提示，不作为项目任务板。

## 5. 临时多 Agent 决策

移除 `Specialist` 作为一级 Domain/Product vocabulary：

```text
spawn_agent(...) → child Execution → AgentResult
```

- child Execution 是 Agent Runtime 的可选并行 action；
- 不创建 Workspace、Work、AgentId、长期 Memory 或独立 Acceptance；
- 不绑定 PlanItem；
- 结果只是 parent Agent 的 typed observation/evidence；
- v1 最小黄金路径不依赖 spawn_agent；
- 在单 Agent 路径稳定前，`spawn_specialist` 不扩展、不进入 Root Conversation；
- 后续若启用，必须先冻结 context brief、tool subset、exact wait/message/interrupt、result
  contract、concurrency/depth/resource-conflict policy。

历史 `SpecialistSpec/SpecialistSettled` 仅作为迁移兼容；新写路径采用 Runtime-owned
subagent vocabulary。

## 6. Action surface 决策

模型只理解统一的 tool/action call：

```text
Model ActionCall
→ exact registered action identity
→ visibility/applicability
→ authorization/approval
→ route
   ├─ ExternalExecutableHandler
   ├─ InternalControlHandler
   └─ SubagentHandler (optional, later)
→ typed ActionResult
```

“control”与“executable”继续是 Runtime route，不能成为两套模型协议或重复授权基础设施。

## 7. Approval 收敛

合并 `invocation_approvals` 与 `control_action_approvals` 的公共生命周期为一个 exact-intent
`ActionApproval` ledger：

```text
Pending | Approved | Rejected | Consumed | Expired
```

统一绑定：subject、action identity/version、normalized intent digest、target、ControlBasis、
expiry、single-consumption。Executable/control route 保留各自额外约束和执行 handler。

Standing `PermissionGrant` 保持独立：PermissionGrant 是可撤销的长期授权；ActionApproval
是一次 exact intent 的中断/恢复事实。

## 8. Workspace Knowledge 决策

v1 不引入开放式、自我提升的 Memory Aggregate。先实现最小、可信、可重建的
`WorkspaceKnowledgeView`：

- Responsibility/Boundary current facts；
- accepted Work outcome summaries；
- current Decisions；
- versioned Artifact references；
- unresolved risks/questions；
- provenance/trust metadata。

它优先由 canonical state、Acceptance、Decision、Artifact 和明确 ContextUpdate 投影，
不是把整个 Session 当作长期 Memory，也不允许模型文本凭“请永久记住”自动晋升。
现有 `MemoryId`/unprovisioned KnowledgeQueryPort 不得继续被算作已实现能力；要么落地该
最小 view，要么从完成声明中移除。

## 9. 第一黄金路径：single Workspace

第一阶段唯一完成目标：

```text
Human goal
→ RootConversation chooses text or assign_work(current Workspace)
→ Open Work
→ Scheduler admits WorkEpisode
→ Agent Loop uses LocalPlan + executable actions
→ ClaimCompletion
→ independent Verification
→ exact Acceptance
→ CompleteWork
→ user-visible final result
```

约束：

- 普通目标不要求用户选择 Workspace/Work/Execution；
- Root `assign_work` 默认 exact Ask approval；
- constraints 不得弱化用户禁止项；
- root Work 的最终 Acceptance 由 Human 或显式 policy；
- child Work 不在本阶段；
- 不依赖 Formation、Dependency/Deliverable、Message、subagent；
- crash/restart/replay 不重复 Work、response、verification、acceptance 或 completion；
- 真实 Provider 至少覆盖普通问答、创建 Work、一次工具失败修正、完成、Verification
  PASS/FAIL/UNKNOWN 和 restart。

## 10. 第二黄金路径：长期责任

第一阶段关闭后才进入：

```text
Goal placement
→ current / existing direct child / proposed child
→ exact Formation decision
→ durable Formation fulfillment
→ child initial Work
→ child result + Verification
→ Parent Agent accept_result
→ child Work completed
```

要求：

- Agent 判断是否需要 Workspace，用户只审批具体组织变化；
- Formation governance 与 application fulfillment 分离；
- Parent Acceptance 是模型可用的 scoped control，不要求 Human 接受每个普通 child
  result；
- WorkspacePlacementContext 防止重复 formation/work；
- first-layer human governance、resource/capability ceiling 保持。

## 11. 第三阶段：跨 Work 协作

只有完整闭合下列链路后才重新向模型暴露 `declare_dependency`：

```text
DeclareDependency
→ producer receives exact requirement
→ ProduceDeliverable
→ Deliver
→ deterministic match / SatisfyDependency
→ exact wake
→ consumer integrates result
```

在此之前，当前 command/table 可以保留兼容，但不能宣称 real-agent dependency workflow
完成，也不能让模型创建不可正常满足的 Dependency。

## 12. 第四阶段：可选 subagent parallelism

`spawn_agent/list_agents/message_agent/wait_agent/interrupt_agent` 只作为 WorkEpisode 的
运行时加速能力加入。它不影响单 Agent 正确性，也不改变 Workspace/Work/Verification
语义。

## 13. Async fulfillment rule

任何“决定/批准后由 consumer 异步应用”的流程必须拥有独立 durable fulfillment view：

```text
Decision state != Application state != Result state
```

禁止使用 UI 推测、内存回调、日志文本或单个 `Approved` 标志代表后续应用完成。
Formation 是首个必须收敛的实例；同规则适用于 approval resume、verification spawn、
completion consumer 和 future subagent delivery。

## 14. Effect 与模块边界

- Application/consumer/recovery 的 Effect error channel 必须是 narrow typed union；
- repository/transport operational errors 不得默认 `orDie` 或 log-and-continue；
- retryable/terminal/outcome-unknown 必须在 owning boundary 分类；
- 超大文件按 capability/aggregate/step 拆分，不按抽象层继续堆 helper；
- active runtime 不再解析新写路径的 legacy directive/message/focus；兼容逻辑移动到
  migration/archive/recovery adapters；
- architecture tests 从 source-string markers 提升为 executable boundary tests。

## 15. 保留与不推翻的基础

以下基础保持：

- Effect service/Layer package DAG；
- pure Domain transition；
- CommandGateway + state/event atomicity；
- Lease/Fencing/idempotency；
- ProviderTurn/ToolInvocation side-effect recovery；
- provenance-aware Model Context；
- Work / Verification / Acceptance 分离；
- ResourceBoundary/Ownership/Permission ceiling；
- one active main per Workspace；
- exact Episode binding and one Agent Loop。

## 16. 实施顺序与停止条件

```text
M0  Vocabulary/contract landing + completion claims corrected
M1  Single-Workspace golden path
M2  WorkspaceKnowledgeView + context simplification
M3  Long-term responsibility / Formation / Parent Acceptance
M4  Dependency/Deliverable closure
M5  Optional subagent runtime
M6  Legacy isolation + approval-ledger physical convergence
```

每一阶段必须通过真实场景和 restart/replay 后才能进入下一阶段。不能以“类型存在、表已建、
command handler 已注册”代替可达的 product closure。

四份执行阶段合同：

```text
planning/phases/MAC-P1-single-workspace-golden-path.md
planning/phases/MAC-P2-long-term-responsibility.md
planning/phases/MAC-P3-cross-work-coordination.md
planning/phases/MAC-P4-optional-subagent-and-final-convergence.md
```

## 17. Owning contract updates（接受后）

```text
docs/design/00-problem-goals.md        # 只澄清 Agent vocabulary，不改变使命
docs/design/01-scenarios.md            # 将 Workspace / Work / runtime subagent 明确分层
docs/design/02-system-design.md         # minimal vocabulary / action / knowledge / fulfillment
docs/design/03-detailed-implementation-design.md
docs/design/implementation/P2/**
docs/design/implementation/P3/**
docs/design/implementation/P6/**
docs/design/implementation/P7/**
docs/design/implementation/P8/**
docs/design/implementation/P12/**
docs/design/implementation/P17/**
```

## 18. 接受令牌

```text
ACCEPT_MINIMAL_ARCHITECTURE_CONVERGENCE
```
