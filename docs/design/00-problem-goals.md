# Arbor Problem Definition & Goals

**Version:** 1.2  
**Status:** FROZEN — problem and goal baseline  
**Date:** 2026-09-19  
**Position in document chain:** Problem & Goals → Scenarios → System Design → Detailed Implementation Design  
**Owns:** problem statement, P1–P8, root tensions, mission, G1–G8, goal-level success criteria  
**Does not own:** scenario flow, domain model, Runtime/component design, persistence/API/package/implementation contracts

---

## 0. 文档定位

本文是 Arbor 设计文档体系的起点，只回答两个问题：

1. **为什么 Arbor 需要存在：现有 Agent / Subagent 工作模式在什么条件下失效？**
2. **Arbor 要达到什么目标：用户最终应该怎样控制一个长期、多 Agent、可验证、可恢复的工作系统？**

本文不定义具体场景流程、领域对象、数据库、Runtime、Prompt、Effect API 或实现技术。后续文档必须能够向上追溯到本文的问题与目标；如果某项设计不能解释它解决了这里的哪一个问题或支撑了哪一个目标，则默认不应成为顶层设计。

### 0.1 文档所有权与下游约束

本文是文档链中 **WHY / WHAT** 的唯一权威来源。后续文档可以引用 `P1–P8`、`G1–G8` 和本文的成功判据，但不得为了局部实现方便在下游重新定义问题或目标。

变更归属遵循：

```text
问题边界 / 目标状态变化
→ 修改本文

“现实工作如何发生”的端到端行为变化
→ 修改 Scenarios

领域语义 / Runtime / 系统不变量变化
→ 修改 System Design

API / ADT / Effect / SQL / Package / 实现闭合变化
→ 修改 Detailed Implementation Design
```

下游若发现现有目标无法同时满足，应回到本文提出目标层变更，而不是在实现文档中静默改写 G1–G8。

---

# 1. 问题定义

## 1.1 背景

当前大模型 Agent 已经可以调用工具、修改环境，并进一步调用 Subagent。对于短期、边界清楚、一次性完成的任务，这种模式已经非常有效。

但当工作变成长生命周期、多抽象层级、可并行、反复返修且结果风险较高时，单次会话与临时 Subagent 的组织方式开始失效。问题不再只是“模型能不能完成某个动作”，而是：

- 谁长期负责什么；
- 每个 Agent 应该知道多少；
- 工作如何在层级之间继续分解；
- 不同责任块如何协作和等待；
- 结果如何独立验证；
- 用户如何只管理高层而不成为多 Agent 的人工调度器；
- 进程、模型、工具或机器故障后，系统如何继续而不是重新开始。

因此，Arbor 要解决的不是“增加一个更强的 Subagent API”，而是一个**长期复杂工作的组织与执行问题**。

## 1.2 核心问题陈述

> **怎样把长期复杂工作组织成一组具有稳定责任、局部上下文、独立执行能力、可协作关系、可验证结果和可恢复运行语义的 Agent 单元，同时让用户主要承担高层目标、组织变动与纠错，而不必亲自管理每一级 Prompt、Subagent、测试、重试和日常协调？**

Arbor 的第一验证场景可以是软件工程，但该问题并不限定于 coding。凡是具备长期责任、局部知识、阶段性工作、跨单元依赖、结果验证和治理需求的复杂知识工作，都属于同一问题范式。

## 1.3 目标工作的典型特征

Arbor 主要面向同时具备以下若干特征的工作：

1. **时间长**：持续数天、数周甚至数月，而不是一次模型调用或一个下午结束。
2. **会反复进入**：一个责任区域今天完成阶段性工作，未来仍会返修、演化和接收新工作。
3. **天然可分解**：存在多个相对独立但存在接口、信息或产物关系的责任块。
4. **存在并行价值**：完全串行交给一个 Agent 会显著降低推进效率。
5. **依赖复杂**：不同责任块存在数据、产物、事实、决策和时序依赖。
6. **上下文巨大**：整个项目的信息远大于任何单个 Agent 每次真正需要的局部信息。
7. **结果风险高**：不能把执行者自己的“完成”声明当成结果已经成立。
8. **目标会演化**：执行过程中会发现新事实、暴露旧假设、修改局部 Work 并产生新的责任或依赖。
9. **运行会被打断**：Worker、Provider、Tool、进程和机器故障属于正常长期运行条件，而不是例外假设。
10. **需要治理**：部分变化可以局部自治，部分变化必须由 Parent 或用户进行正式决策。

