# Conversation Delivery Runtime Convergence — 治理决策草案

**Date:** 2026-10-01

**Status:** PROPOSED / NOT YET GOVERNANCE-ACCEPTED / IMPLEMENTATION NOT AUTHORIZED

**Decision token:** `ACCEPT_CONVERSATION_DELIVERY_RUNTIME_CONVERGENCE`

## 1. 要解决的不是“重试次数”，而是错误的职责合并

真实 Dogfooding 暴露的调用风暴不是单点 bug。当前系统把三种完全不同的生命周期压在同一条链上：

```text
HumanMessage.state
  同时表达：用户消息是否存在、是否正在处理、Execution 是否失败、是否应再次调用模型

Execution settlement
  同时被当成：本次执行结果、对话是否需要重试

Provider/repair attempt
  同时被放大成：新的 Conversation Execution
```

结果是 `Failed -> Pending`：任何确定性错误、坏上下文、协议错误或部署错误都会立即重新进入 daemon，形成无延迟的新 Execution 和新 Provider 请求。

此外，Session 投影当前逐行转换：它能发现“Result 找不到 Call”，却不拒绝“Call 没有 Result”。因此一个 crash-visible dangling ToolCall 可以被直接送进下一次 Provider 请求。工具暴露又由静态 catalog 和 `includeTools/includeControlTools` 布尔值控制，没有正式的 Execution-purpose resolver。

这三处必须一起收敛；只加 retry cap、timeout 或更多分支属于补丁。

## 2. 总体决策

建立三个正交的硬边界：

```text
Immutable HumanMessage
        │ 1:1
        ▼
ConversationResponseJob ── durable retry / attention / answer lifecycle
        │ 1:N
        ▼
ConversationAttempt ────── one exact Execution per admitted attempt
        │
        ├── AgentLoopStep / output repair（同一次 Execution 内）
        └── ProviderAttempt / transport retry（同一个 ProviderTurn 内）

SessionContextGate ──────── 只允许 causally closed frontier 进入模型
TurnProfileResolver ─────── 按 Execution purpose 解析精确工具与输出契约
```

三个层级各自有预算、状态、错误分类和恢复责任，禁止相互隐式放大。

## 3. HumanMessage 只保存用户事实

`HumanMessage` 保留不可变的用户输入事实：

- messageId / projectId / rootWorkspaceId；
- principal / bodyRef / createdAt；
- command idempotency fingerprint；
- project-close disposition（若提交后尚未进入处理）。

从 `HumanMessage` 移除以下运行时职责：

- `Claimed` 作为 worker lease；
- `claimedByExecutionId`；
- `attemptNo`；
- `Failed -> Pending` 调度语义；
- 用 `Answered(null)` 同时表示“被人为停止”和“内部失败”。

兼容期可以保留列，但新逻辑不得再把它们作为调度真相。

## 4. 新增 ConversationResponseJob 状态机

每条可处理的 HumanMessage 创建且只创建一个 `ConversationResponseJob`：

```ts
type ConversationResponseJobState =
  | { _tag: "Queued" }
  | { _tag: "Running"; attemptNo: number; executionId: ExecutionId }
  | {
      _tag: "RetryScheduled";
      nextEligibleAt: string;
      attemptNo: number;
      failureFingerprint: string;
    }
  | {
      _tag: "NeedsAttention";
      reason: ConversationAttentionReason;
      failureFingerprint: string;
      lastExecutionId?: ExecutionId;
    }
  | { _tag: "Answered"; responseRef: string; executionId: ExecutionId }
  | { _tag: "Cancelled"; reason: "HumanCancelled" | "ProjectClosed" };
```

硬不变量：

1. 一个 Job 同时最多一个 `Running` attempt。
2. `HumanMessage` 内容不因 retry 改写。
3. 一个 Job 最多提交一个 authoritative Assistant response。
4. `NeedsAttention`、`Answered`、`Cancelled` 不会被 daemon 自动 claim。
5. 重启后调度仅由 Job 状态和 `nextEligibleAt` 决定，不读进程内 timer。
6. Job revision 使用 CAS；重复 sweep 只能得到同一状态。

## 5. ConversationAttempt 是追加式审计记录

每次真正 admission 生成一个 append-only attempt：

```text
(messageId, attemptNo)
→ deterministic executionId / commandId
→ admittedAt / settledAt
→ settlement class
→ failure fingerprint
→ retry decision + policy version
```

它记录发生过什么，不负责决定下一步。下一状态由唯一的 `ConversationRecoveryPolicy` 纯函数计算并与 Job CAS 一起提交。

