# Codex Subagent 与 Arbor Delegation 机制对照

**Date:** 2026-10-03
**Purpose:** 在继续 Root Goal Placement（RGI-DG-01）前，澄清 Codex subagent、
Arbor Specialist、Work 与 child Workspace 的边界。本文是分析材料，不是冻结设计。

## 1. 外部基线：Codex / Responses Multi-agent

OpenAI 官方 Multi-agent 文档描述的 subagent 是一次运行中的并行、聚焦执行分支：

- root agent 负责拆分任务、协调和最终汇总；
- 每个 subagent 有独立 context；
- subagent 默认共享该 request 配置的 model 和 available tools；
- root/subagent 通过 `spawn_agent`、`send_message`、`followup_task`、`wait_agent`、
  `interrupt_agent`、`list_agents` 协作；
- agent tree 使用 `/root/...` 路径，是运行期协作树；
- subagent 适合独立、有界、可并行的工作流，不适合强串行步骤或争用同一可变资源的
  工作；
- 并行度由 `max_concurrent_subagents` 约束；官方默认并建议多数场景使用 3，但这是
  Codex/Responses 的产品默认，不应直接成为 Arbor 的领域常量。

Source: https://developers.openai.com/api/docs/guides/responses-multi-agent

## 2. 三个概念不能混为一谈

```text
Codex subagent tree
≈ Arbor Execution delegation tree
≈ Arbor ExecutionBound Specialist

Codex subagent tree
≠ Arbor Responsibility / Workspace tree
```

Arbor 实际上有两棵树：

```text
Responsibility Tree（长期）
Workspace
└─ child Workspace
   └─ child Workspace

Execution Delegation Tree（临时）
main Execution
├─ Specialist Execution
├─ Specialist Execution
└─ Specialist Execution
   └─ nested Specialist Execution
```

第一棵树回答“谁长期负责什么”；第二棵树回答“这次运行临时找谁并行完成哪一小块”。
不能为了获得并行执行就创建 Workspace，也不能用临时 Specialist 承担未来仍需持续负责
的领域。

## 3. 对照表

| 维度 | Codex subagent | Arbor Specialist（目标语义） | Arbor child Workspace |
|---|---|---|---|
| 本质 | 运行期子 Agent | `ExecutionBound` 临时角色 | 长期责任实体 |
| 生命周期 | 当前 multi-agent run 内 | 当前/后继 Execution 协作周期 | 跨多个 Work、Execution、进程重启长期存在 |
| Identity | agent path，如 `/root/reviewer` | Execution/ref；不创建 AgentId | WorkspaceId + Responsibility revision |
| Context | 独立；root 决定 fork 范围 | 独立 Session + typed SpecialistBrief | primary Session + 长期局部知识/责任上下文 |
| Tools | request 中配置的工具对各 agent 可用 | parent 可见能力的受限子集 | 由责任、资源、策略和 PermissionGrant 决定 |
| 协作 | spawn/message/followup/wait/interrupt/list | 应提供同型但 durable、typed 的执行协作 | Work、Message、Dependency、Steer、governance |
| Result | final answer/message 返回 parent | typed SpecialistResult 回 parent Execution mailbox | Work result → Verification → Parent Acceptance |
| Verification | root 自行综合；无 Arbor 领域含义 | 结果只是 parent 输入/证据，不自动完成 Work | 独立 Work 可正式验证和接受 |
| Resource isolation | 不因 spawn 自动保证隔离 | 不因 spawn 自动成为 Workspace/worktree | 可拥有独立 ResourceBoundary/GitWorktree |
| Recovery | 由托管 multi-agent response/session 提供 | durable Execution、mailbox、replay、fencing | 完整 scheduler/workflow/recovery |
| 适用场景 | 并行探索、审查、独立实现块 | 同左，但受 Arbor 权限/资源/恢复约束 | 长期、重复出现、有独立责任与治理边界的工作 |

## 4. 正确的组合形态

```text
Workspace（长期责任）
└─ Work（本阶段要交付的正式成果）
   └─ main WorkEpisode / Agent Loop
      ├─ Specialist A：调查一种根因
      ├─ Specialist B：审查另一模块
      └─ Specialist C：运行独立测试
          ↓
      main Agent 汇总 SpecialistResult
          ↓
      ClaimCompletion
          ↓
      独立 Verification
          ↓
      Parent Acceptance / Work Completed
```

