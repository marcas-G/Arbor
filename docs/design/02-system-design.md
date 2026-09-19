# Arbor System Design Specification

**Version:** 1.3  
**Status:** FROZEN — governance patch  
**Supersedes:** v1.2  
**Date:** 2026-09-20  
**Depends on:** `Arbor Problem Definition & Goals v1.2` + `Arbor Scenarios S1–S4 v1.2`  
**Owns:** 领域模型、组织/执行语义、权限治理、Verification、恢复语义、Environment/UI Projection、Runtime 组件边界与系统不变量  
**Does not own:** P1–P8/G1–G8 的定义、S1–S4 行为正文、最终 TypeScript/Effect API、数据库表结构、包目录或具体基础设施选型  
**Scope:** 把上游问题、目标和场景落实为稳定的系统语义与组件责任；只保留必要的上游追踪，不重复上游正文。

**Governance changes (v1.2 → v1.3):**

- DG-01: replaced an undefined Dependency-producer term with `ProducerBinding` semantics.
- DG-02: froze the deterministic Dependency/Deliverable matching boundary as a system principle.
- DG-05: constrained Workspace to a responsibility-bound agent binding.

`Problem & Goals` and `Scenarios` are unchanged: these gaps closed System/DID-level
semantics only and did not change WHY or user-visible behavior.

---

## 0. 文档定位与冻结规则

Arbor 的系统设计已经完成从“问题定义 → 目标 → 场景 → 系统设计 → 架构审计”的闭环。本文只保留最终结论，不保留讨论过程。

从 v1.0 起遵循以下冻结规则：

1. 不再因为实现便利随意增加顶层领域实体。
2. 实现阶段遇到问题时，优先判断其属于现有概念的细化、接口设计、存储设计或运行时实现问题。
3. 新概念必须能够明确说明它支撑 S1–S4 的哪一步；不能说明者默认视为过度设计。
4. `Goal`、复杂 Agent 生命周期状态机、`Workspace = Folder`、`Transcript = State` 等已经明确否决的建模不得在实现阶段以新名字重新引入。
5. 所有重要组织变更与外部副作用必须经过对应 Runtime，不允许 Agent、UI 或 Provider 直接修改权威状态。

---

# 1. 上游设计输入与追踪

## 1.1 上游权威边界

Arbor 的问题、目标与场景已经由两份上游文档拥有：

```text
Arbor Problem Definition & Goals v1.2
    owns: P1–P8, G1–G8, mission, success criteria

Arbor Scenarios S1–S4 v1.2
    owns: S1–S4 observable behavior
```

本文不复制或重新定义这些内容。系统设计中的任何对象、Runtime 或 invariant 必须能够向上追踪到至少一个 `P/G` 与一个场景步骤；若无法追踪，优先视为过度设计。

## 1.2 系统级设计义务

上游约束在系统层形成以下设计义务；这里描述的是**必须被系统设计满足的性质**，而不是重新定义目标：

| 上游义务 | 系统级响应 |
|---|---|
| 长期责任与认知连续性 | Stable Workspace/Responsibility Identity + Session/Knowledge continuity |
| 动态、递归但受治理的组织 | Responsibility Tree + Responsibility-bound / Execution-bound 两类执行角色 |
| 用户高层控制、低层自治 | Parent/User Governance + deterministic Runtime enforcement + observable projections |
| 独立质量闭环 | Producer / Agentic Verification / Parent Acceptance 分离 |
| 局部而受控的上下文 | Canonical State / Cognitive State / model-visible context 分离 |
| 复杂依赖与协作 | Work/Dependency/Deliverable/Message 分离，Dependency Graph 与 Responsibility Tree 分离 |
| 故障与未知副作用恢复 | Durable State + Lease/Fencing + side-effect reconciliation + local recovery |
| 默认可用但可配置 | 内置默认 policy；Usage/Cost 默认可观察而非隐式 hard budget |

## 1.3 S1–S4 追踪

| 场景 | 本文主要承接位置 |
|---|---|
| S1 正常长期推进 | Workspace/Responsibility、Work/Execution、Agent Runtime、Verification、Acceptance |
| S2 监督与纠错 | Projection/UI、Query/Steer/Stop/Governance、Human Override |
| S3 协作与异常 | Dependency/Deliverable、Communication、Permission、Deadlock、Parent escalation |
| S4 长期连续与恢复 | Session/Memory、Persistence、Lease/Fencing、Reality reconciliation、Recovery |

场景的具体顺序、分支与用户体验以 `Arbor Scenarios S1–S4 v1.2` 为准；本文只说明支撑这些行为所需的系统语义。

## 1.4 文档变更归属

```text
WHY / WHAT changed
→ Problem & Goals

observable workflow changed
→ Scenarios

domain/runtime/invariant changed
→ System Design

API/ADT/Effect/SQL/package/mechanism changed
→ Detailed Implementation Design
```

如果 Detailed Implementation Design 发现某个系统 invariant 无法实现，应以失败证据回到本文修订；不得在实现层静默改变系统语义。

---

# 2. 核心设计原则与术语

## 2.1 Workspace-centric

Arbor 是 **Workspace-centric**，不是 Session-centric 或 Agent-runtime-centric。

- **Workspace**：长期责任单元。
- **Responsibility**：Workspace 为什么存在、长期负责什么、边界在哪里。
- **Agent**：代表 Workspace 自主行动的长期执行主体。
- **Work**：Workspace 在责任范围内需要达成的阶段性具体结果。
- **Execution**：为了推进 Work 发生的临时计算活动。
- **Session**：主 Agent 的长期认知与交互载体，不是领域真相。

生命周期关系：

```text
Responsibility lifetime > Work lifetime > Execution lifetime
Workspace identity > Session identity > Worker identity
```

## 2.2 两种 Agent Binding

### Responsibility-bound Agent

- 绑定 Workspace；
- 长期存在；
- 拥有长期 Primary Session；
- 在责任边界内拥有执行自治；
- 进入 Responsibility Tree。

### Execution-bound Agent

- 绑定某次 Execution；
- 临时存在；
- 不拥有长期 Responsibility；
- 用于 Verification、临时专家和临时调查；
- 不进入长期 Responsibility Tree。

二者共用同一个 Agent Runtime。

硬规则：Workspace 的长期 binding 必须是 responsibility-bound；
execution-bound binding 只能属于临时 Execution context，不得存入 Workspace。
（DID 将其分别命名为 `ResponsibilityBoundAgentBinding` /
`ExecutionBoundAgentBinding`，`AgentBinding` 仅作为二者的 umbrella 术语。）

## 2.3 两种树

长期组织：

```text
Responsibility Tree
```

临时执行：

```text
Execution / Agent Invocation Tree
```

二者不得在领域模型和 UI 中混为一棵树。

## 2.4 树与图

```text
Responsibility Tree = 谁负责谁
Dependency / Collaboration Graph = 谁需要谁
```