## 6. 分层错误分类：禁止所有 Failed 使用同一规则

### 6.1 Provider Runtime 内部

仅处理同一 ProviderTurn 的传输问题：

- connect timeout；
- response 前的网络断开；
- 明确可重试的 429 / 5xx；
- provider 声明允许的 continuation。

这一级有独立、有限的 `maxTransportAttempts`，不得创建新 Execution。

### 6.2 Agent Runtime 内部

仅处理同一 Execution / logical step 的模型输出问题：

- schema/output-contract violation；
- empty output；
- bounded repair instruction。

这一级有独立 `maxOutputRepairs`，不得回滚 Conversation Job。

### 6.3 Conversation Recovery Policy

只在整个 Execution 已权威 settle 后决定：

| 分类 | 自动动作 |
|---|---|
| `TransientProviderUnavailable` | `RetryScheduled`，受 Execution-attempt budget、backoff 和 deployment circuit breaker 限制 |
| `ContextBlocked` / dangling invocation | `NeedsAttention`；先走 reconciliation，禁止 Provider 请求 |
| `AuthenticationFailed` / `RequestRejected` / bad deployment | `NeedsAttention`；配置改变后由人恢复 |
| `DeterministicModelFailure`（相同空输出/相同 contract failure） | `NeedsAttention`；重复请求不会产生新信息 |
| `OutcomeUnknown` | `NeedsAttention(ReconciliationRequired)`；绝不自动 replay |
| `ControlledInterruption` / human stop | `Cancelled` 或显式 stopped disposition |
| `Completed(QueryCompleted)` | `Answered` |

`ExecutionSettlement._tag === Failed` 不再等价于“自动重试”。必须先映射成上述稳定分类。

## 7. 有界重试是 policy，不是散落常量

新增版本化策略：

```ts
interface ConversationRetryPolicy {
  readonly version: string;
  readonly maxExecutionAttempts: number;
  readonly maxTotalElapsedMs: number;
  readonly identicalFailureLimit: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
}
```

建议 v1 默认值：

```text
maxExecutionAttempts = 3
maxTotalElapsedMs = 15 minutes
identicalFailureLimit = 2
baseDelayMs = 2 seconds
maxDelayMs = 60 seconds
jitterRatio = 0.2
```

Jitter 由 `(messageId, attemptNo, policyVersion)` 确定性派生，保证 crash/replay 得到相同 `nextEligibleAt`。任一预算先耗尽即进入 `NeedsAttention`。

系统必须在 manifest/attempt record 中记录 policy version，不能事后用新策略重解释旧 attempt。

## 8. Provider Deployment Circuit Breaker

单条消息的 attempt budget 无法阻止许多消息同时冲击一个坏 deployment，因此增加 deployment 级持久熔断器：

```text
Closed → Open(cooldownUntil, failureClass) → HalfOpen(single probe) → Closed/Open
```

- key：ResolvedModelBinding fingerprint；
- Authentication/RequestRejected 直接 Open，等待配置 revision 改变或人工恢复；
- transient failures 达阈值后 Open；
- Open 时新 Job 进入 `RetryScheduled` 或 `NeedsAttention`，不发 Provider bytes；
- HalfOpen 同时只允许一个 probe；
- 成功响应关闭 breaker；
- 状态持久化，重启不能清空熔断。

这属于 Provider/Deployment health，不属于 HumanMessage。

## 9. SessionContextGate：只投影因果闭合前沿

这是防止坏上下文进入模型的根机制。

`projectSessionTimeline` 不再永远返回一个数组，而返回：

```ts
type SessionProjectionDecision =
  | { _tag: "Ready"; projection: SessionTimelineProjection }
  | {
      _tag: "Blocked";
      reason: "UnresolvedInvocation" | "ContradictoryTimeline";
      callRefs: ReadonlyArray<string>;
      frontier: SessionFrontier;
    };
```

规则：

1. 只有 `ToolCall(callRef)` 与恰好一个 `ToolResult/ControlResult(callRef)` 组成闭合 pair 后，二者才可进入下一次 Provider request。
2. 遇到 dangling call，投影停在它之前的最大闭合前沿，并返回 `Blocked`；不得静默丢弃，也不得继续请求模型。
3. AgentLoop/ToolRuntime reconciliation 根据 action ledger / invocation settlement 补写真实结果；不能从文本猜结果。
4. 无法证明 disposition 时生成明确 `OutcomeUnknown`/Attention，而不是伪造 Failed result。
5. `validatePortableToolPairing` 增加 `DanglingToolCall`，任何 Inference request 在 adapter 发送 bytes 前再次 fail closed。
6. Session append 与 action-ledger transition 尽量同事务；crash window 仍由 Gate + reconciler 正确处理，而不是假设永不 crash。

