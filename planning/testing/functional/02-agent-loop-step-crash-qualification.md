# AgentLoopStep AH1–AH14 崩溃资格测试计划

状态：**已授权合同，测试矩阵未闭合**。来源：
`docs/design/implementation/P9/07-agent-loop-step-recovery.md` §4–§5。
本计划不更改治理语义，也不宣称现有单元测试等同于进程崩溃资格。

## 当前证据与缺口

`tests/p3-driver.test.ts` 已覆盖若干逻辑恢复：首次 sourced append 被 fence 后重用
同一个 Provider 结果、OutputAccepted transition 被打断后的原子回滚、legacy no-action
adoption、持久 Provider failure 后无重复调用，以及 action reconciliation。这些测试
在同一个测试进程中触发 Effect failure，不是 AH1–AH14 要求的“每个提交边界前后
杀进程、同一 durable DB 重启”。

| AH | 提交边界 | 当前最近证据 | 尚需证明 |
|---|---|---|---|
| 1–2 | Provider terminal events → Attempt Success → Turn settled | P3 driver 成功结果复用 | 实际提交前/后崩溃；Attempt/Turn 原子性与无重复请求 |
| 3 | Turn settled → Step ProviderResultAvailable | P3 driver settled replay | 两侧崩溃后同一 Step、同一 ProviderTurn |
| 4 | terminal failure/repair exhausted → SettlementProposed | P3 driver failed Turn | 两侧崩溃不重新推理或伪造答复 |
| 5–6 | pinned decode → sourced ModelOutput → OutputAccepted | P3 driver append/fence 与回滚 | 两侧崩溃保持唯一 Session source 与 pinned decode |
| 7 | action intent/effect/settlement/Observation/cursor 各过渡 | P3 driver action ledger | 每个子提交边界两侧，外部 effect 与 Observation 均不重复 |
| 8 | action A 已提交，B 前 ControlBasis 变旧 | P3 driver stale 分支 | 崩溃后 B 不以旧授权执行 |
| 9 | settlement proposal → remaining actions Skipped | P3 driver early settlement | 崩溃后余下 action 不执行 |
| 10 | old-generation FencingRejected → new takeover | P3/P9 lease tests | 新 generation 仅在证据允许时换 CommandId；旧写拒绝 |
| 11 | Observation append → StepEffectsCommitted | P3 driver action replay | 崩溃后不丢 Observation、不重复 effect |
| 12 | SettlementProposed → SettleExecution | P2/P3 settle tests | 一次权威 settlement、无重复 Provider 请求 |
| 13 | Execution settled → HumanMessage convergence | F06/F16 用户可见去重 | 窗口两侧只产生一条有界答复 |
| 14 | legacy adoption 首次 → 第二次 | P3 driver legacy adoption | 重启后同一 adoption/Attention，证据不足失败关闭 |

## 建议测试机制

建立独立 AH 进程夹具：每例新建 SQLite DB、隔离工作目录、确定性 Provider/Tool
计数器；测试专用 Composition 注入 `CrashProbe`（默认生产 Layer 为 no-op，正式服务
不能通过普通用户环境变量开启故障注入）。Probe 在指定事务边界前或提交后暂停，
父测试进程确认精确边界后杀进程，再用未注入的生产 Composition 从同一 DB 重启。
不能用固定毫秒 sleep 猜测“应该已落盘”。

每个 case 记录：命中的边界和侧别、旧/新 lease generation、Provider 请求次数、
Turn/Step/Session/action 唯一身份、Command Receipt、Tool effect 数、最终公开回复或
Attention。DB/ledger 检查仅属于 AH 资格测试；F01–F23 仍以公开 API/浏览器作
成功判定。AH1/2 若代码把 Attempt Success 与 Turn settled 放在同一事务，应测试
该原子提交的前/后态，而不是发明不存在的中间提交点。

## 退出门

AH1–AH14 每个实际提交边界的两侧均有命名测试和持久证据；无完整 Provider 成功
证据时仅允许受策略约束的 same-Turn retry，完整成功证据存在时禁止新请求；
NonIdempotent/Reconcilable 工具“effect 已发生、settlement 未落盘”必须进入
ReconciliationPending/Attention，不可盲重放。随后运行 `pnpm check` 与相关公开
功能测试，并更新 `planning/results/agent-loop-step-implementation-progress.md`。

AH15–AH19 另有 SCRC-008 结果，不得挪用其 PASS 代替 AH1–AH14。
