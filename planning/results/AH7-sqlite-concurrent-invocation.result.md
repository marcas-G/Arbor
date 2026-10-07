# AH7 SQLite 同一 ToolInvocationId 并发重入补测

日期：2026-10-07

状态：**真实 SQLite 适配器定向测试 PASS；AH7 仍为 PARTIAL。**

`adapters/persistence-sqlite/test/p4-ah7-concurrent-invocation.test.ts`
使用实际 `TransactionPortLive`、`ToolInvocationStoreLive` 和 P4 迁移，在
同一 SQLite 连接上并发提交两次相同的 NonIdempotent invocation。最终
持久库仅一条 intent、一条 Success settlement，执行器外部 effect 仅一次；
竞争调用或在 intent 唯一约束处失败关闭，或观察既有非幂等 invocation 后
返回 `OutcomeUnknown`。子 Agent 定向运行两次、主 Agent 独立复跑一次，均
1/1 PASS。

该用例把先前 Port fake 证明提升到了真实 SQLite store，但仍限于单连接
transaction harness；不是多连接/多进程竞争，也不是 kill/restart 崩溃资格。
审批消费与 P4 settlement 事务窗口、AH7-DG-01/02 和一般多动作交错仍开放。
