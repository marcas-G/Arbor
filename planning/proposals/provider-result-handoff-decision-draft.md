# Provider 结果交接与 Agent 回合恢复 — 治理决策草案

## 状态

**DRAFT / 等待人工治理。** 本文位于 `planning/`，不修改
`docs/design/**` 的冻结语义，也不授权实现下面的新持久状态。

关联缺口：`DOGFOOD-DG-01`。

## 审阅意见处置（2026-09-30）

审阅文件：`provider-result-handoff-decision-draft.review.md`。

| 意见 | 处置 | 修订位置 |
|---|---|---|
| R1 稳定 CommandId 继承旧租约拒绝 | **接受** | §6 区分逻辑动作身份与命令尝试身份；§7 采用 generation-scoped 结算尝试 |
| R2 Attempt Success 与 Turn settled 间重复请求 | **接受** | §4 增加成功证据本地收敛和新写入原子提交规则；§7/§11 增加恢复与注入分支 |
| R3 缺少失败和修复耗尽路径 | **接受** | §3 增加 Provider 失败、RepairRejected/Exhausted 与直接 SettlementProposed 路径 |
| R4 部分动作完成后无法失效/提前终止 | **接受** | §6 增加逐动作 ledger、SkippedStale、EarlySettlement 与逐条 Observation 收敛 |
| R5 旧数据没有 AgentTurn 接入路径 | **接受** | §8 增加受治理的一次性分类、迁移与人工 Attention 规则 |

这些处置仍是提案修订，不是治理裁决或实现授权。

### 第二轮审阅意见处置

审阅文件：`provider-result-handoff-decision-draft.review-round2.md`。

| 意见 | 处置 | 修订位置 |
|---|---|---|
| R6 OutcomeUnknown 被当作普通动作终态 | **接受** | §6 增加 `ReconciliationPending` 和统一 unresolved-side-effect gate；§7/§10 禁止普通推进 |
| R7 遗漏 NextTurnReady 与 repair successor 恢复 | **接受** | §3 统一 OutputRejected 表达并持久化 successor identity；§7 增加恢复行与 ensure-successor 规则 |
| R8 统一验收断言与失败/停止/Attention 冲突 | **接受** | §11 改为按成功、重试、停止、OutcomeUnknown 和 Attention 分支断言 |

第二轮处置仍不关闭 Design Gap，也不授权实现。

## 1. 需要裁决的问题

当前系统分别持久化：

1. ProviderTurn 与 ProviderAttempt；
2. SessionEntry；
3. ToolInvocation / Application Command；
4. Execution settlement。

但“Agent 正在消费哪一个 Provider 结果、已经完成到哪一步”没有独立的
持久状态。Agent Driver 依赖进程内局部变量，把这些边界串成一次回合。
因此任意两个提交之间崩溃或失去租约，都可能留下每张表各自合法、整体却
无法恢复的组合。

本次证据正是：ProviderTurn 已成功结算，Session 尚未接受 ModelOutput，
Execution 仍 Active。现有 P9 只规定未结算 ProviderTurn 的恢复，所以没有
权威路径继续。

## 2. 建议治理决策

引入持久化的 **AgentTurn** 交接状态机。Provider Runtime 继续只拥有
Provider 调用、重试和规范化事件；Agent Runtime 拥有 Provider 结果的消费、
工具/控制动作推进和回合结束；Execution Runtime 继续拥有租约与最终
Execution 结算。

租约是写入权限，不是业务进度载体。失去租约必须停止写入；新的拥有者依据
AgentTurn 的持久步骤继续，而不是重新猜测或重新调用模型。

## 3. 建议状态模型

建议新增运行时记录（名称可由治理调整）：

```text
AgentTurnRecord
  executionId
  logicalTurnNo
  repairAttempt
  providerTurnId
  manifestId?
  state:
    Prepared
    ProviderResultAvailable
    OutputRejected
    OutputAccepted
    ActionsInProgress
    TurnEffectsCommitted
    SettlementProposed | NextTurnReady
  providerFailure?
  repairDisposition?: Retry(nextRepairAttempt) | Exhausted(settlement)
  successor?: AgentTurnIdentity
  nextTurnReason?
  decodedOutputHash?
  modelOutputSessionSequence?
  nextActionIndex
  settlementJson?
  revision
  updatedAt
```