每个非 Root Workspace 只有一个 Parent；Dependency 可以跨 Workspace 形成图。

## 2.5 核心哲学

```text
LLM decides semantically;
Runtime commits deterministically.
```

能由确定性 Runtime 判断的事情，不浪费 LLM；需要理解、推理、探索和判断的事情交给 Agent。

---

# 3. 核心领域模型

## 3.1 Project

Project 是整个长期工作的最高容器与治理边界。

拥有：

- 整体目标；
- Root Workspace；
- Project Policy；
- Execution Environment；
- 全局 Resource / Provider / Tool capability；
- Event Journal；
- Project-level projections。

Project 本身不承担局部执行责任。

## 3.2 Workspace

Workspace 是长期存在的一块责任空间，不等于文件夹、Session、Task 或进程。

逻辑上包含：

```text
Workspace
├── identity
├── parent
├── responsibility
├── boundary
├── main agent binding
├── current/pending work
├── child workspaces
├── local session
├── effective facts
├── knowledge/memory
├── policies
└── resource boundary
```

## 3.3 Responsibility

Responsibility 是 Workspace 的定义性属性，不单独建成平级实体。

回答：

- 为什么存在；
- 长期负责什么；
- 对什么结果负责；
- 哪些事情明确不属于它。

Responsibility 可以被显式细化、缩小和回收，但不能在 Agent 执行过程中偷偷漂移。

## 3.4 Work

Work 表示 Workspace 在其 Responsibility 范围内需要达成的一个具体结果。

至少包含语义：

- What；
- Why；
- Constraints；
- Completion Expectations；
- Verification Mission；
- Provenance。

一个 Workspace：

```text
Current Work: 0..1
Pending Work: 0..N
```

需要真正并行时优先进行 Responsibility Formation，而不是同一主 Agent 同时跑多个主工作链。

Work 生命周期保持简单：

```text
Open | Completed | Cancelled
```

Waiting、Blocked、Verifying、Running 等尽量由 Execution、Dependency、Inbox、Verification 等事实推导，不作为复杂 canonical status。

## 3.5 Execution

Execution 是推进 Work 或完成一次 Coordination mission 的临时执行 episode，可以包含多个 Provider Turn、Tool Call 和短暂停顿。

```text
Turn End != Execution End
Execution End != Work End
```

Execution 结束时必须同时保留两类信息：

```text
technical outcome
+
semantic terminal result
```

例如 `Yield`、`Completion Claim` 与 `Coordination completed` 即使都属于技术上的正常结束，也不能在 durable state 中被压成不可区分的同一结果；恢复和后续自动动作必须能够从 settlement 本身判断下一步。

一个 Workspace 同时最多拥有一个有效主 Execution。Execution admission 时固定其所使用的 Session；Workspace 后续替换 Primary Session 只影响未来 Execution，不改变已经 admission 的 episode。

## 3.6 Session

每个 Responsibility-bound Agent 默认拥有一个长期 Primary Session，跨多个 Work 持续存在。Primary Session 是 Workspace 对未来 Execution 的默认认知入口；已经 admission 的 Execution 使用其固定 Session binding，不随 Primary Session replacement 漂移。

Session 负责：

- 局部认知连续性；
- 交互历史；
- Cache affinity；
- Context Epoch；
- Continuation checkpoint。

Session 不是领域真相。必要时可以根据 Workspace State、History、Memory 和 Current Work 重建。

## 3.7 Dependency

Dependency 是持久关系，表示 Consumer Work 需要某个具体的 Expected Deliverable：

```text
Consumer Work
depends on
Producer / Expected Deliverable
```

Dependency 不只指向“某个 Agent”，而尽量指向具体预期结果。Dependency 的生产者由 **ProducerBinding** 表达，只有三种语义：

```text
AnyProducer
WorkspaceBound(workspace)
WorkBound(work)
```

- `AnyProducer`：任何来源的匹配结果都可满足；
- `WorkspaceBound(workspace)`：只能由该 Workspace 产生的结果满足；
- `WorkBound(work)`：只能由该 Work 产生的结果满足。

Dependency satisfaction 必须针对被判断时有效的 Dependency contract；一旦满足，已记录的 satisfaction 不被后续静默改写。

Dependency satisfaction 是 **structural / deterministic matching**：ProducerBinding 匹配来源、Deliverable kind 匹配、以及 required artifact roles 被满足。三者全部成立才算匹配。“结果质量够不够”属于 Verification，“结果是否足以支撑 Consumer 上层工作”属于 Consumer/Parent cognition，都不属于 matcher。matcher 不做 metadata query、regex、semantic similarity 或 LLM 判断。

## 3.8 Deliverable

Deliverable 是 Work 产生的可被 Parent 或其他 Workspace 消费的正式结果。

```text
Work != Deliverable
```

正式 Deliverable 引用版本稳定的 Artifact / Result，并绑定产生它的 Work revision，使 Dependency satisfaction、Verification 与 Acceptance 能判断“这个结果对应的是哪一版要求”，而不把旧结果误当成新要求的产物。

Deliverable 具有一个 **kind**（结果类型）以及带 **artifact role** 的 Artifact 集合，使 Dependency 的 structural matcher 能在不读取任意元数据的情况下判断 kind 与 required roles 是否被满足。

## 3.9 Decision

Decision 是正式治理或设计结论。历史 Decision 不原地覆盖；新 Decision 使用 supersede 语义。

## 3.10 Memory / Knowledge

Memory 属于 Workspace，而不是临时模型实例。

区分：

```text
History = what happened
Effective Facts = what is true now
Memory = what we learned
Skill = how we reliably do it
```

Memory 是可维护知识，可以 merge / rewrite / supersede / mark stale，但应保留 Evidence Reference。

## 3.11 Artifact

Artifact 是代码、文档、测试报告、实验结果、日志等真实产物。正式 Artifact 采用不可变版本或版本稳定引用；修改产生新版本，而不是悄悄替换旧版本。

---

# 4. Responsibility 与组织模型

## 4.1 一个 Workspace 一个主 Agent

正常情况下：

```text
Workspace → one Main Agent
```

并行不是让同一 Workspace 挂多个平级主 Agent，而是创建 Child Workspace。

Main Agent 不是特殊 Agent 类型，只是 Root Workspace 的主 Agent。

## 4.2 Parent 创建 Child

Workspace 只能由其直接 Parent 创建和管理。Agent 只能自主拆出自己的 Child；如果需要新增 Sibling 或更高层责任单元，应向 Parent 提议。

Child 不能自行改变 Parent。

## 4.3 Child Delegation Contract

创建 Child Workspace 是正式责任委托，不是一次 Subagent Prompt。

至少定义：

- Purpose；
- Responsibility；
- Boundary；
- Initial Work；
- Necessary Context；
- Known Relationships；
- Quality Expectations。

原则：

```text
Parent defines WHAT / WHY / BOUNDARY;
Child primarily decides HOW.
```

## 4.4 Responsibility Ownership 与 Write Ownership

