# P9 密集 SSE 期间实际续租提交资格

日期：2026-10-07

状态：**定向功能进程测试、F20 干净检出与 `pnpm check` PASS。**

`tests/functional/process/p9-dense-sse-lease-renewal.functional.test.ts`
使用真实 `runExecution`、
ProviderRuntime、OpenAI-compatible SSE Adapter、本地 HTTP 服务与 SQLite
LeaseService。保持生产经验值 TTL=30 秒、续租间隔 TTL/3=10 秒，不缩短
租约或人工改写 lease 行。流按批写入立即可用的小帧，批间有界让出事件循环；
续租前已消费/写出各超过 512 帧。

测试在 SSE 响应仍活跃时只读查询 `execution_leases`，比较同一 generation
的初始与后续 `expires_at`，证明续租事务实际提交；随后结束 SSE，并断言
Provider 只请求一次，Attempt 为 Success、ProviderTurn 为 Stop 且二者
均已结算，持久 canonical events 含终结文本。总测试上限 25 秒、续租
等待上限 17 秒、帧数和 HTTP 背压有界。

子 Agent 定向 1/1 PASS；主 Agent 在原位置复跑两次、移至符合 P12 架构
边界的功能测试目录后再复跑一次，均 1/1 PASS，`pnpm typecheck`
与单文件 Biome PASS。该证据补 P9 `07` §4 的 dense SSE/TTL/3 实际
续租要求，不是 AH1–AH14 任一提交边界的进程崩溃注入，也不关闭 AH7/AH10。

提交 `5708e1e` 上，两条定向功能测试（本项 + F20 干净检出）2/2 PASS。
移至符合 P12 运输边界的功能测试目录后，`pnpm architecture` 155/155、
`pnpm typecheck` 与 `pnpm lint` PASS。首次定向复测时尚未运行完整
核心/Web 及全部功能批次，不能把上述定向结果写成完整门禁通过。

后续在 `c39004f` 上完整 `pnpm check` PASS：架构 155、核心 1705 + 3
skipped、Web 216；构建、lint 和类型检查均通过。完整
`pnpm test:functional` 仍未在此提交运行，不能把 F20 + 本项 2/2
写成整个功能批次通过。

## 集成负载复核与当前证据（2026-10-08）

在包含 AH10 扩展但尚未修正本测试 oracle 的提交 `47e9249` 上，首次完整
`pnpm test:functional` 的 Vitest 结果为 **21/22 files、52/53 tests**；唯一失败
是本测试在首次观察到 lease renewal 时采到 `framesConsumed=481`，低于既有
冻结资格阈值 `>512`。该次 Vitest 失败后 Playwright 阶段未启动。这个失败被
保留为负证据，没有写成 PASS。相同提交下 P9 定向测试连续两次 1/1 PASS
（test 约 10.82s、10.91s），说明差异出现在完整套件负载下，而非续租本身
没有提交。

诊断确认 `framesConsumed` 是 fetch wrapper 在 `controller.enqueue` 前计数，不能
单独声称 Runtime 已持久化这些事件；旧 oracle 也只检查首次 `expires_at` 前移的
单一采样。测试修正在 `101e009` 与 `3ffb17a` 分两步落地，未改生产代码、30s
lease 或 `>512` 阈值：每个采样都要求当前真实 lease row 的 generation 不变且
`expires_at` 相对上一条已观察的真实 row 增长；同一采样点要求 SSE response 活跃、
写出/消费帧均 `>512`，并从 SQLite `provider_attempts.canonical_event_prefix_json`
计数持久 `TextDelta >512`。若首次 renewal 快照不足，测试继续等待下一次真实
TTL/3 renewal，等待上限 35s、stream idle 40s、turn/test 上限 45s；没有降低阈值或
增加用于凑帧的固定等待。最终版本定向测试 2/2 PASS（test 约 10.734s、10.747s），
TypeScript test typecheck 与单文件 Biome PASS。

在最终提交 `3ffb17ac1f1daf74096a028f79f6a24c5842d1df` 上：F20 committed clean
checkout 1/1 PASS（66.36s）；完整 `pnpm test:functional` PASS，Vitest **22/22
files、53/53 tests**（1501.85s），Playwright **2/2**（44.1s）。P9 在整套中
11.104s 通过，执行同一采样的持久 TextDelta 阈值、真实 TTL/3 lease 前移、活跃
SSE 与 Provider/Attempt/Turn 单次成功断言。此前 `pnpm check` 在 `47e9249`
通过（core 1708 + 3 skipped、architecture 155、Web 216）；P9 测试后续变更仅
额外运行了 test typecheck 和单文件 Biome，本最终提交未重跑完整 `pnpm check`。