身份键建议为 `(executionId, logicalTurnNo, repairAttempt)`；`providerTurnId`
保持唯一。`repairAttempt` 必须持久化，否则输出契约修复在崩溃后无法确定下一个
ProviderTurn 身份。

### 状态转换

```text
Prepared
  ├─ ProviderTurn 终止失败/超时/安全停止
  │    └─ 持久化失败 disposition → SettlementProposed(Failed | Interrupted)
  └─ ProviderTurn 成功 → ProviderResultAvailable
       ├─ 输出契约无效 → OutputRejected(repairDisposition)
       │    ├─ Retry(successor) → ensure successor Prepared
       │    └─ Exhausted(settlement) → SettlementProposed
       └─ 输出契约有效 → OutputAccepted
            └─ 逐个推进 ActionRecord → ActionsInProgress
                 ├─ 全部动作已解决且无未知副作用 → TurnEffectsCommitted
                 ├─ DecisionStale → 剩余动作 SkippedStale → NextTurnReady
                 └─ 动作直接请求结算 → 剩余动作 SkippedEarlySettlement
                                              → SettlementProposed

TurnEffectsCommitted
  ├─ 需要下一模型回合 → NextTurnReady
  └─ 得到结算提案 → SettlementProposed
```

每个箭头必须满足：状态转换与该步骤产生的持久副作用在同一事务中，或者副作用
本身拥有稳定幂等键并能在重试时查询结果。

失败、修复耗尽、运行时安全停止不要求先产生或接受 ModelOutput。无效输出统一
表示为 `OutputRejected(Retry(successor))` 或
`OutputRejected(Exhausted(settlement))`；不再使用另一组
`RejectedForRepair`/`RepairExhausted` 状态名称。恢复时不得重新消耗 repair
预算或重新解释已持久化的 disposition。

`successor` 是创建前可确定的完整稳定身份：repair successor 为同一 `logicalTurnNo`、
`repairAttempt + 1`；正常下一回合 successor 为 `logicalTurnNo + 1`、
`repairAttempt = 0`。两者都包含预先确定的 `providerTurnId`；`manifestId` 在
Provider Runtime 首次创建 Manifest 时一次性绑定，之后不可改变。恢复不得为了
补 manifest 绑定而重新创建 AgentTurn 或 ProviderTurn。

## 4. Provider 结果的权威来源

ProviderTurn 成功时，完整规范化事件序列必须作为可重放结果持久保存，并通过
只读端口按 `providerTurnId` 读取。恢复只重新执行纯函数解码和 Agent 步骤，
不得再次调用 Provider。

建议端口语义：

```text
ProviderTurnStore.findSettledResult(providerTurnId)
  → SettledSuccess {
      turn, manifest, canonicalEvents, finishReason, usage
    }
  | SettledFailure {...}
  | Unsettled {...}
  | NotFound
```

读取成功结果必须验证：Execution、Session、ContextEpoch、Model、Manifest 与
AgentTurnRecord 完全一致。规范化事件已经由 Provider Runtime 校验并持久化，
Agent Runtime 使用同版本 `decodeTurn` 重放。

### 成功结果的原子收敛

新的写路径必须在一个事务中提交 `ProviderAttempt Success` 与
`ProviderTurn settled`。建议由一个语义端口操作完成，而不是让 Runtime 连续调用
两个可独立提交的方法。

恢复旧数据和提交前崩溃时，不能把所有 `Turn settled_at IS NULL` 都视为需要重新
请求 Provider。恢复按以下优先级判断：

1. 最新 Attempt 已是 `Success`：只在本地补全 ProviderTurn settlement；
2. 最新 Attempt 仍是 `InProgress`，但持久规范事件前缀已经通过完整性校验，包含
   唯一 `TurnCompleted`，并能确定 finish reason/usage：在本地原子结算 Attempt 与
   Turn；
3. 没有完整成功证据：才进入现有 P9 安全重试决策。