责任委托后，正常执行和写入归 Child 所有。Parent 保留治理权，但不能绕过 Child 直接修改 Child 正式责任范围。

```text
Governance Authority != Execution Ownership
```

Parent 若要亲自接手必须先显式 Reclaim / Change Responsibility。

## 4.5 Semantic Boundary 与 Resource Boundary

Workspace Boundary 分两层：

1. **Semantic Responsibility Boundary**：语义上负责什么。
2. **Resource Boundary**：语义责任在当前 Environment 中的可执行投影。

```text
Responsibility → Resource Ownership
```

而不是由文件路径反向决定责任。

正式写资源原则上唯一 Owner；Read 可以按协作需要更宽松。

Write ownership 判断针对**规范化后的现实 backing resource**，而不是只比较用户配置中的路径或资源字符串。Environment 必须能够消解 path alias、worktree-to-filesystem mapping 等会让不同语义地址落到同一现实资源的情况；系统设计只冻结这一语义要求，具体 `ResourceAddress` 代数与 resolver contract 由 Detailed Implementation Design 定义。

## 4.6 Context 隔离

Parent/Child 不复制完整 Context。

Child 初始获得：

- Delegation Contract；
- Relevant Current Effective Facts；
- Necessary constraints；
- Reference / Artifact 入口。

Parent 默认只消费：

- Child Progress Summary；
- Blocker；
- Important Finding；
- Verified Deliverable。

```text
Share facts and results, not entire contexts.
```

## 4.7 Responsibility Unit Formation Test

是否成立 Child Workspace 不由任务复杂度或固定层数决定，而由以下 Gate 判断。

硬条件：

1. **Responsibility Core**：能否清晰定义“以后这类事情归它负责”。
2. **Internal Cohesion**：内部是否共享较多上下文、资源和判断逻辑。
3. **Boundary Clarity**：输入、输出和写 ownership 是否清楚。
4. **Accountability**：能否由一个主 Agent 对结果负责。

经济条件：

5. **Persistence**：是否多步、反复修改、未来会再次进入。
6. **Autonomy**：Child 是否能在边界内自主决定 HOW。
7. **Organizational Economics**：隔离、专业化、并行和长期积累收益是否高于委托、沟通、验收与边界维护成本。

目标不是“切碎任务”，而是**识别值得长期独立承担的责任簇**。

## 4.8 Sibling Set Quality

一次分解得到的一组 Direct Children 应满足：

- **Mutual Exclusivity**：责任尽量互斥；
- **Collective Sufficiency**：覆盖 Parent 计划下放的责任；
- **Consistent Decomposition Dimension**：同层尽量采用一个主要维度；
- **Manageable Coordination**：跨 Child 协调成本可控。

```text
Parent Responsibility
= Retained Core + Delegated Child Responsibilities
```

## 4.9 组织演化、Retirement 与 Successor

Responsibility Tree 采用稳定、渐进、向下生长模型：

```text
Existing topology is stable;
new complexity normally grows downward.
```

Workspace 创建后 Parent 固定；不支持普通 reparent / move / merge 去改写既有 Identity 的历史位置。Dependency / Collaboration 变化优先通过 Graph 表达，而不是频繁重组责任树。

但长期项目允许真正的责任重组。重组统一采用 **replacement, not relocation**：建立新的 Successor Workspace / subtree，显式交接 Responsibility、必要 Context、Open Work 的替代事项、Resource Ownership 与依赖关系，再将旧 Workspace 置为 `Retired`。旧 Workspace 的历史、Session、Memory、Decision、Artifact 与原 parent relation 保持不变。

`WorkspaceLifecycle = Active | Retired`。Retired 是 terminal；Retired Workspace 不再 Assign 新 Work、Admit Execution、创建 Child 或修改 Responsibility。除 Root 外，Workspace 只有在无 Active Main Execution、无 Open Work、无 Active Child、无 active write ownership、且不存在 unresolved incoming Dependency 的 ProducerBinding 指向本 Workspace 或本 Workspace 拥有的 Work（除非在同一治理变更中被解决/替换）后才能 Retire。Root 在 Project Open 时不得 Retire。

责任重组可以形成 Supersede / Split / Merge / ResponsibilityTransfer lineage，但 lineage 只记录前后 Identity 的关系，不修改旧 Identity。

## 4.10 Parent 的职责

Parent Agent 同时承担：

```text
Parent
= Retained Work
+ Direct-Child Governance
+ Integration
```

Parent 不重复执行已经委托给 Child 的工作，不持续微观监督；负责：

- 自己保留的工作；
- Direct Child 治理；
- 跨 Child integration；
- Child 无法解决的高层决策；
- Parent Acceptance。

治理只作用于 Direct Children；Observability 可以覆盖整个 subtree。

---

# 5. Work、Agent 与执行模型

## 5.1 Agent Execution Loop

通用 Agent Runtime 使用 Model → Action → Observation 循环：

```text
Current Work
↓
Build Context
↓
Call Model
↓
Model proposes next intent
├─ Tool / Org Action
├─ Query / Report / Decision Request
├─ Completion Claim
└─ More reasoning
↓
Runtime validates & executes
↓
Observation
↓
Continue while meaningful runnable action exists
```

原则：

```text
Model proposes;
Runtime commits.
```

模型“Done”只是 Completion Claim，不等于 Work Completed。

## 5.2 Runnable Work

Arbor 不使用复杂 Agent 生命周期状态机。核心调度问题只有：

> 当前 Workspace 是否存在 meaningful runnable work？

```text
有 → 可以执行
无 → 不调用模型
```

关键规则：

- 当前 Work 仍可推进时保持连续性；
- 当前 Work 被阻塞后才寻找其他 Pending Work；
- 普通 Assign / Query / Report / Deliver 不默认抢占；
- Stop / Critical Steering 可以中断；
- Waiting 不通过模型轮询条件。

```text
Unfinished != Runnable
No runnable work → no model call
```

## 5.3 Work 来源

Work 可以来自：

- Parent Assign；
- Agent 在 Responsibility 内发现的 Self-derived Work；
- User / Root input 路由；
- Verification / Parent Acceptance 产生的补充工作。

Agent 可以发现新 Work，但不能借此扩大自己的 Responsibility。

## 5.4 Long-lived Primary Session

Work 完成后 Session 不销毁。Session lifetime 接近 Workspace / Agent lifetime；模型实际看到的 Context 只是 Session 和 System State 的动态投影。

```text
Session History != Provider Context
```

## 5.5 Context Construction

一次 Provider Context 按稳定程度分层：

1. Global Runtime Rules；
2. Workspace Identity / Responsibility / Boundary；
3. Current Effective Facts；
4. Current Work；
5. Relevant long-term knowledge；
6. Continuation / recent history；
7. Latest inputs / observations；
8. Available tools。

硬信息确定性注入；软历史按需检索。

```text
State is truth
History is evidence
Knowledge is reusable
Context is projection
```

## 5.6 Context Compaction

