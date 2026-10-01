# Session / Context Runtime 收敛 — 治理决策草案

**状态：DRAFT / 等待人工治理**

**日期：2026-10-01**

**建议决策代号：SCRC-1…SCRC-12**

本文位于 `planning/proposals/`，不是冻结设计基线。本文不修改
`docs/design/**`，也不授权在治理采纳前改变 Session、Model Context、Provider
或 Tool 的持久合同。

## 1. 决策背景

近期 Agent Core 实现已经补入：

- Work / Responsibility Context；
- Session Observation Context；
- Inbox Context；
- 完整 Provider Request 的粗略预算；
- Tool Authority Resolver。

这些工作暴露出一个结构性问题：当前实现把多个来源在每个 Provider Turn 前重新
拼成 `PortableMessage[]`，但没有一个足够强的、可恢复的 **Session Timeline →
Model-visible Context** 合同。具体表现为：

1. Tool Observation 被降低为无 `callRef` 的 `role = tool + text`；
2. 未消费 Inbox 在每个 Provider Turn 重复变成 `user` 消息；
3. `contextEpoch` 在生产路径仍固定为零；
4. `NeedsCompaction` 没有执行 Compaction，而是结算为
   `SafetyStop("CompactionRequired")`；
5. `chars / 4` 粗估算承担了是否停止 Execution 的决定；
6. Responsibility / Work、对话、Inbox、Tool Observation 和控制信息之间缺少
   明确的“耐久事实、权威状态、模型投影”分层。

这不是简单的 Prompt 文案问题。它横跨 Session durability、Agent Loop、Tool
calling、Compaction、Provider portability 和恢复语义。

## 2. 外部实现调研结论

调研只采用公开的一手材料；Codex 内部未公开部分不作推断。

### 2.1 Codex

Codex 的公开实现呈现以下结构：

1. `ContextManager` 拥有有序 `ResponseItem` 历史，同时独立保存
   `retained_context`、history version、reference context 和 world-state
   baseline；模型历史与宿主权威事实不是同一个容器。
2. `run_turn` 在一次 application turn 内循环：模型产生 function call 时执行工具，
   把 output 作为下一次 sampling input；只有没有后续工具/输入时才真正结束。
3. 运行中输入先进入 queue，在安全的 sampling boundary 才被写入历史。
4. 自动 Compaction 可以发生在 pre-turn 或 mid-turn；完成后重建模型窗口并继续原
   pending turn，不把普通 context pressure 暴露为 Work/Execution 停止。
5. Tool Orchestrator 在模型之外拥有 approval、sandbox selection、attempt 和
   escalation/retry；Prompt 不是执行权限边界。

参考：

