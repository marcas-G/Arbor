# SCRC-DG-02 — Context Overflow 后继 ProviderTurn 身份

## 状态

**OPEN — blocks SCRC-007 overflow integration and SCRC-008 final closure.**

## 失败证据

Provider 返回 `ContextLimitExceeded` 时，当前 ProviderTurn 已持久绑定旧
ModelContextManifest 和 portable request。Summary/Native compaction 会产生新
ContextEpoch 和不同 request。现有恢复合同明确拒绝同一 ProviderTurn 下
manifest/request 不一致；AgentLoopStep 又只保存一个 `providerTurnId`。

因此不能同时满足：压缩后用新 Context 重试、ProviderTurn Manifest immutable、
保持同一 logical AgentLoopStep、且不把 overflow 伪装成 output repairAttempt。

## 需要治理的最小问题

冻结 AgentLoopStep 内有序 ProviderTurn chain，或定义不同于 output repair 的 stable
overflow successor identity；同时明确旧 Turn 终止、replacement binding、恢复、
幂等和 settlement。

## 必须保持

- durable assistant/tool effect 后禁止全步 replay；
- 最多一次 overflow recovery，第二次 terminal；
- completed action ledger 不重放；checkpoint/epoch 原子；
- 不修改旧 ProviderTurn Manifest；不新增 Work/Execution lifecycle 状态。

## 当前处置

Summary/ProviderNative/budget primitives 保留；自动 overflow successor wiring 停止。
不得用 `_r1` repairAttempt 或随机 TurnId 绕过。
