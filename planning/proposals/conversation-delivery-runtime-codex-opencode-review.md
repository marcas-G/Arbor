# Conversation Delivery Runtime — Codex / OpenCode 设计对照

**Date:** 2026-10-01

**Status:** RESEARCH INPUT / NOT CONTRACT AUTHORITY

**Applies to:** `conversation-delivery-runtime-convergence-decision-draft.md`

## 1. 调研范围与原则

本记录只使用一手来源：OpenAI 官方文档，以及 OpenCode 官方文档和官方源码仓库。外部实现用于验证架构模式，不替代 Arbor 的 Domain、authority、durability 与 governance contracts。

主要来源：

- OpenAI Agents API Architecture：<https://developers.openai.com/api/docs/guides/agents-api/architecture>
- OpenAI Running agents：<https://developers.openai.com/api/docs/guides/agents/running-agents>
- OpenAI Guardrails and human review：<https://developers.openai.com/api/docs/guides/agents/guardrails-approvals>
- OpenCode `session/retry.ts`：<https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/retry.ts>
- OpenCode `session/processor.ts`：<https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/processor.ts>
- OpenCode `session/tools.ts`：<https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/tools.ts>
- OpenCode Core Tool Architecture：<https://github.com/anomalyco/opencode/blob/dev/packages/core/src/tool/AGENTS.md>
- OpenCode Core Tool Registry：<https://github.com/anomalyco/opencode/blob/dev/packages/core/src/tool/registry.ts>
- OpenCode Permissions：<https://opencode.ai/docs/permissions/>

## 2. Codex / OpenAI Agents 的关键设计

### 2.1 Harness、Environment、Application Server 分层

OpenAI 官方 Architecture 把系统拆成：

- Harness：运行 model/tool loop 并维护 agent session；
- Environment：命令、文件与计算所在的执行面；
- Application server：提交工作、接收事件、处理 function tools 与环境生命周期。

这与 Arbor 的正确方向一致：Agent Runtime 是控制面，ToolRuntime/Sandbox 是执行面，Web/Application 是人类入口。模型不应直接拥有调度、secret 或恢复状态。

### 2.2 一个 application turn 内部完成 agent loop

官方 Running agents 将一个 SDK run 定义为一个 application-level turn：

```text
model → inspect output → execute tool calls → continue
      → handoff if needed → final answer at a real stopping point
```

工具调用、handoff、审批和 streaming 都建立在同一个 loop 之上，而不是每遇到非 happy path 就创建新的用户 turn。

对 Arbor 的直接含义：

- Provider transport retry 不能变成新 Conversation Execution；
- output repair 不能变成新 HumanMessage attempt；
- tool approval / reconciliation 是当前 run 的 pause/resume；
- 只有整个 run 权威终止后，Conversation Recovery Policy 才能决定是否创建下一 attempt。

### 2.3 继续策略只能选一个权威来源

官方文档列出 `result.history`、SDK `session`、`conversationId`、`previousResponseId` 四种 continuation，并明确警告：同一 conversation 混合本地 replay 与 server-managed state 会重复上下文，除非调用方显式对账。

这直接支持 Arbor 的 `SessionContextGate`：

- WorkspacePrimary typed Session 是模型输入的权威 continuation source；
- HumanMessage 表只提供用户事实与 transcript projection，不得再次拼成第二份隐式历史；
- provider-native continuation 只能作为 binding-scoped checkpoint，由 Session manifest 引用，不能与本地 timeline 双重注入。

### 2.4 Pause 必须恢复同一个 run state

官方文档要求：审批暂停、stream 中断后希望继续同一 turn 时，应从保存的 state 恢复，而不是启动新的用户 turn。Approval lifecycle 也明确是：记录 interruption → 返回 resumable state → 批准/拒绝 → 恢复同一个 run。

这说明 Arbor 需要显式区分：

- `Paused/WaitingApproval/ReconciliationPending`：同一个 ConversationAttempt / Execution；
- `RetryScheduled`：原 Execution 已终止且错误被分类为可重试，才允许新的 attempt；
- 新 HumanMessage：只有人类真的提交新输入时才产生。

### 2.5 Guardrail 放在具体工具边界

OpenAI 官方 Guardrails 文档强调：如果每个 custom tool 都需要检查，应把验证放在工具边界，而不是只依赖 agent-level input/output guardrail。敏感动作应暂停当前 run，记录 decision 和 outcome，并 fail closed。