如果 Agent 在执行 Work 时发现的不是“一次性子任务”，而是一块长期、反复出现、需要
独立上下文和权限的责任，它才走 `propose_workspace(initialWork)`。

## 5. Arbor 当前已经做对的部分

1. 冻结设计明确区分：
   `ProposeChildWorkspace → 长期责任`，`SpawnSpecialist → 一次性执行角色`；
2. Specialist 使用 `ExecutionBoundAgentBinding`，没有长期 AgentId；
3. Specialist 有独立 Execution、Session、parentExecutionId 和重启恢复路径；
4. spawn 使用确定性 Execution/Session/Command identity，replay 不重复创建；
5. Specialist settlement 使用 fingerprint + Inbox upsert，至少一次投递不会重复；
6. parent Stop/quiescence 后禁止继续 spawn；
7. Specialist 可以递归 spawn Specialist，具备运行期树形分解的基础。

这些比“把 subagent 当作 child Workspace”更正确，也保留了 Arbor 的长期责任模型。

## 6. 当前实现与可用 subagent 机制之间的缺口

### 6.1 Specialist 实际没有 executable tools

`TurnProfileResolver` 只给 `WorkspaceWork / WorkspaceInput / Verifier` 装载 executable
tools；`ExecutionBoundSpecialist` 只得到：

```text
send_message
propose_workspace
spawn_specialist
```

因此 Specialist 目前不能读文件、搜索代码、运行命令、修改文件或执行研究工具。它能
被创建，但难以完成实质性子任务。这与冻结 P17 文档中的“parent-distributed subset”不
一致，也明显弱于 Codex subagent 的可用工具面。

### 6.2 Context handoff 太薄

冻结 `SpecialistSpec` 有 `mission / constraints / skillIds`，但当前 model-facing codec 只有
`mission / constraints`。它没有：

- expected result / completion shape；
- 相关 Artifact/Blob/Decision/ToolResult refs；
- 当前 Work 与 Plan 的必要片段；
- tool profile；
- skillIds 的实际传递；
- 可审查的 context provenance。

Arbor 不应简单复制 Codex 的 `fork_turns=all`，但需要 typed `SpecialistBrief`，否则独立
context 会变成信息饥饿。

### 6.3 缺少运行期协作控制面

Arbor 当前只有 `spawn_specialist` 和最终 settlement 回流，没有针对 specialist 的：

```text
list specialists/status
message active specialist
assign follow-up / resume waiting specialist
wait for exact specialist or set
interrupt specialist
```

现有 `send_message` 面向 Workspace，不面向 ExecutionBound specialist；现有 `wait` 只能
等 `InboxAdvanced` 等通用条件，无法精确绑定某个 specialist。

### 6.4 Result 回流丢失 parent-execution 精确性

当前 `SpecialistSettled` 只进入 Parent Workspace Inbox，明确禁止直接写 Parent Session。
“不直写 Session”是正确的，但仅投递 Workspace Inbox 会丢失精确的运行期协作关系：

- active parent 不能像 Codex root 一样直接收到所属 subagent 的结果；
- unrelated Inbox 输入可能一起唤醒；
- parent 已 settled 与仍 active 的处理没有区分；
- result 只有 summary，没有 artifact/evidence/unresolved-question refs。

需要 durable `ExecutionMailbox`，而不是恢复 Parent Session 直写：active/waiting parent 收
exact result；若 parent 已 terminal，再降级投递 Workspace Inbox，保证结果不丢。

### 6.5 并发与共享资源策略不够明确

P2 没有 specialist 并发硬限制，只依赖 Safety Envelope。还缺少：

- parent/project-scoped active specialist budget；
- delegation depth budget；
- 同一 mutable resource 的并行冲突策略；
- read-only / edit / shell 等 tool-profile ceiling；
- parent 只能下放自己拥有能力的机械证明。

Codex 官方也明确提示：多个 agent 争用同一 mutable resource 时，单 Agent 往往更合适。
Arbor 需要把这条经验变成 Runtime policy，而不是只写在 prompt 中。

## 7. 推荐的 Arbor Specialist 目标架构

### 7.1 Typed handoff