Compaction 只压缩认知历史，不承担保存领域真相。

可 compact：旧 reasoning、旧 conversation、旧 observation、旧 tool trace。

不可依赖 compaction 保存：Responsibility、Boundary、Current Work、Constraint、Verification、Permission 等正式事实。

Compaction 产生 Continuation Checkpoint；Checkpoint 是认知辅助，不是 authority。

## 5.7 Memory

Memory 只保存跨 Work 仍然可复用的经验。Agent 可以提出 Memory Candidate，但 canonical Memory 由独立提炼/合并过程维护。

Memory 默认稀疏，Context 只选择相关部分，不全量注入。

---

# 6. Provider 与 Tool Runtime

## 6.1 Agent、Model、Provider 分离

```text
Agent = runtime execution role with long-lived responsibility continuity
Model = reasoning resource
Provider = access/protocol/transport
```

Agent Execution 构造 provider-independent Portable Model Request；Provider Runtime 负责 Model Resolution、Capability、Protocol、Auth、Streaming、Retry、Timeout、Cancellation、Telemetry 和 canonical event normalization。

## 6.2 Model selection

显式 Model 不允许 silent fallback。Fallback 只有在 Project/User 明确配置策略时发生，并且必须可观察。

Model 切换不改变 Workspace、Responsibility、Work 或 Memory，只形成新的 model-compatible Context Epoch。

默认维持稳定 model/provider/cache affinity。

每个 effectful Model decision 还必须可追溯到其 `ControlBasis`：Work/Responsibility/ResourceBoundary/Policy/Permission/Environment 等对该动作有约束力的 revision 集合。动作执行前 Runtime 按动作类型重新校验所需 revision；若关键控制事实已变化，则该 Decision 视为 stale，不执行旧动作，而是重建 Context 重新决策。

## 6.3 Provider error

Provider Error 应结构化，例如：

- AuthenticationRequired；
- AuthorizationFailure；
- RateLimited；
- QuotaExhausted；
- ProviderUnavailable；
- TransportFailure；
- StreamInterrupted；
- ContextOverflow；
- UnsupportedCapability；
- MalformedResponse。

错误影响范围与真实 Resource Key 对齐，不无差别阻塞整个 Project。

## 6.4 Safe retry

自动 Retry 仅限尚未产生可观察外部副作用的 transient failure。已经产生 Tool Intent / side effect 时不得盲目重放整个 Turn。

## 6.5 Tool Runtime pipeline

```text
Tool Intent
↓
Input Validation
↓
Canonical Resource Resolution
↓
Responsibility Authority
↓
Permission / Approval
↓
Resource Admission
↓
Sandbox / Isolation
↓
Execute
↓
Settlement
↓
Bounded Model Observation
```

结果语义至少区分：

- Success；
- Expected Tool Failure；
- Interrupted；
- Outcome Unknown；
- Runtime Defect。

```text
No result != No effect
```

## 6.6 Tool Result 与 Observation

完整 Tool Result / Raw Artifact 与模型实际看到的 Bounded Observation 分离。大输出保留 Artifact Reference，模型只看到完成当前推理需要的信息。

## 6.7 Organizational actions

`create_child`、`assign`、`query_workspace`、`declare_dependency`、`report_parent` 等可以通过同一 model tool-calling surface 暴露，但 Domain 层不把它们当作普通 Tool side effect；它们必须经过 Workspace / Communication Runtime 的组织规则。

---

# 7. Communication、State 与 Scheduler

## 7.1 Command / Message / State / Event

```text
Command = what is requested
Message = what is communicated
State = what is true now
Event = what happened
```

Command 不是事实；Message 到达不表示 Agent 已经理解；Event 描述已经提交的有意义变化。

## 7.2 Work-plane primitives

最小通信语义：

1. Assign — Parent → Child；
2. Query / Reply — 允许的 Workspace 间查询；
3. Dependency — 对具体 Deliverable 的前置关系； Dependency 具有 `Unsatisfied / Satisfied / Withdrawn / Unfulfillable` 语义：Consumer 不再需要时 Withdrawn；Requirement 仍需要但当前合同已确认无法满足时 Unfulfillable，并产生 Attention；
4. Decision Request — Child → Parent 请求高层裁决；
5. Report — 重要发现向上暴露；
6. Deliver — Child → Parent 正式交付。

## 7.3 Governance primitives

- Steer；
- Stop；
- Constraint Update；
- Responsibility Change / Reclaim。

普通消息默认不抢占当前执行。横向信息流可以自由一些，但 Authority 保持纵向。

### Stop / Critical Steer 的 Quiescence 语义

`Stop` 与 `Critical Steer` 一旦提交，当前 Execution 立即进入“禁止新动作”的 quiescence 过程：不得再开始新的 Provider Turn、ToolInvocation、Execution-originated canonical Command 或 Specialist spawn。已经发出的外部副作用按其 side-effect semantics 取消、确认或 Reconcile；存在无法确认的副作用时，Execution 必须进入 `OutcomeUnknown`，不能伪装为普通 Interrupted/Failed。

`CancelWork` 是治理事实，`StopExecution` 是运行时控制，二者分离。Cancel Work 可以先成为 Canonical Truth，同时相关 Execution 继续完成 quiescence/reconciliation。

## 7.4 Inbox

重要输入持久进入 Workspace Inbox。Inbox 表示“尚未被该 Workspace 认知整合的重要输入”，不是永久历史库。

```text
Inbox != Next Context
```

Context Builder 只选择与 Current Work、Interrupt 或高价值事项相关的未消费输入。

## 7.5 Input Admission / Promotion / Consumption

```text
Admission → Promotion → Consumption
```

- **Admission**：验证来源、Authority、结构并持久化。
- **Promotion**：Runtime 将确定性后果直接提交为 Canonical State。
- **Consumption**：Agent 将需要认知判断的输入纳入推理并产生决策。

```text
Receive != Promote != Consume
Deterministic first; cognitive only when necessary
```

例如 Deliverable 到达后，Runtime 可直接满足匹配 Dependency；Parent 是否认为结果足够则需要 Agent 判断。

## 7.6 Scheduler、Waiting 与 Current Work Selection

Scheduler 是确定性 Runtime，不是 LLM Planner。

负责：

- Runnable Work detection；
- durable Wait/Wake 管理；
- Execution Admission；
- one-active-execution invariant；
- Worker Lease / Fencing；
- Wake-up / durable timer；
- Current Work 的确定性切换规则；
- fairness；
- resource-aware scheduling。

Open Work 如果暂时无法推进，必须有 durable `WaitSpec` 描述等待的 Dependency / Decision / Approval / Inbox / Environment / Time / Manual 条件；系统不得通过重复模型调用轮询。注册 Wait 与检查“被观察事实是否已经变化”必须处于同一一致性边界，避免 lost wake-up。时间条件必须由持久调度恢复，不能依赖某个 Worker 的内存 timer。