“完整性校验”必须由 Provider Runtime 的版本化规则定义，不能仅搜索一个事件标签。
任何不完整或矛盾的事件前缀维持未结算失败证据，按 P9 规则处理。

## 5. Session 幂等写入

当前 `session_entries` 只有 `(session_id, sequence)` 主键，无法阻止同一
ProviderTurn 的 ModelOutput 重复写入。需要增加稳定来源键，例如：

```text
session_entries.source_kind  = 'ProviderTurn' | ...
session_entries.source_ref   = providerTurnId | ...
UNIQUE(session_id, entry_kind, source_kind, source_ref)
```

建议新增语义端口：

```text
SessionRepository.appendEntryIdempotent(sessionId, source, entry, fence)
```

同一事务内完成：

1. 验证当前租约栅栏；
2. 幂等插入 ModelOutput；
3. 把 AgentTurn 从 `ProviderResultAvailable` 推进为 `OutputAccepted`，记录
   Session sequence 与 decoded output hash。

重复执行返回既有 sequence；相同来源键但内容哈希不同必须作为不变量冲突失败，
不能覆盖。

## 6. 动作与观察恢复

只解决 ModelOutput 写入仍不够。还存在：Session 已写但 Tool/Control Action 未执行，
动作已结算但 Observation 未写，以及 Observation 已写但回合未推进等窗口。

每个解码动作具有稳定的 **LogicalActionId**，例如
`(executionId, providerTurnId, callRef, actionKind)`，并有独立 ActionRecord：

```text
Pending
Applied(resultRef)
SkippedStale(controlBasisEvidence)
SkippedEarlySettlement(settlementRef)
TerminalRejected(reason)
ReconciliationPending(reconciliationRefs, sideEffectSemantics)
```

LogicalActionId 用于证明一个语义动作只提交一次；Application `CommandId` 是一次
命令尝试的身份，不能与 LogicalActionId 混用。需要租约的命令尝试使用由
`(LogicalActionId, fencingGeneration, attemptOrdinal)` 推导的 CommandId，并以当前
generation 构造 payload 和语义指纹。

`FencingRejected` 对该 CommandId 仍是永久 `TerminalRejected`，但只终止旧
generation 的**尝试**。新拥有者先查询 LogicalActionId ledger 与既有成功结果：
若动作尚未提交成功，才以新 generation 创建新的 CommandId；若已成功，则直接
收敛 ActionRecord。领域级 terminal rejection 是否终止逻辑动作，必须由动作的
既有错误代数决定，不能与 fencing rejection 合并。

- 可执行工具继续使用稳定 InvocationId 与 intent-before-effect 规则；其结果绑定
  LogicalActionId。
- AgentTurn 持久化 `nextActionIndex`；每个动作结果和游标推进必须原子化或通过
  幂等结果查询收敛。
- 每个成功动作的 Observation 立即使用稳定来源
  `(providerTurnId, callRef, resultRef)` 幂等写入，不在内存中等待整批动作结束。
- 若执行 B 前发现 DecisionStale，B 及剩余动作进入 `SkippedStale`，已经完成的 A
  及其 Observation 保留，AgentTurn 进入 `NextTurnReady`。
- 若动作直接返回结算提案，该动作记录 `Applied(settlementRef)`，剩余动作进入
  `SkippedEarlySettlement`，AgentTurn 进入 `SettlementProposed`。
- `ActionsInProgress` 只有在每个动作都进入 `Applied`、`SkippedStale`、
  `SkippedEarlySettlement` 或被既有错误代数认可的 `TerminalRejected`，且不存在
  `ReconciliationPending` 时，才能进入 `TurnEffectsCommitted`；不要求每个动作
  都实际执行。

`ReconciliationPending` 只表示当前调用已停止、外部结果仍未知；它不是允许普通
回合推进的动作终态。Agent Runtime、Execution Runtime 和 Recovery Controller 在
进入 `TurnEffectsCommitted`、`NextTurnReady` 或提交任何普通
`Completed`/`Interrupted`/`Failed` 前，都必须执行同一个
**unresolved-side-effect gate**：

