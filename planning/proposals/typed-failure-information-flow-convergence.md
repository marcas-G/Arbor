# 类型化失败与 Agent 信息流收敛

**状态：COMPLETE — Waves 1–5 landed**

**依据：** DID §6A、§6A.7、§6A.8；System Design ToolCall/ToolResult、
Runtime Safety 与 Attention 约束。本文件只整理并执行既有冻结语义，不修改
`docs/design/**`。

## 1. 核心判断

“发生了错误”不是一个足够的分类。对 Agent 系统真正重要的问题是：

```text
这个事实能否帮助当前 Agent 选择下一步动作？
```

除非当前 Agent 已经无法安全继续，否则失败应优先成为有来源、有边界、可持久化
的信息，而不是抛出异常终止 Agent fiber。

这不意味着把所有原生异常直接塞进 prompt。模型只能接收经过语义边界翻译、脱敏
且有明确行动含义的信息。

## 2. 四条信息通道

### 2.1 Model-usable result（`A` 中的正常替代结果）

Agent 可以根据它修改计划或参数：

- shell 非零退出；
- 测试失败、编译失败；
- 文件不存在、patch 冲突；
- 工具参数不合法；
- action 当前不适用、目标不可用；
- authority / permission / resource denial；
- Dependency 尚未满足；
- Verification 证据不足。

这些结果写入带稳定 `callRef` 的 `ToolResult` / `ControlResult`，至少包含：

```text
status
safe code
bounded safe message
correction / next-action hint
observationRef
artifact/canonical refs（如适用）
truncated / epistemic status
```

### 2.2 Runtime-recoverable failure（窄 `E`）

当前模型不能直接修复，但 Runtime 有明确策略：

- Provider 限流或暂时不可用；
- transient transport failure；
- SQLite busy / 临时不可用；
- semantic revision conflict；
- lease / fencing loss；
- stale decision basis；
- context overflow / bounded output repair。

必须由 operation-context 的纯分类器映射到 `FailureDisposition`：retry、backoff、
reload/re-evaluate、wait、reconcile 或 settle。原生 cause 不进入模型。

### 2.3 Stable settlement / Attention

当前 Execution 无法安全继续，但事实仍然有产品价值：

- retry / repair 已耗尽；
- authentication / quota 等部署问题；
- Runtime Safety stop；
- cancellation；
- unresolved external side effect；
- reconciliation required。

它们成为 typed `ExecutionSettlement` / Attention，不自动取消 Work。必要时新的
Execution 可以在外部状态改变后继续。

### 2.4 Defect / Cause

仅限理论不可能状态或程序损坏：

- schema/invariant corruption；
- handler 收到错误的内部 ADT 分支；
-同一 durable source 出现不同内容；
- frozen route registry 自相矛盾。

Defect 不交给模型猜，也不得伪装成 `ExpectedFailure`。

## 3. 当前实现审计

### 已正确贯通

- `ToolInvocationSettlement` 已区分 Success、ExpectedFailure、Interrupted、
  OutcomeUnknown、RuntimeFailure；
- shell exit、filesystem error、patch conflict 已成为 bounded observation；
- Denied / Failed ToolResult 经 Session Timeline → ContextProjector → Provider
  renderer 回到下一轮模型；
- ModelOutput contract violation 已有 bounded repair；
- Provider failure taxonomy 与 phase timeout 已类型化；
- OutcomeUnknown 保持独立，不被降级成普通失败。

### 已发现的主要问题

生产源码中仍有 55 个文件、97 处 `cause: unknown`。它们并非全部错误：native
cause 可以存在于最内层 operational failure，但以下热路径存在语义坍缩：

1. 旧 `AgentActionError { cause: unknown }` 混合模型可修正拒绝与基础设施故障；
2. `InvalidControlArguments` 被升级成 RuntimeSafetyStop；
3. executable/control handler 的所有 Effect failure 曾统一变成 HandlerRejected；
4. `ToolRuntimeError` 仍把 catalog、environment、authority、sandbox、journal 与
   executor failure 压成一个 unknown cause；
5. `ExecutionDriverError` 仍吞并 Session、repository、provider terminal failure 与
   invariant conflict；
6. repository port 多数只区分 RevisionConflict 与通用 Failure，尚未完整翻译
   PersistenceUnavailable / Corruption；
7. 若干 `Effect.orDie` 位于 cleanup、consumer 和 production 读取路径，需要逐项
   证明是真 defect，不能仅因调用方便而 die。

## 4. Wave 1 — Agent action feedback（已实现）

- `InvalidControlArguments` → durable `ControlResult(status=Failed)` → 下一轮；
- `AgentActionRejected` 携带 safe code/message/correction，作为 Model-usable result；
- `AgentActionOperationalFailure` 保留 operation + native cause，仅 Runtime 可见；
- action ledger 保存 disposition，失败仍保持 call/result pairing；
- handler dispatch invariant 与 blob round-trip mismatch 保持 operational/defect
  路径，不投影原始 cause；
- unknown route / registry mismatch 仍 fail-closed。

