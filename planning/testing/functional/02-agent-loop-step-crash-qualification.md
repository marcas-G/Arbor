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
| 1–2 | Provider terminal events → Attempt Success → Turn settled | 同一原子提交前/后真实进程 kill/restart 已 PASS；`planning/results/AH1-AH2-atomic-provider-success-crash.result.md` | 无半成功态；有完整证据则不重复请求，无完整证据则原 Turn 失败关闭 |
| 3 | Turn settled → Step ProviderResultAvailable | 真实进程两侧 kill/restart 已 PASS；`planning/results/AH3-process-crash-qualification.result.md` | 两侧已证明同一 Step/ProviderTurn、单回复、单请求 |
| 4 | terminal failure/repair exhausted → SettlementProposed | 401 终态失败与修复耗尽各两侧真实进程 kill/restart 已 PASS；`planning/results/AH4-terminal-failure-repair-crash.result.md` | ProviderTurn/Step 同事务闭合；不重复推理或伪造答复 |
| 5–6 | pinned decode → sourced ModelOutput → OutputAccepted | 一笔原子事务前/后真实进程 kill/restart 已 PASS；`planning/results/AH5-AH6-sourced-output-atomic-crash.result.md` | Session source 与 Step 同时落盘，重启后单输出、单答复、单 Provider 请求 |
| 7 | action intent/effect/settlement/Observation/cursor 各过渡 | ReadOnly 四个提交点 + Reconcilable intent/实际 effect→settlement 两侧安全停止真实进程 PASS；普通 A→B 两个成功 Idempotent patch 经两次重启 cursor 0→1→2 PASS；A Applied 后 B 的 Idempotent effect 已落盘但 settlement 未提交即杀进程，重启唯一收敛 PASS；新增 A Applied/cursor 1 后 B P4 intent 已提交、effect 前杀进程，普通 daemon 以同 ToolInvocation/Action identity 收敛，唯一 ToolResult/Artifact/Observation，独立定向 1/1 PASS；同一 NonIdempotent invocation 的单连接、双独立 SQLite 连接与双 OS 进程同步竞争测试 PASS；见 `planning/results/AH7-two-action-interleaving.result.md`、`planning/results/AH7-B-idempotent-effect-before-settlement.result.md`、`planning/results/AH7-B-intent-before-effect.result.md`、`planning/results/AH7-cross-connection-concurrency.result.md` 等 | **PARTIAL**：AH7-DG-01 非 Success Observation、DG-02 主动 reconciliation、拟议 DG-03 approval/settlement 原子性待治理；NonIdempotent/失败/审批多动作交错及其进程崩溃矩阵仍缺证据 |
| 8 | action A 已提交，B 前 ControlBasis 变旧 | 真实进程 A 提交后 SteerWork→kill/restart，B SkippedStale、唯一后继、无额外 Work PASS；`planning/results/AH8-action-b-stale-process-crash.result.md` | 已证明 B 不以旧授权执行 |
| 9 | terminal action → remaining actions Skipped + settlement proposal | 提交前/后真实进程 kill/restart 2/2 PASS；`planning/results/AH9-terminal-action-process-crash.result.md` | 余下动作不执行、不产生第二个 Work；proposal 与跳过记录原子持久化 |
| 10 | old-generation FencingRejected → new takeover | 六类 Gateway 控制动作的定向反例通过；`AssignWork` current-Workspace 精确 CAPA grant 的旧拒绝 receipt 提交前/后与 Committed receipt/Action Pending 三案 3/3 PASS；`ProduceDeliverable` 三案3/3、`DeclareDependency`提交前/后2/2、`AcceptResult`提交前/后2/2 PASS；新增 Committed DeclareDependency/AcceptResult receipt、Action Pending 两案由 AH9 handler-return gate 杀 gen0 后 gen1 receipt-first 收敛，唯一 canonical effect/Observation、同一ProviderTurn。`SelectCurrentWork`真实 DecisionEpisode提交前/后2/2及Committed receipt/Action Pending恢复1/1 PASS；恢复断言覆盖原Execution `Completed(DecisionSubmitted)`、原Step `SettlementProposed`、Action Applied与唯一Observation/settlement receipt。窄 pinned replay guard 对同一 settled-success ProviderTurn/Submitted DecisionRequest 做 exact Workspace/Manifest 绑定；隔离 pending corruption 负测在真实 gen1 lease 后两案均 RED：Execution Failed，但 Step 仍 `ActionsInProgress`、Action 仍 Pending、无 Observation；未发起新 Provider/选择副作用。**此负测不是 PASS，具体终态处置等待人工治理，默认功能批次排除。** `SendMessage`当前文件5/5 PASS：Query receipt前/后2案、Committed Reply/correlation closed后恢复1案、DecisionRequest receipt前/后2案。DecisionRequest场景证明同一ProviderTurn持久ToolCall顺序为send_message→wait；ActionResult gate之前同项目workflow-signals offset落后于MessageSent（预期暂停），放行后child WorkEpisode settle、offset越过MessageSent且唯一Parent InboxEpisode admitted。见 `planning/results/AH10-assign-work-process-takeover.result.md`、`planning/results/AH10-generation-command-takeover-gap.result.md`、`planning/results/AH10-send-message-process-takeover.result.md`、`planning/results/AH10-select-current-work-takeover.result.md`、`planning/results/AH10-submitted-decision-binding-integrity.result.md` | **PARTIAL**：Direct-child AssignWork、Report 等其他消息种类/控制动作和额外状态组合仍缺；`Deliver`（拟议 AH10-DG-01）、验证控制（拟议 VCS-DG-01）和 Submitted DecisionEpisode mismatch 的终态收口仍待分别治理/验证 |
| 11 | Observation append → StepEffectsCommitted | 提交前/后真实进程 kill/restart 2/2 PASS；`planning/results/AH11-observation-step-effects-process-crash.result.md` | 已证明不丢 Observation、不重复 effect、后继唯一 |
| 12 | SettlementProposed → SettleExecution | 提交前/后真实进程 kill/restart 2/2 PASS；`planning/results/AH12-settlement-command-process-crash.result.md` | 已证明一次权威 settlement、无重复 Provider 请求 |
| 13 | Execution settled → ResponseJob/Attempt convergence（P17 supersession） | 提交前/后真实进程 kill/restart 2/2 PASS；`planning/results/AH13-conversation-response-convergence-process-crash.result.md` | 窗口两侧只有一条公开答复、一次 Provider 请求 |
| 14 | legacy adoption 首次 → 第二次 | 正向等价 fixture 两侧真实进程 2/2 PASS；`planning/results/AH14-legacy-adoption-partial.result.md` | **PARTIAL**：负向持久 Attention 红测与 `AH14-DG-01` 待治理 |