当无 Active Main Execution 时，Scheduler 重新计算 Workspace：Current Work 可运行则继续；Current Work 正在等待且没有其他 runnable Work 则保持静止；只有一个其他 runnable Work 时 Runtime 确定性切换；有多个候选时才 Admit `focus = Coordination` 的 Workspace Execution，让 Agent 进行语义选择。Coordination Execution 可以提交 `SelectCurrentWork`，而正在推进旧 Work 的 Work-focused Execution 不可以边执行边切 Current Work。

Workspace 数量与实时 Execution concurrency 分离：

```text
Unlimited-ish organization, bounded execution
Limit resources, not responsibilities
```

## 7.7 Resource control 与 Usage

Runtime 硬约束：

- Agent Execution Capacity；
- Provider Capacity / Availability；
- Tool / Compute Resource Capacity。

Usage / Cost：

- Tokens；
- Cost；
- Compute time；
- Provider usage；
- Workspace / subtree / Project aggregate。

Usage 默认只统计和展示。用户显式配置时才可形成基于业务预算的 warn / ask / stop policy。

独立于用户 Budget，Runtime 始终拥有 Safety Envelope：限制瞬时/连续重试、递归 Tool 链、重复动作、长时间无 durable progress、Provider/Tool 并发和异常资源消耗。触发 Safety Envelope 只中断当前 Execution 并产生 Attention；Work 保持 Open，除非另有正式治理命令。

---

# 8. Authority、Permission 与 Governance

## 8.1 Authority model

治理权严格依附 Responsibility Tree。

```text
User
↓
Root / Main Agent
↓
Direct Child
↓
...
```

基本规则：

- Workspace Agent 在自己的 Boundary 内自治；
- Parent 只日常治理 Direct Children；
- Sibling 没有 Assign / Steer / Stop / Responsibility Change 权；
- Observability 可以覆盖 subtree；
- User 是最终治理来源，可以显式 Human Override；
- Runtime 执行 invariant，不作为另一个组织决策者。

```text
Authority flows vertically;
information flows graphically.
```

## 8.2 Capability Ceiling

Child 权限不简单复制 Parent，而是根据 Responsibility 重新投影：

```text
Effective Permission
= Delegable Capability Ceiling
∩ Responsibility Scope
∩ Resource Boundary
∩ Effective Constraints
∩ Configured Policy
```

Project Policy 定义最高约束；Workspace / Work / Execution 只能进一步收紧，不能自行突破 ancestor hard deny。

## 8.3 Tool Visibility、Permission 与 Delegation 分离

- Tool Visibility：模型是否看到 Tool；
- Execution Permission：当前动作是否允许；
- Delegable Capability Ceiling：Parent 有权组织给 Child 的能力上限。

三者不是同一概念。

## 8.4 Temporary Grant 与 Exact-Intent Approval

临时 Permission Grant 必须有 Scope：Execution / Work / Workspace / Project；临时 Grant 默认不可继续递归委托，避免 privilege amplification。

高风险“一次性批准”不使用模糊的 `once tool permission`，而使用 **Exact-Intent Approval**：批准必须绑定具体 Tool definition/version、规范化后的动作/参数摘要、目标 canonical resources、当时有效的 control basis 与 expiry。实际 Invocation 与批准内容不一致、关键控制 revision 已变化或批准已过期时，必须重新审批。批准只能被一个匹配的 ToolInvocation 原子消费。

```text
Delegation must not amplify authority.
Approval of one intent must not authorize a different intent.
```

## 8.5 Approval / Escalation

路由原则：

```text
Runtime deterministic resolution
↓
Lowest competent authority
↓
Escalate only if higher authority is actually required
↓
User as final decision source
```

典型分类：

- ordinary risk approval → Direct Parent；
- temporary capability → nearest authority allowed to grant；
- cross-workspace ownership conflict → nearest common ancestor；
- project policy exception → Root / User；
- human-required high-risk action → User；
- insufficient evidence → 先补证据，不盲目向上升级。

```text
Escalate authority, not uncertainty.
```

---

# 8A. Information Trust Plane

Arbor 将“信息从哪里来/有多可信”与“它是否有指令权威”分开建模。外部检索、Tool Observation、Imported Artifact、Child Report、模型派生结论默认是 Data；只有由 Runtime 根据治理事实编译出的 Canonical Instruction 才进入控制平面。

至少区分 Provenance（CanonicalInternal / AuthenticatedHuman / AuthenticatedAgent / ToolObservation / ExternalRetrieved / ImportedArtifact / ModelDerived）、Instruction Capability（CanonicalInstruction / InstructionCandidate / DataOnly）和 Epistemic Status（Established / Supported / Unverified / Conflicting / Derived）。

核心规则：

```text
Retrieved data != instruction
Tool output != instruction
Repeated content != memory eligibility
Child message authority != textual instruction authority
Model-derived claim != established fact
```

Memory promotion 必须保留 Provenance，并经过独立的 persistence eligibility / merge policy；不可信内容不能通过“让模型记住我”来自行获得长期 Persistence。

---

# 9. Agentic Verification 与 Acceptance

## 9.1 三层质量模型

```text
Producer Self-check
↓
Completion Claim
↓
Formal Agentic Verification
↓
PASS / FAIL / UNKNOWN
↓
Parent Acceptance
```

```text
Self-check != Verification != Acceptance
```

## 9.2 Verification 是 Agentic Investigation

Formal Verification 不是一组纯代码 checks。它是一段独立 Agentic Execution，由 Execution-bound Verifier 使用通用 Agent Runtime 完成。

Verifier 能力包括：

- 理解 Work 与 Verification Mission；
- 制定 Verification Plan；
- 读取代码、文档和 Artifact；
- 运行已有 tests；
- 自己设计额外 tests；
- 构造边界案例与反例；
- 搜索/检索资料；
- 检查跨模块影响；
- 复现实验；
- 挑战 Producer 假设；
- 必要时创建临时 Verification Sub-execution。

```text
Verification = Agentic investigation
Tests = evidence tools used by Verification
```

## 9.3 Producer 与 Verifier 隔离

Verifier 默认：

- 独立 Context；
- Read broadly；
- 可运行验证工具；
- 可创建临时验证 Artifact；
- 不直接修改 Producer 正式结果；
- 不修改 Work requirement；
- 不修改 Responsibility。

```text
Verifier judges;
Producer fixes;
Parent accepts.
```

## 9.4 Verification Mission

每个 Work 在执行前至少拥有一个最小 Verification Mission，回答：

- What must be established？
- What must not be violated？
- What evidence would be convincing？
- What risks deserve special attention？
- What is currently uncertain？

Mission 来源于：

- Work Completion Expectations；
- Workspace quality rules；
- Project quality policy；
- domain/tool-derived defaults。

Producer 可以提出强化或修订建议，但不能单方面降低标准。

## 9.5 Requirement 与 Method 分离

```text
Requirement = 要证明什么
Verification Method = 怎样取得证据
```

