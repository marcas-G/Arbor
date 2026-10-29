# AgentLoopStep 命名与实现授权

## 决定

**AUTHORIZED — 2026-09-30。**

人工治理接受把当前设计中的持久 `AgentTurn` 重命名为
`AgentLoopStep`，并授权进入实现。

## 术语

```text
AgentLoop       = 整体 Agent 执行循环/Runtime algorithm
AgentLoopStep   = 循环内一次持久、可恢复的逻辑步骤
ProviderTurn    = 一次逻辑模型决策
ProviderAttempt = ProviderTurn 下的一次 transport attempt
```

该改名不改变 DID v1.20 AHT-1…AHT-8 的状态机、事务、不变量、恢复或验收
语义。被审阅提案/评审/提交单继续使用历史术语 `AgentTurn` 并保持原 SHA-256。

## 实现授权范围

- migration `0017_agent_loop_step_handoff`；
- `AgentLoopStepStore` / action ledger / sourced Session append；
- Provider success atomic settlement + replay read；
- AgentLoop driver handoff、successor、settlement proposal；
- P9 legacy adoption/recovery；
- AH1–AH14、branch-specific assertions 和 DOGFOOD-DG-01 等价 fixture。

## 安全边界

保全的真实失败数据库在等价 fixture、迁移重入、完整性检查和恢复结果全部通过前
保持只读。授权实现不等于授权跳过证据直接修改该数据库。