## 建议测试机制

建立独立 AH 进程夹具：每例新建 SQLite DB、隔离工作目录、确定性 Provider/Tool
计数器；测试专用 Composition 注入 `CrashProbe`（默认生产 Layer 为 no-op，正式服务
不能通过普通用户环境变量开启故障注入）。Probe 在指定事务边界前或提交后暂停，
父测试进程确认精确边界后杀进程，再用未注入的生产 Composition 从同一 DB 重启。
不能用固定毫秒 sleep 猜测“应该已落盘”。

每个 case 记录：命中的边界和侧别、旧/新 lease generation、Provider 请求次数、
Turn/Step/Session/action 唯一身份、Command Receipt、Tool effect 数、最终公开回复或
Attention。DB/ledger 检查仅属于 AH 资格测试；F01–F23 仍以公开 API/浏览器作
成功判定。AH1/2 已确认 Attempt Success 与 Turn settled 在同一事务，并已测试
该原子提交的前/后态；没有发明不存在的中间提交点。

## 退出门

AH1–AH14 每个实际提交边界的两侧均有命名测试和持久证据；无完整 Provider 成功
证据时仅允许受策略约束的 same-Turn retry，完整成功证据存在时禁止新请求；
NonIdempotent/Reconcilable 工具“effect 已发生、settlement 未落盘”必须进入
ReconciliationPending/Attention，不可盲重放。随后运行 `pnpm check` 与相关公开
功能测试，并更新 `planning/results/agent-loop-step-implementation-progress.md`。

AH15–AH19 另有 SCRC-008 结果，不得挪用其 PASS 代替 AH1–AH14。

P9 `07` §4 另要求密集立即可用 SSE 期间证明实际 TTL/3 lease renewal
提交。`tests/functional/process/p9-dense-sse-lease-renewal.functional.test.ts`
已在真实 SQLite 上读到
同 generation 的 `expires_at` 前移、SSE 当时仍活跃且已消费超过 512 帧，
最终 Provider 请求一次、Attempt/Turn 成功；见
`planning/results/P9-dense-sse-lease-renewal.result.md`。这是独立续租资格，
不能替代 AH7/AH10 的崩溃矩阵。