Verifier 可以自主创造验证方法。UNKNOWN 往往说明证据/方法不足，不等于 requirement 应被删除。

## 9.6 Verdict

每个 required criterion 输出 PASS / FAIL / UNKNOWN 并绑定 Evidence。

确定性聚合：

```text
任一 required FAIL → Overall FAIL
无 FAIL 但存在 UNKNOWN → Overall UNKNOWN
全部 required PASS → Overall PASS
```

Optional criterion 不影响 required PASS，但需要透明展示。

## 9.7 Parent Acceptance

Verification PASS 只说明局部结果满足 Verification Mission；Parent 仍判断：

> 这份结果是否足够支撑我的上层 Work？

如果不足，产生新的/补充 Work，而不是把已验证正确的结果改判 FAIL。

Root 内部 Work 可由 Main Agent完成 acceptance；Project milestone 才需要 User Acceptance。

---

# 10. Persistence、Transactions 与 Recovery

## 10.1 四层持久化语义

### A. Canonical State

表示现在真实有效的结构化事实：Project、Workspace、Responsibility、Work、Dependency、Policy、Permission、Deliverable、Resource Ownership 等。

### B. Append-oriented History

Event Journal 与重要通信历史，表示过去发生过什么，原则上不回头改写。

### C. Durable Knowledge / Artifact

Memory、Decision、Artifact、Verification Evidence、Checkpoint 等长期内容。

### D. Rebuildable Projection

Agent Tree、Project Overview、Transcript、Usage Aggregate、Search Index、Workspace Summary 等派生视图。

```text
Canonical state for truth
Append history for causality
Projection for convenience
```

## 10.2 Durable Event Journal

只记录已经提交、对恢复/审计/UI/未来行为有意义的事实。高频 Streaming delta 走 Live Event Stream，资源与性能数据走 Telemetry。

Event 至少具有稳定 Identity、Ordering、Causation / Correlation 语义。

Transcript 是 Human-readable Projection，不是系统真相。

## 10.3 Transaction boundary

一致性边界由领域 invariant 决定，而不是 API 调用或 Agent Turn 决定。

需要原子提交的典型操作：

- CreateProject；
- CreateChild；
- AssignWork；
- SelectCurrentWork；
- CompleteWork；
- CancelWork；
- Declare / Satisfy Dependency；
- Deliver；
- Change / Reclaim Responsibility；
- Grant / Revoke Permission；
- Start / Settle Execution。

Canonical State Change 与对应 Durable Event 必须处在同一可靠提交边界。

任何会让 `ResponsibilityDefinition / ResourceBoundary / ResourceOwnership` 在中间状态违反授权关系的治理变更，必须作为一个 semantic Governance Change 在单一事务中提交；不能依赖“先改 Responsibility、下一条命令再改 Boundary”的顺序约定。每个 committed state 都必须满足 `ResourceOwnership ⊆ ResourceBoundary`，且 Boundary 明确基于当前 Responsibility revision。

`CompleteWork` / `CancelWork` 若作用于当前 Work，必须在同一事务中同步清除 `Workspace.currentWorkId`，不能留下指向 terminal Work 的 current pointer。

对于由 active Execution 发起的 canonical mutation，Worker ownership/fencing 的权威校验必须与本次 mutation 处在同一原子提交边界；事务外的预检查只能用于快速失败，不能作为最终授权依据。

```text
Long process = short durable transactions
```

## 10.4 External side effect

外部 Tool 副作用不尝试与 Arbor 数据库实现虚假的分布式 ACID。

```text
Invocation Intent persisted
↓
External execution
↓
Settlement persisted
```

如果中间 crash，恢复时能够发现“Intent 存在但 Settlement 缺失”的悬挂动作。

Side-effect semantics：

- read-only → safe retry；
- idempotent → same invocation identity retry；
- reconcilable → query external reality；
- non-idempotent / unreconcilable → UNKNOWN + escalation。

## 10.5 Lease / Fencing

Execution identity 与 Worker identity 分离。

```text
Execution = durable
Worker = replaceable
```

每个 active main Execution 由带 Expiry 和 Generation/Fencing Token 的 Lease 暂时分配给 Worker。过期 Worker 即使恢复，也不能继续提交状态。

Fencing 保护的不只是 Execution 自身记录，而是所有由该 Worker/Execution 发起、会影响未来系统行为的 durable mutation。权威 generation check 必须与 canonical mutation 原子完成，避免 check-then-write 的 TOCTOU。

一个 Workspace 同时最多一个有效主 Execution。

## 10.6 Recovery

系统恢复顺序：

```text
1. Load Canonical State
2. Invalidate expired leases
3. Find unsettled Execution / Tool / Provider boundaries
4. Reconcile external reality
5. Settle deterministic outcomes
6. Escalate genuinely uncertain cases
7. Rebuild runnable set
8. Rebuild projections
9. Resume meaningful work only
```

核心原则：

```text
Recover reality before cognition.
Runtime failure != organizational change.
```

## 10.7 Durability Envelope

System Design 不把某一种数据库实现等同于耐久性保证。v1 必须声明并测试 deployment-specific Durability Envelope：process crash、Worker 丢失、Runtime restart、compute host reboot 等在 canonical storage 完整时可恢复；storage-media loss、region loss 等能力由部署的 backup/restore、复制策略和明确的 RPO/RTO 决定。超出已声明 envelope 的故障必须如实报告，不能承诺“自动恢复”。


---

# 11. Project Execution Environment

## 11.1 Workspace 与 Environment 分离

Workspace 是 Responsibility Space；Project Environment 是真实世界载体。

Project Environment 可以包含：

- filesystem / repository；
- Git；
- database；
- artifact store；
- compute / GPU；
- external services；
- credentials。

```text
Workspace != Directory
```

## 11.2 Environment View

```text
Responsibility
→ Resource Boundary
→ Workspace Environment View
→ Work Constraints
→ Execution Sandbox
```

Workspace 获得责任相关的 Environment View，Execution 再基于 View 和当前约束构造技术 Sandbox。

## 11.3 Git / Worktree

Git/worktree 只是 coding 场景的隔离策略，不是 Workspace identity 或 Arbor state source。

支持：

- Shared Repository Mode；
- Isolated Worktree Mode。

Child 创建不自动复制仓库；只有获得正式写责任、并发隔离确有价值时才需要独立 working environment。

## 11.4 Integration

Child 对局部正确性负责；Parent 对组合正确性负责。Coding 场景下 merge / rebase / integration verification 属于 Parent integration，而不是 Parent 越过 Child 直接修改其责任范围。

## 11.5 External Change Detection

用户/外部系统可能绕过 Arbor 修改真实 Environment。系统应将重要变化映射为 Resource Change，并执行：

```text
EnvironmentChanged
→ Impact Analysis
→ relevant Workspace update
→ Context update / new Work / Verification invalidation
```

Verification verdict 必须绑定具体 Artifact / Environment Version。

---

# 12. Projection 与 UI

