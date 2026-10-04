# AH3 ProviderTurn → AgentLoopStep 进程崩溃资格结果

日期：2026-10-04

状态：**AH3 提交边界两侧 PASS；AH1–AH2、AH4–AH14 仍 OPEN。**

## 测试方式

`tests/functional/process/provider-success-ah1-ah3.functional.test.ts` 使用真实生产
SQLite、HTTP 模型边界和独立后台进程。测试专用入口
`tests/functional/support/ah-crash-child.mjs` 在 Composition 中显式注入进程内
`qualificationProbe`；正式 CLI 不从环境变量装配该 probe。父测试进程收到精确
边界信号后用进程杀死机制停止后台，再由正常生产入口、同一数据库重启。

两侧分别是：

1. `AH3BeforeStepAvailable`：ProviderTurn 已持久结算，AgentLoopStep 仍为
   `Prepared`；
2. `AH3AfterStepAvailable`：ProviderTurn 已持久结算，AgentLoopStep 已为
   `ProviderResultAvailable`。

杀进程后只读 SQLite 快照检查上述状态和同一 ProviderTurnId，并确认旧租约尚未
过期。恢复后的公开 transcript 恰有一条目标 Assistant 回复，HTTP Provider
仅收到一次目标请求，Execution 最终 durable settled。两个测试单独及合并通过。

## 红灯发现与修复

首轮真实重启出现 `LeaseFencingRejected(generation=0)` 并导致新守护进程退出。
快照证明没有 stop request、settlement event 或 due timer；根因是生产
`conversationTick` 对仍持有有效旧租约的 Active Execution 直接调用
`runExecution`，没有先走 P9 T4 的 lease-fence pre-dispatch predicate。
相同问题也可能出现在 ExecutionBound 与审批恢复分发入口。

`apps/single-workspace/src/production.ts` 现在对三个入口共用
`preDispatchCheck`：旧租约尚有效时静止，TTL 到期再接管；检查后竞态导致的
`LeaseFencingRejected` 只跳过本次分发，不终止整个 daemon。

探针是未持久化、未模型暴露的测试注入；不改 Provider/Step 语义或生产默认路径。

## 门禁

```text
pnpm exec vitest run --config vitest.functional.config.ts \
  tests/functional/process/provider-success-ah1-ah3.functional.test.ts
  2 / 2 PASS
```

`pnpm check` PASS（架构 155、核心 1677 + 3 skipped、Web 216）。
`bb1df77` 上完整 `pnpm test:functional` PASS：公开进程 17/17、浏览器 2/2，
包含从该提交的干净检出测试，零重试。此结果不代表整个 AH1–AH14 矩阵完成。