这支持 Arbor 保留：

- ToolRuntime exact-intent authority / resource / sandbox 检查；
- control handler 的 canonical authority 检查；
- model-visible surface 只是候选能力，不是 authorization；
- approval timeout/handler unavailable 形成 pause/attention，不通过 prompt 猜测。

## 3. OpenCode 的关键设计

### 3.1 Provider retry 位于 SessionProcessor 内部

OpenCode `session/processor.ts` 在同一个 stream processing pipeline 中应用 `SessionRetry.policy`：

- status 从 `busy` 切成 `retry`；
- retry 状态带 `attempt`、message 与 `next` timestamp；
- retry 完成后仍回到当前 processor；
-最终返回 `compact | stop | continue`，不是重新创建一条用户消息。

这验证了 Arbor 的分层原则：Provider retry 是当前 run 内部行为，不应由 HumanMessage daemon 通过 `Failed -> Pending` 实现。

### 3.2 Retry 有分类、上限、退避和 UI 状态

OpenCode 当前 `session/retry.ts` 明确包含：

```text
initial delay = 2 s
backoff factor = 2
jitter factor = 0.25
max delay without headers = 30 s
max retries = 5
```

同时：

- 优先尊重 retry-after/reset headers；
- context overflow 明确不可在通用 retry 层重试；
- 5xx / rate limit / overloaded 等才属于 retryable；
- 每次安排 retry 时写出下一次时间。

值得吸收的是机制，不是照抄数字：错误必须先分类，retry 必须有预算、backoff、next timestamp 和用户可见状态。

### 3.3 相同工具调用使用 doom-loop fingerprint

OpenCode SessionProcessor 对最近三次工具 part 做结构比较：同一 tool 且 input JSON 相同会触发 `doom_loop` permission，默认要求用户确认。

Arbor 应泛化该思想：

- tool loop fingerprint：`tool identity + canonical input hash`；
- execution failure fingerprint：`failure class + provider binding + context frontier + output contract`；
- 相同确定性失败达到阈值时进入 `NeedsAttention`，不能继续自动创建 Execution。

Arbor 不应仅使用“最近三次”进程内观察，而应把 fingerprint 与计数写入 ConversationAttempt / Job，保证重启一致。

### 3.4 Tool registry 使用 materialization，而不是全局布尔开关

OpenCode 的 Session tools 路径按当前 model、provider、agent 和 session permission 从 registry 获取工具，再转换 schema；执行上下文携带 session/message/call identity。

Core Tool Architecture 进一步区分：

- canonical Tool 同时拥有 codec、executor、definition derivation；
- registry 做有效注册 materialization；
- definition filtering 是 catalog visibility，不等于 execution authorization；
- invocation 开始 settlement 时捕获当时的 effective tool；
- stale/unknown registration 返回明确 error result；
- output bounding 由统一 settlement 边界负责。

这与 Arbor 需要的 `TurnProfileResolver + exact registry identity` 高度一致。当前 `includeTools/includeControlTools` 只能表达全开/全关，无法表达 purpose、handler readiness、permission 和 exact registration identity。

### 3.5 Permission 与工具面相连，但仍保留执行时检查

OpenCode 文档将 permission 定义为 `allow | ask | deny`，支持 per-agent 和参数 pattern；被 deny 的 subagent 可从工具描述中移除。同时源码说明可见性过滤不代替 leaf execution policy。

Arbor 应吸收“双层门”：

```text
TurnProfileResolver：是否对模型可见
Runtime Authority/Admission：此次具体调用是否可执行
```

但 Arbor 不采用 OpenCode 的 permissive defaults；Arbor 继续以 capability、ResourceBoundary、authority 与 explicit readiness fail closed。

## 4. 与 Arbor 当前设计的对照

