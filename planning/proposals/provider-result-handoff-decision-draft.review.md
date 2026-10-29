# Provider 结果交接决策草案 — 审阅意见

审阅日期：2026-09-30。

审阅对象：`planning/proposals/provider-result-handoff-decision-draft.md`。
行号以本次审阅时的草案为准；后续修改后请按章节定位。

结论：方向合理，但尚不足以关闭 DOGFOOD-DG-01 或作为实现契约。以下意见是审阅建议，不是人工治理裁决，也不授权修改冻结设计或实施新状态机。

## R1 / P1：稳定 CommandId 会继承旧租约的永久拒绝

位置：草案 §6，第 138–142 行；关联 §7，第 149–151 行。

DID §9.9 明确 `FencingRejected` 属于 `TerminalRejected`。当前 Gateway 在发现已有命令结果后，直接返回既有 receipt，不会因新的租约拥有者重试而重新执行。

反例：旧 worker 提交动作被 fencing 拒绝，拒绝结果已提交；新拥有者恢复时复用草案规定的稳定 CommandId，仍然得到永久拒绝。因此稳定 ID 本身不足以保证接管后可以继续。

结算命令还有相关问题：现有 SettleExecution payload 包含 `expectedFencingGeneration`，它参与语义指纹。新拥有者更换 generation 后，复用同一 CommandId 会产生不同指纹，触发 `IdempotencyConflict`。

建议：由治理明确逻辑动作身份、命令尝试身份和既有结果查询之间的关系，保持已提交动作去重，同时允许按正式规则处理旧拥有者的 terminal rejection。增加“旧拥有者拒绝已提交 → 新拥有者恢复”的并发/故障用例。

依据：

- `docs/design/03-detailed-implementation-design.md` §4.1、§9.9。
- `packages/application/src/gateway.ts`：既有 resolution 查询、指纹校验和 fencing 拒绝持久化。
- `packages/execution-runtime/src/execution-runtime.ts`：SettleExecution payload 和指纹构造。

## R2 / P1：成功 Attempt 与 Turn 结算之间仍可能重复请求

位置：草案 §7，第 157–158 行；关联 §10，第 194–204 行。

当前 Provider Runtime 分两个事务提交 `ProviderAttempt Success` 和 `ProviderTurn settled`。在前者提交后崩溃，完整成功事件已经持久化，但 Turn 仍未结算。

草案对所有未结算 Turn 采用“同 Turn 新 Attempt”，会允许再次发出 Provider 请求，与 §10 第一个注入点要求的“无重复 Provider 请求”冲突。

建议：明确成功 Attempt 优先本地完成 Turn 结算，或将成功结果和 Turn 结算原子提交。未结算 Turn 的恢复必须区分是否已有完整成功结果。

依据：

- `packages/provider-runtime/src/runtime.ts`：Success 分支分别调用 `tx.transact(store.settleAttempt(...))` 与 `tx.transact(store.settleTurn(...))`。
- `docs/design/implementation/P9/04-provider-tool-hardening.md` §2.2。

## R3 / P1：状态机缺少失败和修复耗尽的终止路径

位置：草案 §3，第 71–78 行。

图中 `Prepared` 只有 Provider 成功出口，输出无效只有继续 repair 的出口。若 Provider 已终止失败，或达到输出契约修复上限后崩溃，恢复表没有合法推进路径。按当前图到达 `SettlementProposed` 又必须先接受有效输出。

建议：增加无需 ModelOutput 的持久失败/中断提案路径；明确修复上限、耗尽后的 disposition 和旧 repair 记录的终态；增加这些分支的提交前后故障注入。

依据：

- `docs/design/implementation/P3/06-provider-failure-repair.md` §2–§3。
- `packages/agent-runtime/src/repair.ts`：`RepairDecision.Exhausted`。
- `packages/agent-runtime/src/driver.ts`：有效输出产生前返回结算提案的分支。

## R4 / P1：必须允许部分动作完成后放弃剩余动作

位置：草案 §6，第 141–145 行；关联 §3 状态图。

反例：动作 A 已提交，崩溃期间 Work revision 改变，恢复执行 B 时触发 `DecisionStale`。冻结契约要求不执行 B 并重新 prepareTurn，但草案要求所有动作完成后才能提交观察、进入下一回合或结算，恢复因此没有合法推进路径。控制动作还可能直接返回结算提案，而不产生普通 Observation。

建议：持久记录剩余动作被跳过、失效或提前终止的 disposition，保存已完成动作的观察，并明确重新决策与结算出口。恢复既要避免重放 A，也不能执行已过时的 B。

依据：

- `docs/design/implementation/P3/06-provider-failure-repair.md` §4。
- `packages/agent-runtime/src/driver.ts`：freshness 检查及 handler 的 Settle 分支。

## R5 / P2：原始故障数据没有 AgentTurn，尚无接入路径

位置：草案 §7，第 155–166 行。

DOGFOOD-DG-01 的现存数据库只有成功 ProviderTurn、Active Execution 和未写入的 Session 输出，没有新增的 AgentTurnRecord。恢复表要求读取 AgentTurn 状态并核对绑定，却没有定义记录缺失时的处理，因此部署新状态机也不能直接恢复本次故障。

建议：补充受治理的旧数据迁移/对账规则：哪些持久证据足以建立交接记录；无法唯一确定进度时如何保留并上报；已写 Session 或动作的旧记录如何幂等处理。用原始故障的等价数据夹具验证迁移后能够收敛。

依据：

- `planning/gaps/DOGFOOD-DG-01-settled-provider-turn-active-execution.md`。
- 草案 §4 要求结果绑定与 AgentTurnRecord 一致，但 §7 未列缺失记录分支。

## 审阅范围与后续处理

本次为静态契约与代码审阅，以崩溃/接管反例核对恢复闭合性；未运行测试，未修改草案、冻结设计或实现代码。工作区存在其他未提交改动，代码依据是审阅时的工作区状态。

处理本审阅时，请逐条标记 R1–R5 为接受、部分接受或不接受，并给出修订位置或反证。如修订草案，仍须保持 DRAFT/等待人工治理；审阅意见本身不构成设计治理授权。