---

## 1.4 现有工作模式的主要缺陷

### P1. 委派过薄：Subagent 是临时劳动力，不是稳定责任单元

常见调用近似：

```text
Main Agent
→ “你去做 X”
→ Subagent 执行
→ 返回结果
→ 回收
```

一次任务说明通常不足以承载长期责任边界、上下文入口、资源范围、协作关系、质量要求和后续返修责任。Subagent 因而更像一次性任务执行器，而不是“长期负责这一块”的组织单元。

### P2. 责任与认知没有连续性

第一次由某个 Agent 建立的局部认知，在任务结束后常随会话一起消失。未来再次修改同一区域时，新 Agent 需要重新读取材料、重建背景、重新识别隐含约束。

```text
局部认知已经形成
→ Agent / Session 生命周期结束
→ 新 Agent 再次读取与理解
→ 重复消耗 + 新的误解风险
```

问题不只是 Token 成本，而是长期责任没有稳定承载体。

### P3. 多层分解缺少稳定组织语义

Agent 可以继续调用 Agent，但“为什么拆、拆到哪里、谁长期负责什么、什么时候应该只开一个临时 Specialist”往往仍靠即时 Prompt 判断。随着层级加深，容易出现：

- 同一责任被多个 Agent 重复承担；
- 临时任务被错误升级为长期组织；
- 长期责任被错误当成一次性 Subtask；
- 责任关系与依赖关系混在一起；
- 父级无法判断哪些下级事实值得长期关注；
- 上下文沿调用链不断复制扩散。

### P4. 上下文被当作“越多越好”，而不是受控认知资源

传统 Agent 常把历史会话、工具输出、文件内容、项目规则与当前任务不断累加到 Prompt 中。长任务因此逐渐出现：

- 无关历史挤占关键控制信息；
- 旧事实与新事实同时存在；
- 不同 Agent 复制大量重复上下文；
- Tool 输出和 Artifact 原文无限膨胀；
- Compaction 后权威约束与认知摘要混在一起。

即使模型拥有很大的 Context Window，噪声、过时信息、成本、延迟和注意力分散仍然存在。

### P5. 用户被迫承担微观组织与 babysitting

为了让复杂 Agent 系统继续推进，用户常需要亲自：

- 定义和启动大量 Subagent；
- 重复提供上下文；
- 手工规定每层边界；
- 逐个 Agent 追问“做到哪了”；
- 反复发送“继续”“再测一下”“修复后再检查”；
- 手工判断何时创建下一级 Agent；
- 日常协调权限、依赖、冲突和重试。

这意味着系统仍然依赖用户作为人工 Scheduler 和组织管理器，而不是让用户处于真正的高层控制位置。

### P6. 全局可观察性与局部干预能力不足

长期多 Agent 工作需要回答：

- 当前有哪些长期责任单元；
- 每个单元的 Current Work 是什么；
- 哪些 Work 被依赖阻塞；
- 哪些结果 Verification 失败；
- 哪些地方存在 Attention；
- 哪些子区域正在并行推进；
- 哪里需要用户真正介入。

线性聊天线程天然不适合表达这种长期、树形、可下钻的责任结构。

### P7. 执行、验证与接受没有充分分离

现有 Agent 常见模式是“自己做、自己测、自己宣布完成”。已有测试脚本能发现一部分错误，却不能替代独立判断。例如仍可能遗漏：

- 未覆盖的 requirement；
- 架构边界破坏；
- 替代解释；
- 边界案例；
- 数据泄漏或实验设计错误；
- 产物虽然局部正确，但不能支撑 Parent 的上层目标。

因此，Producer 的自检不能等价于独立 Verification，Verification PASS 也不能自动等价于 Parent 已经接受该结果。

### P8. 长期运行中的“真相、现实、认知与信任”容易混在一起