因此，即使未来某条代码再次漏写 ControlResult，系统也只会停在可恢复状态，不会污染下一轮模型输入。

## 10. TurnProfileResolver：删除布尔开关和静态过度暴露

当前 `includeTools` / `includeControlTools` 是过渡止血方案。最终改为：

```ts
interface ResolvedTurnProfile {
  readonly purpose: ExecutionPurpose;
  readonly outputContractRef: string;
  readonly executableToolRefs: ReadonlyArray<ToolDefinitionRef>;
  readonly controlToolRefs: ReadonlyArray<ControlToolRef>;
  readonly contextPolicyRef: string;
  readonly profileVersion: string;
}
```

`TurnProfileResolver` 输入必须是 canonical facts：

- Execution binding/focus；
- Workspace responsibility/resource boundary；
- capability/permission grants；
- handler + codec + executor readiness；
- project/work/verification lifecycle；
- current control basis。

输出是当前 turn 的精确 surface。Model Context 只编译这个结果，不推断用途。

硬不变量：

```text
MODEL_VISIBLE(tool, turn)
⇒ PURPOSE_APPLICABLE
∧ CODEC_REGISTERED
∧ HANDLER_REGISTERED
∧ INVOCATION_PATH_READY
∧ CAPABILITY_ELIGIBLE
```

Root Conversation 的基础 profile 是 `RespondToHumanV1`，默认无 executable/control tools。需要组织动作时必须选择另一个版本化 conversation profile，且其中每个 action 都对 Coordination binding 有真实 handler；绝不把 Work-only `ClaimCompletion/Wait/DeclareDependency` 混入普通回答回合。

完成后删除：

- `includeTools`；
- `includeControlTools`；
- compiler 的 legacy universal directive fallback；
- 静态“注册了 handler 就对所有 execution 可见”的规则。

## 11. Daemon 变成 eligibility scheduler，不再 busy retry

Conversation daemon 只查询：

```text
Queued
OR RetryScheduled(nextEligibleAt <= now)
```

并同时检查：

- Project Open；
- Root Workspace 无 active main；
- deployment circuit 允许；
- Job attempt budget 未耗尽；
- SessionContextGate = Ready。

任何条件不满足都形成明确状态/等待原因，而不是每秒重复 claim/release。

推荐由 durable wake source 驱动（new message、retry deadline、config revision、reconciliation completion、provider breaker transition）；poll 仅作为恢复兜底。

## 12. 用户可见状态与控制

Transcript 保持 Human/Assistant 内容面；另增 response-status projection：

- 排队中；
- 处理中；
- 将在某时重试（显示安全原因，不暴露 secret）；
- 需要处理（配置错误、上下文恢复、重复确定性失败）；
- 已停止；
- 已回答。

新增人类命令：

- `ResumeConversationResponse(messageId, expectedJobRevision)`；
- `CancelConversationResponse(messageId, expectedJobRevision)`。

Resume 只能从 `NeedsAttention` 或到期后的受控状态出发，并在配置/上下文 revision 改变后创建下一 attempt；重复点击幂等。不能通过重新提交相同 HumanMessage 偷偷恢复。

## 13. 数据模型与迁移

建议新增：

```text
conversation_response_jobs
  message_id PK/FK
  state, revision
  active_execution_id?
  attempt_no
  next_eligible_at?
  last_failure_class?
  last_failure_fingerprint?
  policy_version
  response_ref?
  updated_at

conversation_attempts
  (message_id, attempt_no) PK
  execution_id UNIQUE
  admitted_at, settled_at?
  settlement_class?
  failure_class?, failure_fingerprint?
  retry_decision?, policy_version
```

迁移必须：

1. `Answered` → Job.Answered；
2. `Pending` → Job.Queued；
3. `Claimed + Active Execution` → Job.Running；
4. `Claimed + Settled` → 由确定性 settlement reconciler 收敛；
5. 已有 attemptNo 生成历史 attempt ledger 或明确 legacy provenance；
6. 不删除历史 HumanMessage / Execution / Session 数据；
7. forward-only、re-entrant，并对 crash@每个 commit boundary 测试。

## 14. 分阶段实施顺序

### Phase A — Context Safety Gate

- `SessionProjectionDecision`；
- dangling/contradictory timeline fail closed；
- adapter `DanglingToolCall` validation；
- reconciliation-before-inference；
- crash tests。

这是最高优先级，因为它阻止坏上下文变成新 Provider 请求。

