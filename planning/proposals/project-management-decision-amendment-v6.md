# 项目管理决策修订包 v6

## 状态

**DRAFT — 尚未接受，不授权实现。**

本包以固定 v4 base 与固定 v5 amendment 为基线，只取代 v5 review 指出的三处条款。最终治理决定须固定 v4 base、v5 amendment、本文、Design Gap、v6 submission 与 v6 review 的 SHA-256。

## V6-1：StepEffectsCommitted 不创建虚构 successor

v5 matrix 中“StepEffectsCommitted / NextStepReady”拆分如下：

- NextStepReady(successor) 及 OutputRejected(Retry(successor))：AHT-6 已将 exact successor identity durable commit；必须幂等 ensureSuccessor 物化那个 Prepared record，即使 Project Closed。该写入仅补齐既有 recovery identity，不启动 Provider/Tool/AgentAction。随后 Prepared successor 由现有 Stop/Quiescence 路径形成 Interrupted。
- StepEffectsCommitted：该状态并未 durable commit successor identity，Close 不得调用 ensureSuccessor 或发明 successor。控制面在真实 effect facts 都已解决时，依既有 AgentLoopStep 单调 CAS 形成 SettlementProposed(Interrupted(ControlledInterruption/StopRequested))；若存在真实非空 unresolved ToolInvocation refs，则形成既有 SettlementProposed(OutcomeUnknown(ReconciliationRequired(refs)))。随后 SettleExecution。不得从 session 文本或缺失 provider ref 构造 OutcomeUnknown。

所有 stop-generated transition 仍使用现有 AgentLoopStep identity/state transition，不能覆盖已 terminally committed predecessor disposition。由此 Closed execution 对每个 nonterminal handoff 都有唯一、合法、可恢复的终态路径。

## V6-2：legacy ProjectName 仅能通过受审计治理修复

首次 ProjectNamePolicy v1 preflight/backfill 的 fail-closed 规则不允许“治理外修复原始数据”。不合规或规范化后会改变 canonical name 的 legacy Project 只能经过**独立人工治理已接受的、审计化 migration/repair contract**处理；该未来合同必须定义 exact authority、旧/新值、Project revision、updatedAt、durable event、Closed lifecycle 是否可修复、directory invalidation、idempotency 与 crash recovery。

在该独立合同存在并成功执行前，v1 feature migration 不写这些行，ProjectDirectory/Rename/Close 产品面保持禁用；不得直接 SQL 改名、不得在 adapter 中静默 rewrite、不得标记为 v1。合规不变行的原子 metadata backfill 和 discriminator mapping 规则不变。

## V6-3：Design Gap 与归档协作停止一致

DPM-DG-01 已被同步修订：非目标是 hard delete、自动 Work cancel、强杀 execution 和 Reopen；Close 对当时 Active Execution 自动提交既有 cooperative StopExecution/Quiescence 是本治理包的正向语义，用于冻结新 activity、reconcile 已开始副作用并结算既有 execution。任何设计/实施文本不得把该协作 stop 表述为“没有自动停止执行”。

