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