- ReadOnly/Idempotent 按既有 P4 规则重试或查询幂等结果；
- Reconcilable 必须先取得 reconciliation 证据，再转为 `Applied`、正式领域拒绝或
  其他被工具契约允许的已解决状态；
- NonIdempotent 且结果未知时禁止重放，保持对账/Attention，或只允许生成
  `SettlementProposed(OutcomeUnknown(ReconciliationRequired(refs)))`；
- 即使收到 stop，也不能把 unresolved side effect 普通结算为 `Interrupted`；
- “没有 Applied 成功结果”不构成安全重试证据。

若生成 OutcomeUnknown 结算提案，相关 ActionRecord 可保持
`ReconciliationPending` 作为证据；它通过特殊的 OutcomeUnknown 出口收敛
Execution，而不是先伪装成 `TurnEffectsCommitted`。

## 7. Execution 结算恢复

Agent Driver 不应只把结算提案作为返回值留在内存。进入
`SettlementProposed` 时持久化完整提案。Execution Runtime 获得有效租约后，
先查询 Execution 是否已有权威 settlement。若仍 Active，以稳定的
LogicalSettlementId 标识语义结算，但每个命令尝试使用包含当前
`fencingGeneration` 的新 CommandId；payload 和语义指纹也使用相同 generation。
旧 generation 的 `FencingRejected` receipt 不得复用于新 generation 的尝试。

恢复规则：

| 持久状态 | 新拥有者动作 | Provider 调用 |
|---|---|---|
| ProviderTurn 未结算，但存在完整成功 Attempt/事件证据 | 本地原子补全 Attempt/Turn settlement | 禁止 |
| ProviderTurn 未结算，且无完整成功证据 | 沿用 P9：同 Turn 新 Attempt | 可能，受重试策略约束 |
| ProviderTurn 终止失败或 repair 耗尽 | 持久化失败/中断 settlement proposal | 禁止 |
| ProviderTurn 成功，AgentTurn 为 `Prepared`/`ProviderResultAvailable` | 读取持久事件并解码，推进交接 | 禁止 |
| `OutputRejected(Retry(successor))` | ensure/find 唯一 repair successor；接续既有记录 | 仅 successor 首次执行时允许 |
| `OutputRejected(Exhausted(settlement))` | 按已持久化提案进入 `SettlementProposed` | 禁止 |
| `OutputAccepted` | 从动作游标继续 | 禁止 |
| `ActionsInProgress` | 查询每个 LogicalActionId，收敛或执行下一个 Pending 动作 | 禁止 |
| `ActionsInProgress` 且存在 `ReconciliationPending` | 对账、Attention 或 OutcomeUnknown；禁止普通推进 | 禁止盲目重放 |
| `TurnEffectsCommitted` | 创建下一回合或结算提案 | 仅下一逻辑回合允许 |
| `NextTurnReady(successor)` | ensure/find 唯一下一逻辑回合；接续既有记录 | 仅 successor 首次执行时允许 |
| `SettlementProposed` 且 Execution Active | 以新 generation 的命令尝试提交 SettleExecution | 禁止 |
| Execution 已结算 | 收敛关联 HumanMessage/投影 | 禁止 |

对话 HumanMessage 的 Answered/Released 状态仍由现有 P14 结算边界派生，但恢复
扫描必须能发现 `SettlementProposed` 和“Execution 已结算、消息尚未收敛”的状态。

### 唯一后继创建规则

`OutputRejected(Retry)` 与 `NextTurnReady` 在提交前必须已经持久化完整 successor
identity。恢复调用 `ensureSuccessor(predecessor, successor)`：

1. 不存在 successor 时，按该身份创建 `Prepared`；
2. 已存在且 `predecessorRef`、identity 以及任何已建立的 manifest 绑定完全一致时，
   返回既有记录；
3. 已存在但任一字段不同，作为不变量冲突停止并产生 Attention；
4. predecessor 已提交而 successor 未创建、successor 已创建而 predecessor 尚待
   收敛这两个窗口，都调用同一操作，不重新运行 repair/next-turn 决策，不重复消耗
   预算，也不创建第二个 ProviderTurn。