- [Codex ContextManager](https://github.com/openai/codex/blob/main/codex-rs/core/src/context_manager/history.rs)
- [Codex turn loop](https://github.com/openai/codex/blob/main/codex-rs/core/src/session/turn.rs)
- [Codex compaction](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs)
- [Codex Tool Orchestrator](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/orchestrator.rs)
- [OpenAI Agents SDK loop/state strategies](https://developers.openai.com/api/docs/guides/agents/running-agents)
- [OpenAI Compaction](https://developers.openai.com/api/docs/guides/compaction)

### 2.2 OpenCode

OpenCode 当前 V1 仍有较重的 `prompt.ts` 与历史重写实现；其 V2 正在显式收敛这些
问题。V2 的可取方向是：

1. Session 以耐久事件为事实来源，消息是 projection；live token delta 不伪装成
   durable event。
2. Tool Part 保留 `callID`、工具名、input、running/completed/error 状态和 output；
   pending/running call 在 Provider replay 前会被规范化为配对结果，避免 dangling
   tool call。
3. 自动 Compaction 在 Provider Turn 前估算完整模型可见请求；保留耐久全历史，
   只用 checkpoint 替换 active model representation。
4. Compaction 保留结构化 rolling summary 与有 token 上限的 recent tail，完成后
   重新执行原 pending turn；Provider overflow 只允许一次恢复性 compact/retry。
5. Instruction discovery/update 进入 Session history，有去重和 supersession 语义，
   不是每轮无条件重复注入。
6. Permission 使用 `action + normalized resource → allow | ask | deny`，在工具执行
   边界判定。

参考：

- [OpenCode V2 Session Specification](https://github.com/anomalyco/opencode/blob/dev/specs/v2/session.md)
- [OpenCode structured message/tool lowering](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/message-v2.ts)
- [OpenCode V2 Compaction](https://opencode.ai/v2/docs/compaction)
- [OpenCode V2 Instructions](https://opencode.ai/v2/docs/instructions)
- [OpenCode V2 Permissions](https://opencode.ai/v2/docs/permissions)

OpenCode V1 的具体历史 pruning、synthetic continue 和 monolithic prompt 实现不作为
Arbor 模板；本提案只采用其 V2 已明确的 durable event、typed tool item、safe
boundary、checkpoint 和 permission boundary 原则。

## 3. 对冻结 DID 的判断

本次调研不要求推翻以下冻结语义，反而确认它们应继续成立：

1. `SessionEntry = append-only local sequence`；
2. `ContextEpoch = monotonic local ordinal`；
3. `Checkpoint preserves cognition; Canonical State restores control`；
4. Compaction 是显式、可审计的 Provider 操作，不是不可见 hack；
5. `NeedsCompaction` 是 `TurnPreparation` 的正常 control result；
6. Pinned/Protected 固定内容本身装不进窗口时，`ContextUnsatisfiable` 是 typed E；
7. Tool 权限在 Runtime 执行边界生效，而不是由 Prompt 文本保证；
8. 外部/Tool/Child 内容默认是 DataOnly，不因进入 Context 获得指令 Authority。

当前偏差主要属于“冻结方向没有被生产实现闭合”，同时也存在 DID 尚未给出机械合同
的设计缺口：结构化 Session Item、Inbox promotion、tool call/result pairing、
Provider-native checkpoint portability 与 Agent Loop 内 Compaction 恢复。

## 4. 建议裁决总览

### SCRC-1 — Session Timeline 是认知连续性的耐久主干

采纳一个 provider-neutral、append-only 的 `SessionItem`/`SessionEntry` ADT。完整
Timeline 是审计与恢复事实；当前模型窗口只是其 projection，不反向成为 canonical
truth。

### SCRC-2 — Canonical Control State 与 Timeline 分离

Responsibility、Current Work、ResourceBoundary、Permission ceiling、Dependency、
Project rules 继续从 canonical repositories fresh resolve。它们不复制成“永久聊天
事实”；每个 sampling step 记录引用/版本快照，必要时发出 model-visible full
snapshot 或 delta。

### SCRC-3 — Provider 请求以结构化 Item 为中心

`PortableMessage { role, text }` 不再承担所有输入类型。新增 provider-neutral
`PortableInputItem` ADT，至少覆盖：

```text
Message
ToolCall
ToolResult
ContextUpdate
CompactionCheckpoint
AttachmentRef
```

Provider Adapter 负责 lowering。不能无损支持某种 Item 的 Adapter 必须显式声明
capability 或返回 typed incompatibility，不能静默转成普通文本。

### SCRC-4 — Tool Call / Result 必须稳定配对

每个 model-facing executable/control invocation 都必须有稳定 `callRef`。Tool Result
至少绑定：

```text
callRef
toolRef / actionKind
status = Succeeded | Failed | Denied | Interrupted | OutcomeUnknown
bounded model output
full result/artifact ref?
source ObservationRef
```

Tool Runtime 结算后先耐久写入结构化 Result，再允许 Agent Loop 继续。恢复不得构造
无来源的 `role = tool` 文本；dangling call 必须被恢复、明确中断或形成 typed terminal
result。

### SCRC-5 — Inbox 必须经历一次耐久 Promotion

Inbox 是 Workspace 间交付/通知队列，不是每轮 Prompt 数据源。建议原子合同：

```text
promoteInboxEntry(workspaceId, entryKey, targetSessionId, fence)
  → append SessionInput(source = InboxEntry(entryKey)) idempotently
  + mark InboxEntry consumed
```

这里的 `consumed` 表示“Session 已耐久接管并可重放”，不是“模型已经正确理解”或
“业务已经完成”。事务失败时保持未消费；重复 promotion 返回既有 Session sequence。

同一个 InboxEntry 不得在相邻 Provider Turn 中重复创建多个 user message。

### SCRC-6 — Steer 与 Queue 是不同交付语义

建议明确两类运行中输入：

- `Steer`：在当前 Agent Loop 的下一个 safe sampling boundary 提升；
- `Queue`：当前 drain/turn 结束后 FIFO 提升，默认一次提升一条并重新判断是否继续。

Parent/Child Report、Dependency Update、Governance Change 应按事件类型选择其中之一，
不能仅按“存在未消费 Inbox”统一注入。

### SCRC-7 — 每个 Sampling Step 捕获一致快照

在发 Provider Request 前一次性捕获 `AgentStepContext`：

```text
execution/turn identity
session + contextEpoch
canonical control refs/revisions
effective tool catalog
effective authority ceiling refs
model/deployment binding fingerprint
instruction source refs/revisions
input frontier
budget/usage basis
```

同一次 request 的 Context、工具可见性与后续 tool admission 必须能追溯到该快照。
真正执行 Tool/Control Action 时仍 fresh re-read ControlBasis 与 authority；StepContext
不是授权缓存。

### SCRC-8 — Compaction 是 Agent Loop 内部控制动作

`NeedsCompaction` 不 settle Execution，也不改变 Work lifecycle。Agent Loop 应：

```text
prepareTurn → NeedsCompaction(request)
  → durable Compaction ProviderTurn intent
  → run Summary or ProviderNative compaction
  → atomically persist checkpoint + new ContextEpoch
  → rebuild canonical control context
  → retry the same pending logical Agent step
```

Compaction ProviderTurn 的失败可以产生当前 Execution 的 typed failure/Attention，但
“需要压缩”本身不是 SafetyStop。

### SCRC-9 — 同时支持 Summary 与 Provider-native Compaction

显式 Compaction 操作可以有两种实现：

```text
Summary
  → Arbor 运行 compaction prompt/output contract
  → provider-neutral structured summary checkpoint

ProviderNative
  → 调用 provider compaction endpoint/capability
  → opaque checkpoint bound to ResolvedModelBinding fingerprint
```

Provider-native checkpoint 只有在 provider、deployment、protocol family、model 与
相关版本指纹兼容时才可继续使用。切换 binding 时必须回退到 durable Timeline +
Arbor Summary/recent frontier 重建；禁止把 opaque item 当作通用文本迁移。

### SCRC-10 — Budget 使用多级证据

建议预算证据优先级：

1. Provider 返回的真实 usage / input token accounting；
2. Provider/Model 专用 tokenizer 或 estimator；
3. Adapter 级结构化请求 estimator；
4. `chars / 4` conservative fallback。

预算必须覆盖完整模型可见请求：instructions、items、tool schemas、output reserve、
protocol reserve 与 provider overhead。达到软阈值触发 Compaction；Provider 返回
context overflow 且尚无 durable assistant/tool side effect 时，允许一次 overflow-
triggered compaction 后重建同一 logical step。第二次 overflow 正常失败，禁止无限
循环。

`ContextUnsatisfiable` 只用于不可压缩的 Mandatory/Pinned/Protected 内容在所有允许
model policy 下仍装不下；普通可压缩历史压力不得映射成该错误。

### SCRC-11 — Permission 不进入认知压缩

Model 可以看到当前可用 Tool Catalog 和必要的行为说明，但权限真相不从摘要、
对话或 Tool 文本恢复。执行时继续采用 Arbor 的：

```text
Parent-distributed capability ceiling
∩ Workspace ResourceBoundary
∩ active PermissionGrant/policy
∩ exact invocation resources
```

`list/read` 默认只读基线继续成立；`patch/shell/external/project control` 继续要求父级
显式分发/策略授权。这里不采纳 OpenCode“custom subagent 自带独立 permission，
不必是 parent subset”的语义。

### SCRC-12 — Durable Timeline 与 Active Model Window 分离

Compaction、truncation 和 progressive disclosure 只改变 active model representation，
不删除 durable Timeline、完整 Tool result 或 Artifact。被压缩的 Result 在模型窗口
中可以只保留 bounded summary + ArtifactRef + epistemic status，但审计/恢复仍能定位
原始结果。

## 5. 建议 ADT

名称可由人工治理调整；以下结构表达必须拥有的语义，而不是最终 TypeScript 语法。

```text
SessionItem =
  | UserMessage {
      source: HumanMessage | Steer | InboxEntry | RuntimeContinuation,
      contentRef,
      trust,
      authority,
    }
  | AssistantMessage {
      providerTurnId,
      contentRef,
      finishReason,
    }
  | ToolCall {
      providerTurnId,
      callRef,
      toolRef,
      argumentsRef,
    }
  | ToolResult {
      callRef,
      invocationId?,
      status,
      observationRef,
      modelOutputRef,
      artifactRefs,
    }
  | ControlResult {
      callRef,
      actionKind,
      disposition,
      canonicalRefs,
      observationRef,
    }
  | ContextUpdate {
      sourceRef,
      revision,
      updateKind: Full | Replace | Revoke,
      contentRef,
    }
  | CompactionCheckpoint {
      fromEpoch,
      toEpoch,
      implementation: Summary | ProviderNative,
      summaryRef?,
      opaqueItemRef?,
      bindingFingerprint?,
      retainedFrontier,
    }
```

`SessionItem` 是认知/执行连续性记录，不得承载 Domain canonical truth 的替代副本。
`ContextUpdate` 只表达某个权威来源在模型窗口中的投影与 supersession；执行仍读取
canonical repository。

## 6. Context Projector 边界

新增或明确一个纯/准纯 `ContextProjector`：

```text
Input:
  AgentStepContext
  Session active epoch/frontier
  latest completed checkpoint
  retained canonical source snapshots/deltas
  model capability + provider item capability

Output:
  PortableInputItem[]
  PortableToolDefinition[]
  ModelContextManifest
  BudgetEvidence
```

Projector 不读取权限后执行副作用，不消费 Inbox，不写 Session，也不调用 Provider。
Promotion、Compaction 和 Tool settlement 在各自 Runtime 边界完成后，Projector 只读取
已经耐久的结果。

同一个 `(sessionId, contextEpoch, inputFrontier, stepContextFingerprint)` 必须产生可重复
验证的 Manifest；Provider-specific lowering 可以不同，但必须记录 adapter/binding
fingerprint。

## 7. 与当前实现的处置

治理采纳后，建议按以下方式 forward-refactor，不回滚无关提交：

| 当前实现 | 处置 |
|---|---|
| `ToolAuthorityResolver` / `ControlBasisResolver` | 保留并加强；仍在 effect boundary fresh check |
| `WorkContextAssembler` | 保留 canonical source 读取；输出改接 StepContext/ContextUpdate projection |
| `SessionContextAssembler` | 以 typed SessionItem projector 取代，禁止生成无 callRef 的 tool text |
| `InboxContextAssembler` | 以 idempotent Inbox Promotion 取代 |
| `RequestBudgetPlanner` | 保留为 fallback estimator；不再单独决定停止 Execution |
| `PortableMessage` | 保留仅作为 Message variant 或兼容 facade；新增 PortableInputItem ADT |
| `NeedsCompaction → CompactionRequired` | 删除该 settlement 映射；接入 Compaction Coordinator |
| `contextEpoch = 0` | 接入 Session 当前 epoch 与 checkpoint persistence |

在治理采纳前，暂停继续给 `InboxContextAssembler`、`SessionContextAssembler` 和
`PortableMessage` 增加新的语义分支，以避免扩大迁移面。现有实现和测试保留为缺口
证据，不通过临时字符串约定掩盖问题。

## 8. 恢复与一致性要求

### 8.1 Inbox Promotion

- Session append 与 Inbox consumed 必须同事务或通过稳定 source key 原子收敛；
- crash 后重复 promotion 不产生第二个 SessionItem；
- Session 已 append、projection 尚未执行时，恢复只重做 projection/Provider step，
  不重新消费业务消息。

### 8.2 Tool Call / Result

- ToolCall 已耐久、Tool effect 未开始：按 Invocation 规则执行；
- intent 已耐久、effect outcome unknown：沿 P4 reconcile，禁止伪造 Result；
- Tool 已结算、Session Result 未写：按 invocation/resultRef 幂等补写；
- Result 已写、Agent Loop 未继续：下一 owner 从 Timeline 继续，不重跑 Tool。

### 8.3 Compaction

- Compaction started 但未完成：旧 epoch/frontier 继续有效；
- checkpoint completed 与 epoch advance 必须原子；
- completed checkpoint 后 crash：恢复直接重建相同 pending logical step；
- Summary/Native checkpoint 不得导致此前 durable tool side effect 重放；
- Provider-native binding 不兼容：不用该 opaque item，转为 portable rebuild；
- Compaction 自身 context overflow：允许有界缩短输入，仍失败则终止该操作，不循环。

## 9. 必须通过的验收矩阵

### 9.1 结构化 Item

1. ToolCall 与 ToolResult 按 `callRef` 一一对应；
2. 串行和并行多个 ToolCall 的输出不会串位；
3. pending/running ToolCall 在恢复后不会形成 provider dangling-call error；
4. Denied/Failed/Interrupted/OutcomeUnknown 都是明确 Result，不伪装成 assistant text；
5. 完整 Result 超限时，模型看到 bounded output + ArtifactRef + truncation status。

### 9.2 Inbox / Steering

1. 同一个 entryKey 最多 promotion 一次；
2. Provider repair/retry 不重复注入 Inbox；
3. Steer 在下一个 safe boundary 出现；
4. Queue 在当前 drain 结束后按 FIFO 一次提升一条；
5. crash 于 append/consume 任意边界后，重启仍只出现一个 SessionItem。

### 9.3 Compaction

1. pre-turn budget pressure → compact → 同一 pending step 继续；
2. mid-turn tool result 后 pressure → compact → 不重跑已完成 tool；
3. Provider overflow → 最多一次 compact/retry；
4. checkpoint completed 前 crash 使用旧 epoch；completed 后 crash 使用新 epoch；
5. canonical Responsibility/Work/Boundary 在 compact 后 fresh reinject；
6. Provider binding 切换不重放不兼容 opaque checkpoint；
7. fixed mandatory context 过大仍返回 `ContextUnsatisfiable`；
8. 普通 history pressure 不产生 `CompactionRequired` settlement。

### 9.4 Authority

1. Prompt/summary 声称有权限不能提升 Tool authority；
2. Tool 可见但执行时 authority 已撤销，必须 Denied；
3. Parent 未分发 `shell/patch` 时 Child 不可通过 Session text 获取；
4. Compaction 不改变 capability ceiling、grant expiry 或 ResourceBoundary。

## 10. 建议实施顺序

只有人工治理采纳并在拥有语义的设计文档落字后，才进入实现：

1. **S1 — Session Item Protocol**

   定义 typed SessionItem、PortableInputItem、callRef pairing 与 adapter capability。
2. **S2 — Durable Input Promotion**

   实现 Inbox/Steer/Queue safe-boundary admission、source-key 幂等与故障注入。
3. **S3 — Tool Timeline Closure**

   ToolCall/Result 结构化写入、ObservationRef/ArtifactRef、恢复 dangling call。
4. **S4 — StepContext + ContextProjector**

   捕获一致快照，分离 canonical control 与 active timeline projection。
5. **S5 — Compaction Coordinator**

   Summary path、epoch/checkpoint、same-step resume、overflow recovery。
6. **S6 — Provider-native Compaction**

   capability negotiation、binding fingerprint、opaque item storage/fallback。
7. **S7 — Budget Convergence**

   usage/tokenizer/adapter/fallback 多级证据与观测指标。
8. **S8 — Full Recovery / Qualification**

   故障注入、Provider conformance、`pnpm check` 和 dogfooding。

每一步先从本提案与治理落字写 failing test，再改生产代码；不得从当前字符串实现
反推测试要求。

## 11. 所需设计归属变更

人工治理若采纳本提案，至少需要由相应所有者更新：

- **System Design**：仅当需要新增/修改系统级不变量时，落 Session Timeline、
  Canonical Control、Active Model Window、Authority boundary 的关系；
- **DID / Model Context**：PortableInputItem、StepContext、Projector、预算证据、
  Summary/Native Compaction 与 binding compatibility；
- **DID / Session**：SessionItem ADT、source-key uniqueness、epoch/checkpoint 和
  projection frontier；
- **DID / Agent Runtime**：Steer/Queue safe boundary、NeedsCompaction 内循环、
  same logical step resume；
- **DID / Tool Runtime**：callRef pairing、Result persistence、Artifact/ObservationRef；
- **DID / Provider Runtime**：native compaction capability、opaque item、overflow retry；
- **P9/P12 recovery/safety contracts**：promotion、tool settlement、checkpoint 的 crash
  windows 与 bounded retry。

若人工治理判断 `PortableMessage`、SessionEntry 或 Compaction ProviderTurn 的冻结
合同无法容纳这些语义，应先登记 Design Gap 并修改拥有语义的文档；Coding Agent
不得直接改写冻结文档或用兼容字段静默改变语义。

## 12. 明确不做

本提案不引入：

- 把完整 canonical repositories 复制进 Session；
- 用 Session summary 恢复权限或业务真相；
- 每轮全量重放所有 Inbox/Dependency/Child report；
- 无限制保留 raw Tool output 在模型窗口；
- Agent 自己决定扩大权限；
- 仅为模仿 Codex/OpenCode 而引入 Guardian、plugin hook 或其产品专属对象；
- 因 Compaction 创建新 Work、取消 Work 或改变 Verification/Acceptance；
- Provider overflow 的无限 compact/retry；
- 为迁移方便静默接受无 `callRef` 的新 Tool Result。

## 13. 建议裁决

建议接受 SCRC-1…SCRC-12 作为一个不可拆分的 Runtime 收敛方向：

```text
Durable Session Timeline
+ Fresh Canonical Control Snapshot
+ Typed Tool Call/Result
+ Safe Input Promotion
+ Explicit In-loop Compaction
+ Provider-aware Budget Evidence
```

单独修补 `InboxContextAssembler`、增大 `SESSION_CONTEXT_ENTRY_LIMIT`、继续扩展
`PortableMessage.role`、延长 Context Window，或把 `CompactionRequired` 交给用户重试，
都不能关闭本缺口。

建议人工治理接受口令：

```text
ACCEPT_SESSION_CONTEXT_RUNTIME_CONVERGENCE
```
