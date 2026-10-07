# AH7 SQLite cross-connection NonIdempotent concurrency — result

日期：2026-10-07
状态：**双连接 + 双进程定向并发资格 PASS；AH7 整体仍 PARTIAL / OPEN**

测试：`adapters/persistence-sqlite/test/p4-ah7-cross-connection-concurrency.test.ts`
命令：

```text
pnpm exec vitest run adapters/persistence-sqlite/test/p4-ah7-cross-connection-concurrency.test.ts
```

结果：1 file / 3 tests PASS。仅运行该定向文件；Biome 与
`git diff --check` PASS。未修改产品源码、migration 或冻结文档。
主 Agent 加入临时目录清理的绝对路径与专属前缀护栏后，独立复跑
2/2 PASS（3.23s）；加入双 OS 进程场景和有界退出护栏后，主 Agent
独立复跑 3/3 PASS（4.79s）。
随后完整 `pnpm check` PASS：架构 155、核心 315 文件 / 1707 passed +
3 skipped（当时本文件两项）、Web 216；lint、类型检查与 Web 构建均通过。
本批尚未重跑 `pnpm test:functional`；该功能批次也不含此适配器级并发测试。
加入双进程第三项并清理 helper 格式后，再次完整 `pnpm check` PASS：
架构 155、核心 315 文件 / 1708 passed + 3 skipped（含本文件三项）、
Web 216；lint、类型检查和 Web 构建均通过。

## 三项独立证据

1. **SQLite 唯一约束**：两个不同 SQLite Layer/连接、同一落盘文件并发执行
   `ToolInvocationStoreLive.recordIntent`。一方 Insert 成功，另一方得到
   `PersistenceConstraintViolation`；`PRAGMA table_info(tool_invocations)` 证实
   `invocation_id` 是主键，最终该 invocation 只有一条 intent。
2. **ToolRuntime 与外部 effect**：两个独立 SQLite Layer/连接分别运行真实
   `ToolRuntimeLive`；共享 barrier 使两次 NonIdempotent 调用同时开始。Executor 向
   独立效果日志追加唯一 marker。最终只有一行 marker、一条持久 intent、一条
   Success settlement。竞争方要么在 IntentJournal 主键冲突处失败关闭，要么看到既有
   NonIdempotent invocation 后返回 OutcomeUnknown；不会执行第二次 effect。
3. **两个 OS 进程竞争**：两个 Node 子进程各自构造 SQLite Client 和真实
   `ToolRuntimeLive`，连接同一个临时 DB 文件。每个进程在真实
   `ToolDefinitionStore.definition` 入口发 IPC ready 并等待；父测试确认两个 distinct
   PID 都就绪后才同时发送 go。两个进程共享外部 effect log，结果只有一条 effect marker、
   一条 intent、一条 Success settlement；败者是 `IntentJournal` fail-closed 或
   OutcomeUnknown。该场景验证了跨进程数据库唯一键与副作用保护。

两连接通过独立 SqliteClient 对象确认，且双方 `PRAGMA database_list` 的 main 数据库
路径相同。双进程场景在 release barrier 前记录并断言两个子进程 PID 不同；没有依赖
sleep 猜测竞争时序。它是同步并发资格，不是进程 crash/restart 资格。测试辅助脚本位于
`adapters/persistence-sqlite/test/fixtures/ah7-cross-process-tool-runtime-child.mjs`；
测试使用位于系统临时目录且校验父路径与专属前缀的数据库和 effect log，结束后清理。

这关闭了 AH7 同 ToolInvocationId 双连接/双进程并发的一个测试缺口，但不关闭 AH7：审批与
settlement 原子性/治理、非 Success Observation 回放、主动 reconciliation、一般 A/B
失败交错及 AH7-DG-01/02/03 仍须分别处理。