## 8. 旧数据迁移与对账

部署 AgentTurn 状态机时，现存 Execution 不一定有 AgentTurnRecord。迁移不得仅凭
“存在一个成功 ProviderTurn”猜测进度。需要一次性、受治理的 reconciliation：

1. 枚举没有 AgentTurnRecord 的 Active Execution；
2. 按 manifest 绑定、ProviderTurn/Attempt、SessionEntry 来源、ToolInvocation、
   Application Command receipt 和 Execution 状态构造证据集合；
3. 只有在 `(executionId, logicalTurnNo, repairAttempt, providerTurnId)` 可唯一确定且
   没有动作副作用歧义时，才建立带 `migrationProvenance` 的 AgentTurnRecord；
4. 已有来源明确的 ModelOutput 时，幂等绑定其 sequence 并从 `OutputAccepted`
   继续；没有 Session 输出但有完整成功 Provider 结果时，从
   `ProviderResultAvailable` 继续；
5. 存在工具/控制动作但无法证明其 disposition，或无法唯一确定 turn/repair 身份，
   进入持久 Attention/ReconciliationRequired，禁止请求 Provider、执行动作或直接
   结算；
6. 迁移本身可重复执行，第二次运行不得新建不同记录或推进未获证明的步骤。

本次 DOGFOOD-DG-01 数据只有一个无工具调用的对话 ProviderTurn、完整成功事件、
匹配的 Execution/Session/Manifest，且 Session 中不存在该 ProviderTurn 的
ModelOutput。治理可以明确授权它被分类为 `ProviderResultAvailable`，由新 generation
完成幂等 Session 写入和结算；在授权前仍保持只读证据。

迁移验收必须包含本次数据库的等价 fixture，以及以下旧状态：已有 Session 输出、
已有部分工具结算、旧 fencing rejection receipt、无法确定 repairAttempt。后三者中
证据不足的场景必须产生 Attention，而不是自动重放。

## 9. 租约规则

本次密集流饿死续租是实现缺陷，已增加调度让出并有回归测试。但设计需要明确：

- TTL/3 后台续租用于维持所有权，不提供业务完成保证。
- 每个可能持续较久的循环必须允许调度；不得在一个不可中断同步区间内超过 TTL。
- 每个 AgentTurn 持久转换都在同事务内验证完整租约拥有者三元组与 generation。
- 可选的“写前续租”只能减少临界窗口；即使它失败，持久状态机也必须允许新拥有者
  恢复。
- 进程崩溃、断电和失去租约是正常恢复输入，不能依赖 finally 或进程内返回值收敛。

## 10. 新不变量建议

1. 一个成功 ProviderTurn 的规范化输出只能对应一个 AgentTurn 身份。
2. 已成功 ProviderTurn 在恢复时不得再次发出 Provider 请求。
3. 每个 ProviderTurn 最多产生一个语义相同的 ModelOutput SessionEntry。
4. AgentTurn 状态不得越级；每次推进与其持久副作用共享事务或稳定幂等结果。
5. 失去租约只停止当前拥有者写入，不得使已持久 Provider 结果不可达。
6. Execution 结算后不存在未完成 AgentTurn；若暂时出现，恢复只能收敛，不执行
   新动作。
7. HumanMessage 最终状态与 Execution settlement 一致收敛，重启不产生第二个答案。
8. LogicalActionId 的成功只出现一次；CommandId 只标识一次带 generation 的命令
   尝试，旧 fencing rejection 不阻止新拥有者的正式恢复尝试。
9. 已存在完整成功 Provider 证据的 Turn，恢复不得再次请求 Provider，即使
   `provider_turns.settled_at` 尚为空。
10. 存在 `ReconciliationPending` 时，不得进入下一模型回合或普通
    Completed/Interrupted/Failed；只能继续对账、进入 Attention，或按既有契约提交
    OutcomeUnknown(ReconciliationRequired)。
11. `OutputRejected(Retry)` 与 `NextTurnReady` 各自只指向一个稳定 successor；
    ensure-successor 可重复执行且不重新解释前驱决定。

## 11. 必须通过的故障注入