## 5. 后续收敛波次

### Wave 2 — Tool Runtime error algebra（已实现）

拆分 `ToolRuntimeError`：catalog unavailable、environment resolution failure、authority
resolution failure、sandbox open/close failure、intent journal failure、executor
operational failure。逐项决定 ModelResult / retry / reconcile / settlement；去除
`sandbox.close(...).orDie` 的无条件升级。

实现结果：

- `ToolRuntimeOperationalFailure` 保存确切 pipeline stage；
- `ToolRuntimeCleanupFailure` 单独表达 SandboxClose；
- 每个失败携带 `NotStarted | OutcomeUncertain`，调用者不再解析 native cause；
- Executor / SettlementJournal / SandboxClose 的不确定结果收敛为
  `OutcomeUnknown(ReconciliationRequired)`；
- pre-effect operational failure 留在 Runtime，禁止伪装成模型 ToolResult；
- executor 已产生的 ExpectedFailure / Denied 仍走正常 observation 通道；
- 删除 ToolRuntime 中的 `Effect.orDie` cleanup 路径。

### Wave 3 — Execution Driver error algebra（已实现）

拆分 `ExecutionDriverError`，让 Provider terminal failure、Context failure、Session
conflict、lease loss、persistence unavailable 和 invariant defect 不再共享 unknown
cause。所有可结算路径先持久化 SettlementProposed。

实现结果：

- `ExecutionDriverOperationalFailure` 按 ModelCapability、LoopStepStore、Inbox、
  ControlBasis、Conversation、Session、Workspace、Work、TurnProfile、ModelContext、
  Compaction、ProviderTurnStore 等 stage 分类；
- lease/fencing → `ExecutionDriverOwnershipLost`，旧 worker 不普通重试；
- Session timeline、AgentLoopStep、Provider replay、Context assembly、driver
  contract → `ExecutionDriverInvariantFailure`；
- Provider terminal failure / timeout / binding mismatch、ContextUnsatisfiable、
  GovernanceBlocked、CompactionNoGain → typed settlement；
- settlement 在返回前写入 AgentLoopStep `SettlementProposed`；
- 修复 `ContextUnsatisfiable` 被 `ModelContextError` 二次包装的真实边界缺陷。

### Wave 4 — Repository / Application translation（已实现）

Adapter 原生 SQL/IO 错误在 Port 边界翻译为 revision/fencing/conflict/unavailable/
corruption。Command terminal rejection 保持 durable receipt，并按 action context 决定
回流模型还是重新评估。

实现结果：

- 删除 `${Tag}Failure { cause }` repository 模板；
- SQLite `UniqueViolation / ConstraintError` → 无 native cause 的
  `PersistenceConstraintViolation`；
- connection/lock/IO 等 → `PersistenceUnavailable(repository, operation,
  retryDisposition, sourceTag)`；
- persisted decode/invariant 问题拥有 `PersistenceCorruption`；
- Permission、HumanMessage、Conversation、AgentLoopStep、ToolInvocation、Artifact
  等特殊 store 与通用 Repository 使用同一代数；
- Application 不再读取 `SqlError.cause` 判断业务冲突；
- CommandGateway 对 retryable persistence failure 记录 retryable attempt，但不生成
  TerminalRejected；
- consumer loop 把 retryable PersistenceUnavailable 作为 batch retry，禁止误投
  dead-letter；non-retryable failure 的 dead-letter 文本只使用 safe fields。

### Wave 5 — Product presentation and verification（已实现）

统一 Attention/Problem DTO 的 safe code、correlationId、retry disposition；禁止 UI、
日志或模型上下文读取 native cause。Verifier 可以把失败 ToolResult 当作证据，但只有
明确成功且具备 canonical invocation identity 的结果可以支持正向事实声明。

实现结果：

- Problem.safeDetails 统一递归脱敏、深度/数组/字符串边界；
- cause/stack/authorization/token/apiKey/secret/credential/password/cookie 不进入
  transport DTO；
- Gateway persistence failures 映射稳定 Problem code/category/retryDisposition；
- Projection 与 post-commit failure 只暴露 safe source tag；
- Web 不再拼接 native fetch Error；Provider config parse error 不回显可能包含 secret
  的 JSON 片段；
- Problem retryDisposition 收紧为 `retryable | non-retryable`；
- Verifier 可记录 Success、ExpectedFailure/RuntimeFailure、Interrupted、
  OutcomeUnknown ToolResult 作为证据，但必须与 durable ToolInvocation settlement
  和 invocation identity 一致；
- Attention summary 继续只由 canonical safe facts 派生，不读取 native cause。

## 6. 机械保护

- 每个 Model-usable failure 必须测试“第一轮失败 → Session typed result → 第二轮修正”；
- 每个 operational failure 必须测试 native cause 不进入 Session/provider request；
- 每个 OutcomeUnknown 必须测试普通 progression 被阻止；
- architecture test 禁止重新引入旧 `AgentActionError { cause: unknown }`；
- 每一波减少通用 unknown wrapper，不能用新的万能 `ArborError` 替代。
