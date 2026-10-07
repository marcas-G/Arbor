# AH7 SQLite cross-connection NonIdempotent concurrency — result

日期：2026-10-07
状态：**双连接定向资格 PASS；AH7 整体仍 PARTIAL / OPEN**

测试：`adapters/persistence-sqlite/test/p4-ah7-cross-connection-concurrency.test.ts`
命令：

```text
pnpm exec vitest run adapters/persistence-sqlite/test/p4-ah7-cross-connection-concurrency.test.ts
```

结果：1 file / 2 tests PASS。仅运行该定向文件；Biome 与
`git diff --check` PASS。未修改产品源码、migration 或冻结文档。
主 Agent 加入临时目录清理的绝对路径与专属前缀护栏后，独立复跑
2/2 PASS（3.23s）。
随后完整 `pnpm check` PASS：架构 155、核心 315 文件 / 1707 passed +
3 skipped（包含本文件两项）、Web 216；lint、类型检查与 Web 构建均通过。
本批尚未重跑 `pnpm test:functional`；该功能批次也不含此适配器级并发测试。

## 两项独立证据

1. **SQLite 唯一约束**：两个不同 SQLite Layer/连接、同一落盘文件并发执行
   `ToolInvocationStoreLive.recordIntent`。一方 Insert 成功，另一方得到
   `PersistenceConstraintViolation`；`PRAGMA table_info(tool_invocations)` 证实
   `invocation_id` 是主键，最终该 invocation 只有一条 intent。
2. **ToolRuntime 与外部 effect**：两个独立 SQLite Layer/连接分别运行真实
   `ToolRuntimeLive`；共享 barrier 使两次 NonIdempotent 调用同时开始。Executor 向
   独立效果日志追加唯一 marker。最终只有一行 marker、一条持久 intent、一条
   Success settlement。竞争方要么在 IntentJournal 主键冲突处失败关闭，要么看到既有
   NonIdempotent invocation 后返回 OutcomeUnknown；不会执行第二次 effect。

两连接通过独立 SqliteClient 对象确认，且双方 `PRAGMA database_list` 的 main 数据库
路径相同。本资格在同一 Node 进程内覆盖两个真实 SQLite 连接；没有启动第二个操作系统
进程，也不是进程 crash/restart 资格。P4 的事务和 `(executionId, invocationId)` 持久
唯一键语义不要求仅由单进程内存锁保证，因此此双连接测试验证了数据库共享边界；它
不替代另行要求的多进程资格。

这关闭了 AH7 同 ToolInvocationId 双连接并发的一个测试缺口，但不关闭 AH7：审批与
settlement 原子性/治理、非 Success Observation 回放、主动 reconciliation、一般 A/B
失败交错及 AH7-DG-01/02/03 仍须分别处理。