聊天历史、模型记忆、工具结果、文件、数据库状态、外部服务以及其他 Agent 的消息可能同时描述“当前发生了什么”。如果没有明确区分：

- 什么是权威事实；
- 什么只是 Agent 的当前认知；
- 什么只是某一 Turn 对事实的有限投影；
- 外部副作用是否真的发生；
- 某段内容来自哪里、是否可信、是否只是数据；
- 某段外部内容是否有资格影响指令、权限或长期 Memory；

那么除崩溃、重试和恢复错误外，还会出现 indirect prompt injection、恶意 Tool/Artifact 内容进入认知、未验证信息被长期记忆化、Child/外部内容越权影响控制语义等问题。

长期 Agent 系统必须能够同时维护**组织真相、现实一致性、认知连续性与信息信任边界**。外部或派生内容默认是数据，不因被检索、重复出现或由另一个 Agent 转发就自动获得指令权威或长期记忆资格。

---

## 1.5 根本矛盾

以上问题可以归结为三个结构性矛盾。

### A. Task / Conversation 生命周期太短，Responsibility 生命周期太长

现实中的责任会跨越很多次任务和执行，但现有 Agent 的主要承载体往往是一次 Task、一个 Thread 或一个 Session。

### B. 模型善于语义判断，但不适合单独承担权威状态与硬约束

Prompt 可以指导 Agent，却不能可靠替代权限、资源边界、事务、一致性和恢复协议。

### C. 用户需要的是治理复杂系统，而不是亲自编排每一步执行

用户真正需要控制的是高层目标、重要责任划分、重大变更和异常纠错，而不是每次 Tool Call、每一级 Subagent 和每个测试循环。

---

## 1.6 Arbor 的使命

> **构建一个以长期 Responsibility / Workspace 为组织核心的多 Agent 工作系统：让稳定责任承载长期认知，让阶段性 Work 驱动执行，让独立 Verification 建立结果可信度，让 Runtime 维护权威状态、权限与现实一致性，并让用户始终能够在高层观察、下钻和纠错。**

这个使命不要求 Agent 永久在线，也不要求系统把所有工作拆成更多 Agent。系统应在“长期组织价值”高于“分解与协调成本”时才形成新的责任单元；没有 Runnable Work 时，长期 Agent 可以完全停止模型调用。

---

## 1.7 期望的用户工作模式

正常情况下，用户主要与一个 Main Agent / Root Workspace 交互。

```text
User ↔ Main Agent
        ↓
长期责任组织自主展开
        ↓
局部 Agent 独立执行 / 协作 / 验证
        ↓
用户主要看全局与异常
```

用户主要负责：

- 给出和修改高层目标、边界与约束；
- 参与第一层重要责任划分及重大组织变更；
- 作出跨责任边界或高影响的方向决策；
- 对高风险动作进行必要审批；
- 通过全局视图监督系统；
- 必要时下钻到任意 Workspace 进行 Query、Steer、Stop 或 Governance Change。

用户不应被迫负责：

- 手工设计每一级 Subagent；
- 每次重新解释某块长期责任的背景；
- 日常权限协调；
- 逐个 Agent 维持“在线”；
- 普通测试和 Verification 的逐次触发；
- 常规依赖等待、局部恢复和可安全处理的异常；
- 为每个 Agent 编写一套临时 Prompt 才能让系统正常工作。

---

## 1.8 Non-goals

Arbor 的目标不是把所有工作流程都显式化。当前明确不追求：

- 把系统做成 Jira / Kanban / Sprint 管理器；
- 为每个小 Task 创建 Workspace；
- 让所有 Agent 自由互聊，并把聊天记录当作系统权威状态；
- 用大量显式生命周期状态维持 Agent“常驻”；
- 让 Workspace 等价于目录、Git branch、worktree、Session 或进程；
- 为 Main Agent、Subagent、Verifier、Query Agent 分别实现互不兼容的 Agent Runtime；
- 默认使用 Token / Cost Budget 强行终止工作；Usage / Cost 首先是可观察指标；
- 把 deterministic rule engine 当作完整 Verification；
- 依赖纯 Prompt 保证责任边界、权限或现实副作用一致性；
- 追求“Agent 数量越多越好”或“所有工作都并行”。