```ts
interface SpecialistBrief {
  readonly mission: string;
  readonly expectedResult: string;
  readonly constraints: ReadonlyArray<string>;
  readonly contextRefs: ReadonlyArray<ArtifactRef | BlobRef | DecisionRef>;
  readonly toolProfile: "ReadOnly" | "Test" | "EditBounded" | "Custom";
  readonly skillIds: ReadonlyArray<string>;
}
```

Runtime 自动补充 parent Work identity/revision、Workspace responsibility/boundary、权限基准
与 provenance；模型不能伪造这些字段。

### 7.2 Tool subset

```text
SpecialistVisibleTools
  = ParentVisibleTools
    ∩ requestedToolProfile
    ∩ ResourceBoundary
    ∩ Permission/Policy ceiling
    ∩ Runtime safety limits
```

默认可采用 ReadOnly；需要 edit/shell 时 exact spawn intent 应展示并走 CAPA。不能像当前
实现一样全部清空，也不能无条件复制 parent 的所有工具。

### 7.3 Durable collaboration primitives

模型表面保持简单、无 Arbor 前缀：

```text
spawn_specialist
list_specialists
message_specialist
followup_specialist
interrupt_specialist
wait（增加 exact SpecialistChanged condition）
```

这些是 Execution coordination tools，不创建 Workspace、Work 或长期 Agent identity。
`specialistRef` 是 Runtime 发放的 opaque ref，执行时绑定 exact ExecutionId/revision。

### 7.4 Execution mailbox

```text
Specialist event/result
→ durable parent ExecutionMailbox
→ active/waiting parent 精确 wake + next ProviderTurn input
→ parent terminal 时 fallback 到 owning Workspace Inbox
```

仍然禁止无来源地直写 Parent Session。Context Runtime 只把 mailbox entry 作为带 provenance
的 typed input 编译进下一 turn；成功消费后留下 durable receipt。

### 7.5 Structured result

```ts
interface SpecialistResult {
  readonly status: "Succeeded" | "Failed" | "Interrupted" | "Unknown";
  readonly summary: string;
  readonly artifactRefs: ReadonlyArray<ArtifactRef>;
  readonly evidenceRefs: ReadonlyArray<EvidenceRef>;
  readonly unresolvedQuestions: ReadonlyArray<string>;
  readonly settlementFingerprint: string;
}
```

SpecialistResult 不是 CompletionClaim、Verification PASS 或 Work Completed。main Agent 必须
整合结果，并对最终 Work 承担 completion/verification 责任。

### 7.6 Follow-up 与不可变 Execution

- active/waiting specialist 可以接收 message；
- waiting specialist 可以被 follow-up 唤醒；
- terminal Execution 不复活；对 terminal specialist 的 follow-up 创建 successor
  ExecutionBound Execution，并显式引用前序 result/context refs；
- interrupt 走 StopExecution/quiescence，不能只改 UI 状态。

## 8. 何时用哪一种

### 用 Specialist

- 对同一 bug 并行调查不同根因；
- 分模块只读审查；
- 独立运行测试或比较方案；
- 在明确不冲突的文件范围实现小组件；
- 任务结束后不需要长期承担后续责任。

### 用当前 Workspace 的新 Work

- 需要正式交付、验证、恢复和追踪；
- 仍属于当前 Workspace 的长期责任；
- 完成后不需要产生新的组织节点。

### 用 child Workspace

- 会持续产生多个 Work；
- 需要长期局部认知、独立责任、资源或治理边界；
- 未来需要持续接收返修与演化；
- 独立存在的收益长期超过协调成本。

## 9. 对 RGI-DG-01 的影响

Root Goal Placement 不应只在 `assign_work` 与 `propose_workspace` 之间选择。完整闭环是：

```text
Root Conversation 决定 Work 应由哪个 Workspace 承担
→ 创建/分配正式 Work
→ Work main Agent 决定是否使用 Specialist 并行执行
```

Workspace placement 是长期组织决策；Specialist spawning 是 WorkEpisode 内的临时执行
策略。两者不能合并为一个判断，也不能让 Root Conversation 直接用 Specialist 替代正式
Work。因此 RGI 可以继续定义目标归属，但其“执行闭环”验收应依赖 Specialist delegation
至少达到可用基线。