### Phase B — Response Job / Attempt ledger

- schema migration；
- store/ports/ADT；
- SubmitHumanMessage 创建 Job；
- settlement sweep 改成 Job transition；
- 旧 `Failed -> Pending` 路径删除。

### Phase C — Recovery policy / durable scheduler / breaker

- failure classifier；
- versioned retry policy；
- deterministic backoff；
- deployment circuit breaker；
- Resume/Cancel commands；
- status projection。

### Phase D — Turn Profile Resolver

- purpose/capability/readiness resolver；
- control handler applicability contract；
- Model Context 只消费 ResolvedTurnProfile；
- 删除两个 include booleans和 legacy directive fallback。

### Phase E — UI + live validation

- processing/retry/attention states；
- Resume/Cancel；
- fault injection + restart；
- real-provider dogfooding；
- prove a deterministic failure emits at most the policy-bounded number of Provider requests。

## 15. 必须机械证明的核心性质

1. dangling ToolCall 时 Provider request count 不增加。
2. 相同确定性 failure fingerprint 第二次后进入 NeedsAttention，不产生第三个 Execution（按 v1 建议策略）。
3. transient failure 使用 durable nextEligibleAt；重启前后时间不提前。
4. transport retry、output repair、conversation attempt 三个预算不会互相乘成无限请求。
5. deployment breaker Open 时多个消息不会产生 Provider bytes。
6. 一个 Job 最多一个 Running attempt、最多一个 Answered response。
7. Resume/Cancel CAS 幂等且不可越权。
8. Root Conversation manifest 不含 Work-only tools。
9. Work profile 仍可在满足 authority/readiness 时使用 ClaimCompletion/Wait/Dependency。
10. 所有历史 transcript 与 Session 数据可迁移、可重启、无静默丢失。

## 16. 对当前止血提交的处置

`57a8583` 保留为安全止血和失败证据，但不是最终架构：

- terminal result pairing 会被保留并下沉为统一 Invocation Reconciler；
- `includeControlTools: false` 会被 TurnProfileResolver 取代；
- `HumanMessage.attemptNo` 和 `rollbackForRetry` 会退出调度真相；
- 180 秒 stream idle timeout 仍只是 deployment policy，不参与 correctness；
- `DOGFOOD-DG-02` 只有在 Phase A–E 的机械证据全部通过后才关闭。

## 17. 治理影响

若接受，本决策需要人工治理更新以下 owning contracts，之后才能实施：

- P14 conversation execution / settlement branch；
- DID Session projection / tool pairing / runtime boundaries；
- P12 provider health/observability；
- API contracts 的 response status 与 Resume/Cancel commands；
- migration/version baseline。

本草案不直接修改 `docs/design/**`，也不授权实现。人工接受 token：

```text
ACCEPT_CONVERSATION_DELIVERY_RUNTIME_CONVERGENCE
```

## 18. Codex / OpenCode 对照后的收敛修订

外部一手设计对照记录：

```text
C:/Arbor/planning/proposals/conversation-delivery-runtime-codex-opencode-review.md
```

对照结论不改变本草案主结构，但增加四项硬要求：

1. **同一 run 优先恢复。** Codex 官方将 approval、stream interruption 与 delayed review 建模为保存 state 后恢复同一个 run；因此 Arbor 的 approval、reconciliation、compaction 和可恢复 stream interruption 必须留在同一 `ConversationAttempt/Execution`，只有 terminal transient failure 才允许新 attempt。
2. **只允许一个 continuation truth。** Codex 官方警告混用 local replay 与 server-managed continuation 会重复上下文；Arbor 必须以 typed Session 为权威，provider-native continuation 只能通过 binding-scoped manifest 引用和对账，禁止双重注入。
3. **工具按当前 turn materialize。** OpenCode 按 model/provider/agent/session permission materialize 工具，且 registry settlement 捕获 exact registration identity；Arbor 的 `TurnProfileResolver` 也必须输出 exact tool identity，stale registration 形成 typed result，visibility 仍不替代 runtime authorization。
4. **统一 loop fingerprint。** OpenCode 对三次相同 tool/input 触发 doom-loop，并对 Provider retry 使用分类、max retries、backoff、jitter 和 next timestamp；Arbor 将其泛化为 durable tool/failure fingerprints，但分别保留 transport、output repair、conversation attempt 三个预算。

不会照搬 OpenCode 的默认 allow、次数常量或 session-centric durability；不会依赖 Codex 托管 harness 替代 Arbor 自己的 authority、migration、remote-worker 与 recovery contracts。