---

# 2. 系统目标

## G1. 高层控制、低层自治

用户控制项目的高层目标、第一层重要责任划分和重大治理变化；更深层的工作分解、局部执行、普通协作、自检、Verification 与常规异常处理应主要由系统自主完成。

**目标状态：** 用户不再充当多 Agent 系统的人工 Scheduler，而是作为 Governor / Supervisor 参与真正需要人类判断的层级。

## G2. 长期责任与认知连续性

同一块长期责任应拥有稳定 Identity。阶段性 Work 完成后，责任单元不随任务结束而销毁；未来再次进入时应继承经过整理的局部知识、决策、上下文入口与历史证据，而不是从零重新理解整个项目。

**目标状态：** 长期存在的是 Responsibility，而不是一个永久占用计算资源的进程。

## G3. 动态、递归但受治理的多 Agent 组织

系统不预先硬编码完整 Agent 树。组织结构应根据真实工作逐步形成：简单问题保持在当前 Workspace，短期专业调查可以使用临时 Execution-bound Agent，只有稳定、独立、长期有价值的 Responsibility 才形成 Child Workspace。

**目标状态：** 系统不是“切碎 Task”，而是识别值得长期独立承担的责任簇。

## G4. 全局可观察、局部可下钻、异常可聚合

用户应能够从 Project Overview / Responsibility Tree 看到整个项目的责任结构、Current Work、Dependency、Verification、Usage 和 Attention，并能够从全局逐层进入任何 Workspace 查询、干预或治理。

**目标状态：** 正常工作不需要用户逐节点巡检；只有值得关注的状态向上聚合。

## G5. 自动质量闭环与独立验证

Producer 自我检查只作为第一层质量控制。正式结果应经过独立 Agentic Verification，能够主动寻找反例、缺失证据和替代解释，并输出 PASS / FAIL / UNKNOWN。即使 PASS，Parent 仍负责判断该结果是否足以支撑上层 Work。

**目标状态：** “Agent 说完成了”不再等价于“结果已经成立”。

## G6. 局部上下文、高效认知、可控 Prompt / Context 与信息信任

系统应围绕责任和当前 Work 选择模型真正需要的局部信息，而不是复制整个项目历史。长期 Session、Checkpoint、Recent Frontier、Memory、Artifact progressive disclosure、Skill 和结构化 Model Context 应共同减少重复理解、无关信息和上下文污染。

Context 还必须保留来源与信任语义：外部检索、Tool Observation、Imported Artifact、Child Report、模型派生结论等不能仅因为进入 Context 就获得控制权；“数据”“候选指令”“正式指令”“未验证事实”“已建立事实”必须可以区分。长期 Memory 的形成也必须保留 Provenance，并经过显式的持久化资格判断。

**目标状态：** Context 足够且相关，而不是最大化；Prompt 是行为控制的一部分，但不承担硬权限与权威状态；不可信内容可以被理解，但不能通过文本本身提升自己的 Authority、Capability 或 Persistence。

## G7. 可恢复、现实一致且具有明确耐久边界的长期运行

Worker、Provider、Tool、Runtime 或计算节点故障不能使项目退回“从聊天记录重新开始”。恢复必须以 Durable State 和外部现实一致性为中心；外部副作用结果未知时，必须先 Reconcile，再决定是否重放。

Arbor 必须显式声明其 Durability Envelope：进程崩溃、Worker 丢失、Runtime 重启和计算节点重启属于正常可恢复条件；Canonical Storage 本身的介质丢失、区域级故障等是否可恢复，取决于部署时声明并验证的备份/恢复能力与 RPO/RTO，不能由“使用了 SQLite/PostgreSQL”这种实现选择隐式保证。

**目标状态：** 先恢复 Reality，再恢复 Cognition；长期 Agent 不等于长期运行的进程；系统对自己能承受的 failure domain 有明确且可测试的声明。

## G8. 默认可用、允许配置、成本透明但不默认绑架执行