对下列每个箭头，在提交前与提交后分别 kill 进程，然后重启：

1. 完整终止事件持久化 → ProviderAttempt Success；
2. ProviderAttempt Success → ProviderTurn settled；
3. ProviderTurn settled → AgentTurn ProviderResultAvailable；
4. Provider 终止失败/repair 耗尽 → SettlementProposed；
5. 解码完成 → ModelOutput SessionEntry；
6. SessionEntry → AgentTurn OutputAccepted；
7. 每个 Tool/Control Action 的 intent、effect、settlement、Observation 和游标推进；
8. 动作 A 成功后 kill，恢复执行 B 前 ControlBasis 失效；
9. 动作直接产生 settlement，剩余动作尚未处理；
10. 旧 generation 的命令尝试已持久化 `FencingRejected` → 新 generation 接管；
11. Observation append → TurnEffectsCommitted；
12. SettlementProposed → SettleExecution；
13. Execution settled → HumanMessage Answered；
14. 无 AgentTurnRecord 的旧数据迁移与二次重复迁移。

统一断言仅包括：旧 generation 写入被拒绝；稳定身份不产生重复 SessionEntry 或
重复外部动作；状态转换符合对应分支。其余断言按结果分支定义：

| 分支 | Provider 请求 | Execution / Message / Transcript 期望 |
|---|---|---|
| 已有完整成功 Provider 证据 | 同一 ProviderTurn 禁止再次请求 | 成功收敛时恰好一个逻辑 Assistant 回复 |
| 授权的 transport retry | 同一 Turn 可按 P9 新 Attempt | 不产生重复已接受输出或外部动作 |
| repair successor / 新逻辑回合 | 新稳定 ProviderTurn 身份允许请求 | 前驱决定不重算；最终成功时恰好一个逻辑回复 |
| `Completed` | 禁止额外请求 | HumanMessage `Answered`，bounded response body，恰好一个回复 |
| `Interrupted` | 禁止自动重试 | HumanMessage `Answered` 且 response body = null，无 Assistant 重复回复 |
| `Failed` / `OutcomeUnknown` | P14 可释放为新 conversation attempt | 原 execution 不伪造回复；新 attempt 使用新 execution/command 身份 |
| `ReconciliationPending` / Attention | 禁止盲目请求或执行动作 | Execution 保持安全状态；无重复回复，等待对账或人工处理 |
| 旧数据证据不足 | 禁止请求 | 持久 Attention；不强制产生答案 |

NonIdempotent/Reconcilable 专项注入必须覆盖“外部 effect 已发生、settlement 未提交”：
断言不盲目重放、不普通完成；只有 reconciliation 证据满足工具契约后才能继续，
否则保持对账/Attention 或提交 OutcomeUnknown。

还需保留本次密集流测试：大量立即可用的 SSE delta 期间，TTL/3 续租必须实际提交。

## 12. 所需设计归属变更

人工治理若接受本提案，至少需要在以下所有者文档中落字：

- DID：AgentTurn runtime record、端口、SQL/迁移、包依赖与恢复算法；
- P1 / Application Gateway：LogicalActionId 与 generation-scoped CommandId 的身份、
  receipt 查询和 retry eligibility；
- P3：Agent Driver 回合状态、输出契约修复与结果接受边界；
- P9：从“未结算 ProviderTurn”扩展到成功证据本地收敛、全部 AgentTurn 崩溃窗口
  和旧数据 migration/reconciliation；
- P14：Conversation Execution 与 HumanMessage 的最终收敛规则；
- P12 Runtime Safety：AgentTurn 转换的租约/栅栏写面。

在治理完成前，允许保留密集流调度修复；禁止为已结算 ProviderTurn 编写临时
重放、直接修改 Session/Execution 表，或重新请求模型来掩盖该状态。

## 13. 建议裁决

建议接受“持久 AgentTurn + 可重放 Provider 结果 + 幂等 Session/动作交接”作为
正式方向。单独增加超时、延长 TTL、写前续租或捕获 `FencingRejected` 都不能覆盖
进程崩溃后的交接窗口，不能作为缺口关闭条件。