## 12.1 Responsibility Tree 是主视图

用户全局默认看到：

- Workspace Name；
- Responsibility summary；
- Current Work；
- key Dependency；
- Verification summary；
- Usage summary；
- subtree Attention。

树回答“谁负责谁”，Dependency View 回答“谁需要谁”，Transcript 用于按需检查实际执行。

```text
Tree for governance;
graph for dependency;
transcript for inspection.
```

## 12.2 Status 是 Projection，不是领域状态

UI 可根据事实投影：正在执行、等待、可执行但未 admission、当前无事等标签，不反向要求 Domain 增加复杂 enum。

## 12.3 Attention

用户真正需要的是 Attention，而不是所有活动。

最少三级：

- Normal；
- Attention；
- Action Required。

深层 Attention 向上冒泡为 subtree summary，但不复制底层上下文。

典型 Action Required：

- human-required approval；
- unreconcilable side effect；
- Root-level Responsibility conflict；
- 系统无法在现有 Authority 下继续。

## 12.4 Workspace Detail

下钻 Workspace 后优先展示：

1. Responsibility / Boundary；
2. Current / Pending Work；
3. Current Execution summary；
4. Dependencies / Communication / Governance items；
5. Verification Mission / Verdict / Evidence；
6. Decisions / Memory / Artifact / Audit Timeline。

Transcript 作为按需调试视图，不作为 Workspace 首页。

## 12.5 User actions

UI 明确区分：

```text
Query | Steer | Stop | Governance Change
```

不使用一个模糊“给 Agent 发消息”入口承载所有控制语义。

---

# 13. Runtime Component Architecture

Arbor 采用：

```text
Stable Domain Core
+
Deterministic Runtimes
+
One Generic Agent Runtime
```

## 13.1 Domain Core

定义：

- Project；
- Workspace；
- Responsibility；
- Work；
- Dependency；
- Deliverable；
- Execution；
- Verification；
- Permission / Constraint；
- 核心 invariant。

不调用 LLM、不执行 Tool、不实现 Scheduler。

## 13.2 Workspace Runtime

负责：

- Create Child；
- Responsibility / Boundary；
- Work lifecycle；
- Parent / Child governance；
- Inbox / Effective Facts；
- Reclaim / Change Responsibility。

## 13.3 Agent Runtime

所有 Responsibility-bound 与 Execution-bound Agent 共用：

- Agent identity / binding；
- Context Construction；
- Model → Action → Observation loop；
- Tool / Organizational Intent；
- Completion Claim；
- Query / Report / Decision Request。

```text
One Agent Runtime; many controlled execution contexts.
```

## 13.4 Scheduler / Execution Runtime

负责 Runnable、Admission、one-active-execution、Lease、Fencing、Wake-up、fairness 和 worker coordination。

## 13.5 Communication Runtime

负责 Assign / Query / Report / Deliver / Dependency / Governance command 的可靠路由、Admission、Promotion、Inbox、Correlation 和 Causation。

## 13.6 Tool Runtime

负责 Resource Resolution、Authority、Permission、Admission、Sandbox、Side-effect execution、Settlement 和 Recovery。

## 13.7 Provider Runtime

负责 Model Catalog / Resolution、Provider Adapter、Auth、Streaming、Retry、Timeout、Cancellation、Canonical Provider Event 与 Usage Telemetry。

## 13.8 Verification Runtime

负责构造 Verification Mission、创建 Execution-bound Verifier、配置独立 Context / Tool、收集 Evidence、管理 Verification sub-execution 并产出 PASS / FAIL / UNKNOWN。

底层推理仍调用通用 Agent Runtime。

## 13.9 Persistence / Projection Runtime

Persistence 保存 Canonical State、Transactions、Event Journal、Artifact metadata、Session、Execution、Lease 与 History。

Projection 消费 State + Events，生成 Agent Tree、Overview、Dependency View、Transcript、Usage、Search、Workspace Summary 和 Attention。

## 13.10 组件关系

```text
                         User / UI
                            │
                            ▼
                     Projection Layer
                            │
                      Commands / Query
                            │
                            ▼
┌──────────────────────────────────────────────────┐
│                 Workspace Runtime                │
│ Responsibility / Work / Parent-Child / Inbox    │
└──────────────┬───────────────────────┬───────────┘
               │                       │
               ▼                       ▼
      Communication Runtime          Scheduler
               │                       │
               │                       ▼
               │                Execution Runtime
               │                       │
               └──────────────→ Agent Runtime
                                       │
                         ┌─────────────┼─────────────┐
                         ▼             ▼             ▼
                  Provider Runtime  Tool Runtime  Verification Runtime
                                                    │
                                                    └→ Agent Runtime
                                                       (Verifier)

All runtimes depend on:
Domain Core + Persistence/Event Journal
```

组件约束：

- Agent Runtime 不直接修改 Workspace Tree；
- Agent Runtime 不绕过 Tool Runtime 产生外部副作用；
- Scheduler 不解析长文本决定业务语义；
- Provider Runtime 不决定 Work 是否完成；
- Verification Runtime 不修改 Producer 正式结果；
- UI 只发 Command，不直接写数据库。

---

# 14. 系统不变量（System Invariants）

以下不变量属于 Arbor v1.1 的系统级冻结约束。