系统应提供足够好的默认策略，使用户无需在开始前手工配置大量 Agent、Prompt、模型、权限与测试流程；同时允许在需要时配置模型、Provider、权限、Verification Profile、执行资源、Prompt/Skill 和 Cost Guardrail。

Token、Cost、Tool Calls、Wall Time 等首先作为 Usage 指标对用户透明，不默认成为隐藏的用户 Budget 限制。只有用户显式配置时，才形成基于业务预算的 warn / ask / stop 等约束。

这不等于允许无限重试、递归 Tool 调用或无进展循环。Runtime 必须始终具有独立于用户 Budget 的 Safety Envelope，用于限制重复失败、递归深度、无进展执行、并发与异常消耗；触发 Safety Envelope 只停止/中断当前 Execution 并产生 Attention，不自动改变 Work 的治理生命周期。

---

# 3. 问题—目标追踪

| 问题 | 主要目标 |
|---|---|
| P1 委派过薄 | G2, G3 |
| P2 责任与认知不连续 | G2, G6 |
| P3 多层分解缺少组织语义 | G1, G3 |
| P4 Context 不受控 | G6 |
| P5 用户承担微观组织 | G1, G4, G8 |
| P6 全局可观察性不足 | G4 |
| P7 执行/验证/接受混在一起 | G5 |
| P8 真相、现实、认知与信任混淆 | G7，并横切 G2/G5/G6 |

任何后续场景、领域对象或 Runtime 都应能够沿这张关系表向上解释其存在理由。

---

# 4. 目标层面的成功判据

本文不规定实现测试，但定义几个系统级判断标准，用于后续场景和设计是否偏离目标：

1. **用户可以停留在高层。** 正常推进不要求用户持续发送“继续”、手工选择每一级 Agent 或逐个触发测试。
2. **Responsibility 在 Work 之间保持连续。** 阶段性任务结束不意味着对应责任和局部知识被销毁。
3. **多 Agent 组织是必要时生长，而不是默认膨胀。** 简单 Work 不因系统具备 Subagent 能力而被强制拆分。
4. **无 Runnable Work 时没有持续模型调用。** 长期 Agent Identity 与计算进程解耦。
5. **正式完成建立在证据上。** Producer self-check、独立 Verification 和 Parent Acceptance 具有不同语义。
6. **故障不会把项目退回“重新读聊天记录”。** Canonical State、Durable Runtime State 与 Cognitive Continuity 可以恢复。
7. **用户能解释系统为什么这样做。** 责任、Work、Decision、Verification、Dependency 和重要外部副作用具有可追踪来源。
8. **Prompt 不是安全边界。** 即使模型行为偏离，高影响 mutation 和 Tool side effect 仍受 Runtime / Permission / Resource Boundary 约束。
9. **成本和使用量透明。** 系统提供 Usage 指标，但除非用户明确配置，不因隐含 Budget 自动改变治理语义。
10. **不可信信息不会自我升级。** 外部内容、Tool Observation、Child Report 与模型派生文本不会仅凭文本内容获得更高指令 Authority、写权限或长期 Memory 资格。
11. **耐久边界是显式合同。** 系统明确声明并测试 process/worker/host/storage 等 failure domain，以及超出范围时所依赖的备份、RPO 与 RTO。
12. **安全停止独立于用户 Budget。** 即使用户没有配置成本上限，Runtime 仍能阻止无限重试、递归调用和长期无进展循环，而不擅自 Cancel Work。

---

# 5. 与后续文档的关系

本文件只定义 **WHY** 与 **目标状态**。

后续文档按以下链路逐步回答 HOW：

```text
Arbor Problem Definition & Goals
        ↓
Arbor Scenarios S1–S4
  用端到端场景证明目标如何发生
        ↓
Arbor System Design Specification
  定义系统级责任、领域语义与 Runtime 边界
        ↓
Arbor Detailed Implementation Design
  定义可实现的对象、接口、持久化、Effect/Failure/Model Context 等细节
        ↓
Pre-implementation Closure
  继续消除当前可以通过推理确定的实现不确定性
        ↓
Implementation
```

因此，后续任何设计若需要改变本文的核心问题或 G1–G8，应视为**目标层变更**，而不是普通实现细节调整。
