# 功能测试补齐：2026-10-07 续工分配

状态：执行中；不得将局部用例通过写成发布就绪。

本批基线：`78013fe`（AH7 两条 Port 定向补测）、`4720f65`（AH10 两类
控制动作与真实双 daemon 接管）。`pnpm check` PASS（架构 155、核心 1687
+ 3 skipped、Web 216）；在 `4720f65` 上 `pnpm test:functional` PASS
（公开进程 42/42、浏览器 2/2，含 F20 干净检出）。两项 AH7 补测不是
真实进程资格，AH10 仍只覆盖一个真实接管场景；见各自结果记录。

第二批（基线 `ec4e843`）：`ah10_takeover` 负责 `DeclareDependency` 与
`AcceptResult` 的跨代 receipt-first 定向测试/必要实现；`ah7_coverage`
负责把同 invocation 并发验证提升到真实 SQLite 适配器。两项都不得将
单元/适配器测试外推为真实进程崩溃矩阵；主 Agent 复核后再决定提交与全量门禁。

第二批后续：`a22a4a5` 补 `DeclareDependency`/`AcceptResult`，`d7e5782`
补 `SendMessage`；`32ae550` 将五类 Gateway 动作的旧回执机械查询收敛成
一个内部 helper。该提交 `pnpm check` PASS（架构 155、核心 1701 + 3
skipped、Web 216），相关公开场景 7/7、AH10 双 daemon 1/1、F20
干净检出 1/1 PASS。完整功能批次没有在 `32ae550` 重跑；不得把旧
`4720f65` 的完整批次记为本提交证据。AH10 仍 PARTIAL。

## 本批并行边界

| 工作流 | 负责人 | 允许的改动 | 验收证据 |
|---|---|---|---|
| AH10 跨租约接管 | `ah10_takeover`（GPT-6 Luna/high） | AH10 测试、控制命令的 receipt-first 恢复和必要夹具；不改 `docs/design/**` | 旧代 `Committed` 不重发、`FencingRejected` 才允许新 ID、旧写被 fence、同一动作最多一次效果、Provider 不重跑；真实进程提交边界两侧 |
| AH7 剩余边界 | `ah7_coverage`（GPT-6 Luna/high） | AH7 专属测试及不受治理缺口阻挡的修复；不碰 AH10 控制命令文件 | 精确失败再通过的定向测试；明确仍受 AH7-DG-01/02 约束的部分 |
| 统筹与验收 | 主 Agent | 交叉核对冻结合同、审查 diff、排除工作区旧产物、定向复测与最终汇总 | `pnpm typecheck`、lint、architecture、相关功能测试；稳定批次后再跑完整 `pnpm check` 与 `pnpm test:functional` |

共享夹具修改先经主 Agent 协调，避免并发覆盖。子 Agent 不提交、不推送；主 Agent 审核后按精确路径提交。

## 本批之外的门禁

- AH14 正向 legacy adoption 2/2 通过，但负向持久 Attention 的 `AH14-DG-01` 未获人工治理；不以正向结果关闭 AH14。
- F21–F23 分别受 `FT-DG-01/02/03` 约束；现有治理审阅仅表明提案可提交，未构成人工接受。不得自行改写 `docs/design/**` 或把 pending 红测移成假绿灯。
- 完成声明需要逐项复核 `01-functional-journey-catalog.md` 的 F01–F23、`02-agent-loop-step-crash-qualification.md` 的 AH1–AH14，以及开放治理缺口。测试全绿不自动等于合同覆盖完整。