1. 一个 Project 默认只有一个 Root Workspace。
2. 每个非 Root Workspace 有且只有一个 Parent。
3. Main Agent 只是 Root Workspace 的 Responsibility-bound Agent，不是特殊 Agent 类型。
4. 一个 Workspace 正常情况下只有一个 Responsibility-bound 主 Agent。
5. Responsibility Tree 与 Dependency Graph 分离。
6. Workspace Parent 创建后不作为日常操作改变。
7. Child 不能自行修改自己的 Parent。
8. Parent 只能日常治理 Direct Children；Observability 可以覆盖整个 subtree。
9. Sibling 没有相互治理权。
10. 正式 writable responsibility/resource 原则上只有一个 Owner。
11. Parent governance authority 不等于 Child execution/write ownership。
12. 每个 committed state 必须满足 ResourceOwnership ⊆ ResourceBoundary，且 ResourceBoundary 明确基于当前 Responsibility revision；语义耦合的 Responsibility/Boundary/Ownership 变化必须原子提交，不能通过临时权限或危险中间状态改变长期责任。
13. Child delegation 不得放大 ancestor 没有的治理权。
14. 临时 Permission Grant 默认不可继续递归委托。
15. 一个 Workspace 同时最多存在一个有效主 Execution。
16. Execution identity 与 Worker identity 分离；Worker ownership 使用 Lease + Fencing。
17. Work 可以跨多次 Execution 持续存在。
18. 一个 Workspace 同时最多一个 Current Work；其余为 Pending Work。
19. Turn End 不等于 Execution End；Execution End 不等于 Work End。
20. No Runnable Work → No Model Call。
21. Message arrival 不等于 execution preemption。
22. Completion Claim 不等于 Work Completed。
23. Self-check、Formal Verification、Parent Acceptance 三者分离。
24. Verification PASS 不等于 Parent 一定有足够信息完成上层 Work。
25. Verifier 默认不修改 Producer 正式结果。
26. Verification verdict 必须绑定 Evidence 和特定 Artifact/Environment Version。
27. UNKNOWN 是一等 Verification 结果。
28. Session 不是领域 authority；必要时可重建。
29. Context 是 State/History/Knowledge 的投影，不是无限增长 Transcript。
30. Compaction 不承担保存领域真相。
31. Memory 属于 Workspace，不属于临时 Worker/Model instance。
32. Tool Visibility 不等于 Tool invocation authorization。
33. Permission 不得覆盖 Responsibility Ownership invariant。
34. External side effect 不与本地 DB 假装组成分布式 ACID。
35. Outcome Unknown 的 side effect 不盲目 replay。
36. Canonical state change 与对应 durable event 处于同一可靠提交边界。
37. Projection failure 不回滚已提交的 Domain transaction。
38. Scheduler / Projection / UI 不是事实源。
39. Runtime failure 不自动引起 Responsibility Tree 变化。
40. User Human Override 必须作为正式治理事实记录；跨层干预向治理祖先传播 Intervention Summary。
41. Responsibility-bound Agent 进入长期组织树；Execution-bound Agent 只进入临时 Execution Tree。
42. Dependency cycle + no runnable work 必须产生 Deadlock Attention，而不是永久静默等待。
43. Workspace 不等于 Folder、Git branch、Worktree 或 Sandbox。
44. Verification 不是纯 deterministic checks；checks 是 Agentic Verifier 的证据工具。
45. Usage / Cost 默认只观察，不默认形成执行 Budget hard limit。
46. Execution settlement 必须保留 technical outcome 与 semantic terminal result；`Yield`、`CompletionClaim`、Coordination completion 不得 durable 地混为同一不可区分结果。
47. Execution admission 固定 Session binding；Primary Session replacement 只影响未来 Execution。
48. Worker-originated canonical mutation 的 fencing validation 与 mutation 必须处于同一原子提交边界。
49. Deliverable 必须可追溯到 source Work revision；Acceptance 必须绑定 target Work revision + Verification。
50. Write ownership 以 canonical backing resource 的 overlap 为准，不以未解析的语法地址是否相同为准。
51. Workspace Parent immutable；跨父级责任重组通过 Successor/Lineage + Retirement 完成，不移动既有 Workspace Identity。
52. Retired Workspace 是 terminal，不能拥有 Active Child、Open Work、Active Main Execution 或 active write ownership。
53. Open Work 因外部条件暂停时必须有 durable WaitSpec；等待期间禁止模型轮询，Wait 注册必须防 lost wake-up。
54. Stop/Critical Steer 提交后禁止该 Execution 开始新的 effectful action；未解决副作用必须 Reconcile 或使 Execution 进入 OutcomeUnknown。
55. Dependency 除 Satisfied 外还可终结为 Withdrawn 或 Unfulfillable；不能让已知不可能满足的依赖静默永久等待。
56. Effectful Model decision 必须绑定 ControlBasis；关键控制 revision 已变化时旧决策不得执行。
57. 一次性高风险 Approval 必须绑定 exact normalized intent，并原子消费；参数/资源/控制基准变化后必须重新审批。
58. Runtime Safety Envelope 与用户 Cost Budget 分离；前者始终存在但不得自行 Cancel Work。
59. CompleteWork/CancelWork 若结束 Current Work，必须在同一事务清除 currentWorkId。
60. Durability guarantee 以声明的 failure envelope、backup 与 RPO/RTO 为准，不由具体数据库名称隐式推出。

---

# 15. S1–S4 架构审计结论

## 15.1 S1 正常推进

已覆盖：

- 用户与 Main Agent 高层讨论；
- 第一层责任划分；
- Responsibility Formation；
- Child Workspace 创建；
- Runnable 调度；
- Agent Loop；
- Context / Memory；
- Agentic Verification；
- Parent Acceptance；
- Integration / Deliver upward；
- Root milestone 与 User Acceptance 分离。

无结构性断链。

## 15.2 S2 用户监督与纠错

已覆盖：

- Responsibility Tree；
- subtree Attention；
- Workspace Detail；
- Query / Steer / Stop / Governance Change；
- Human Override；
- Intervention Summary 向治理祖先传播；
- 干预后 Agent 恢复自治。

无结构性断链。

## 15.3 S3 Agent 协作与异常

已覆盖：

- Parent / Child；
- Sibling Query / Dependency；
- Deliverable satisfaction；
- Permission / Responsibility conflict；
- Decision Request；
- Verification FAIL → 原 Producer 返工；
- repeated failure → Parent intervention / Reclaim；
- Dependency Deadlock Detection。

无结构性断链。

## 15.4 S4 长期连续与恢复

已覆盖：

- Workspace 长期静止；
- 旧责任再次进入；
- Session / Context Epoch；
- Worker Lease / Fencing；
- unsettled Tool Intent；
- Reality reconciliation；
- model/provider change；
- external Environment change；
- 局部恢复；
- Verification Execution 恢复。

无结构性断链。

## 15.5 审计补丁

系统设计最终额外冻结八条：

- **A1**：Root 普通内部 Work 由 Main Agent在 Verification 后接受；Project milestone 才要求 User Acceptance。
- **A2**：User 跨层 Human Override 向相关治理祖先传播 Intervention Summary。
- **A3**：Dependency Runtime 增加 cycle / deadlock detection。
- **A4**：长期 Responsibility Tree 与临时 Execution-bound Agent Tree 明确分离。
- **A5**：Execution settlement durable 保留 semantic terminal result，避免正常结束语义在 crash recovery 中丢失。
- **A6**：Execution admission 固定 Session binding；Primary Session replacement 不改变 active episode。
- **A7**：Worker-originated canonical mutation 的 fencing check 与 mutation 原子化。
- **A8**：Deliverable/Acceptance 增加 Work revision binding；write ownership 按 canonical backing resource 判断 overlap。

---

# 16. 下一阶段：详细实现设计

System Design v1.1 冻结后，下一阶段不再继续新增顶层概念，而应依次产出：

```text
System Design Specification
        ↓
Domain ADT / Entity / Value Object
        ↓
Command / Event / Service API
        ↓
Persistence Schema
        ↓
Module / Package Boundary
        ↓
Runtime Interfaces
        ↓
Development Phases
        ↓
Implementation
```

建议详细设计优先顺序：

1. Domain ADT 与不变量；
2. Command / Event 模型；
3. Workspace / Work / Execution API；
4. Transaction 与 Persistence Schema；
5. Scheduler / Lease / Fencing；
6. Agent Runtime Port；
7. Provider Runtime / Tool Runtime Port；
8. Verification Runtime；
9. Projection / UI Read Model；
10. 实施阶段与自举验证计划。

**System Design v1.1 到此冻结。**