| 问题 | Arbor 当前 | Codex / OpenCode 模式 | Arbor 根治方向 |
|---|---|---|---|
| 对话失败 | `Failed -> HumanMessage.Pending -> 新 Execution` | retry/approval 在同一 run/session processor 内继续；真正暂停保存 state | ResponseJob + Attempt；仅 terminal transient failure 创建下一 attempt |
| 重试 | 无 conversation budget/backoff；daemon 每秒重试 | OpenCode 有分类、上限、指数退避、jitter、next status | versioned durable policy + deterministic backoff + circuit breaker |
| 坏上下文 | Session projector 可输出 dangling ToolCall | Codex 强调单一 continuation state；同一 run 恢复 | SessionContextGate，只允许 closed frontier |
| 工具面 | 静态 registry + include booleans | OpenCode 按 agent/session permission materialize；执行再校验 | TurnProfileResolver + exact registry identity + runtime authority |
| 重复循环 | Runtime safety 有部分 fingerprint，但 conversation retry 不识别同错 | OpenCode 三次相同 tool/input 触发 doom-loop | durable tool/failure fingerprint，确定性同错进入 Attention |
| 暂停/审批 | Interrupted 常被消费成 `Answered(null)` | Codex 保存 state 并恢复同一个 run | Paused/Attention 与 Answered/Cancelled 分开 |
| 控制面/执行面 | 总体已有分层，但 conversation daemon 越权做 recovery policy | Codex harness/environment/application 明确分层 | Recovery Policy 独立 service，daemon 只做 eligibility scheduling |

## 5. 应吸收的设计

1. **Codex：同一 run 恢复，而不是制造新 turn。**
2. **Codex：只选择一个权威 conversation continuation strategy。**
3. **Codex：approval/guardrail 是工具边界的 pause/resume。**
4. **OpenCode：Provider retry 留在 processor 内，且状态可见。**
5. **OpenCode：错误分类 + max attempts + backoff + jitter + next timestamp。**
6. **OpenCode：相同 tool/input 的 doom-loop fingerprint。**
7. **OpenCode：tool registry materialization 与 execution authorization 分离。**
8. **OpenCode：settlement 是统一 result/output bounding 边界。**

## 6. 不能照搬的部分

1. **不能照抄 OpenCode 的次数和时间。** Arbor 的 transport、output repair、conversation attempt 是三个预算；数字必须分别版本化。
2. **不能采用默认 allow。** Arbor 是多 Workspace、父子 authority、ResourceBoundary 与远程 worker 系统，默认必须 fail closed。
3. **不能只保存 UI retry status。** Arbor 的 nextEligibleAt、failure fingerprint、policy version 和 breaker 必须 durable，重启结果相同。
4. **不能把 Workspace 当 Session。** OpenCode/Codex 的 session 是运行/上下文容器；Arbor Workspace 是长期责任身份，两者不能合并。
5. **不能依赖托管 harness 替 Arbor 决策。** Codex 的托管 recovery/session 能力是参考模式；Arbor 仍需自己实现 Port、Layer、migration 和 mechanical evidence。
6. **不能把模型可见性当授权。** OpenCode 也明确区分二者；Arbor 必须继续在 effect admission 重查 freshness 和 authority。

## 7. 对治理草案的具体修订

调研后，原草案的方向成立，但需要增加四项精确要求：

1. `ConversationAttempt` 内新增 `ContinuationState`：approval、reconciliation、compaction 与可恢复 stream interruption 优先恢复同一 Execution，不创建新 attempt。
2. `SessionContextGate` 必须同时禁止混用两套 continuation：本地 typed timeline 与 provider-native continuation 只能通过 binding-scoped manifest 对账，不能重复注入。
3. `TurnProfileResolver` 输出必须绑定 exact tool registration identity；执行 settlement 捕获该 identity，registry 更新后旧调用成为 typed stale result。
4. failure fingerprint 不只用于 conversation breaker，也统一覆盖 doom-loop：相同 tool/input、相同 deterministic output failure 与相同 provider failure 都有各自阈值和处置。

## 8. 结论

Codex 与 OpenCode 都没有支持 Arbor 当前的“Execution 失败后立刻把同一 HumanMessage 重新排队”模式。两者共同支持的结构是：

```text
一个用户 turn
→ 一个可恢复 run/processor
→ 内部 bounded retry / tool loop / approval pause
→ real stopping point
→ 应用层再决定结果或下一 attempt
```

因此，Arbor 根治方案应继续采用 `ConversationResponseJob + ConversationAttempt + SessionContextGate + TurnProfileResolver`，并用 durable policy / circuit breaker 补足 OpenCode 本地 session 模式在 Arbor 多 Workspace、重启和远程 worker 场景下不够强的部分。
