# F18 / ProviderTurn V2 / AH19 跨设备续跑检查点

日期：2026-10-22  
分支：`codex/native-sandbox-preintent-final-20261021`  
组合基线：`31d2ce4c15a1c8e5816f7f6841e10bc15db4b116`  
当前检查点提交：见本文件所在提交。  
状态：**AH19 定向续跑进行中；全量 release qualification 未通过/未完成。**

## 组合来源与审阅状态

组合记录 `F18-P10-P1-combined-integration-candidate.result.md` 载明共同基线
`6c70f46cdfc0bb6ab35de15c24880dfbc99df274`，ProviderTurnId V2 / Pre-intent
来源 `3a9bad7261f22f26e362a10642ce47dd665e79c6`，F18 来源
`60383ab9e9756cd5b34d4c030a97023055ee9290`；按来源顺序重放 29 个提交，未跳过提交。
设计文件在 DID v1.58 下增量合并两个已接受包，保留各自语义，没有产生新治理决定。

ProviderTurn V2 实现记录的独立审阅为 B0/B1/B2 = 0/0/0；F18 的 `620cf911`
定向复审也为 0/0/0。后续兼容测试提交及当前组合 HEAD 的最新独立复审仍未完成，
不能把来源包复审扩展成当前 HEAD 复审。

## 现有 core 与 Web 证据

F18 检查点记录：Core batches 1–21 通过；batch 22 首次失败是 P9 测试向严格写入器
写入未注册 poison rows。改用测试专用 raw SQL 注入历史 poison rows 后，受影响 P9
文件定向通过；独立 batch 23 为 7 files / 59 tests PASS。Web typecheck/build 通过，
Web Vitest 为 34 files / 262 tests PASS。上述是已记录的分批证据，不等价于本组合
当前 HEAD 的一次完整 `pnpm check`。

## 两次完整 functional 尝试

两次尝试均在组合基线 `31d2ce4` 上运行 `pnpm test:functional`，构建阶段通过，
functional Vitest 阶段失败，Playwright 因前置阶段失败没有启动：

1. `.test-results/2026-10-21T17-07-32-067Z-15156/`：AH19
   “reconstructs the public latest-64 Work frontier after pre-checkpoint restart”
   在 `waitForPublic` 超时，`last=undefined`，调用点为该测试文件第 3487 行；Vitest
   记录耗时约 110 秒。现有日志没有确认 daemon/runner 的更深层原因，不能推断为已修复。
2. `.test-results/2026-10-21T17-17-43-130Z-25352/`：AH19
   “fails closed when ordinary Native startup has two same-epoch candidates”在
   第 5024 行等待公共 fail-closed 结果超时。最后快照仍是 epoch 0、没有 checkpoint，
   source ProviderTurn 已落库但 Execution 未结算。测试 fixture 曾以字符串拼接构造
   第二个 ProviderTurn/Manifest ID，违反当前冻结的 V2 identity/manifest 合同；本检查点
   的 `0ea1e513` 将其改为从 Execution、下一 logical step 与 epoch 使用 V2 构造器，
   并通过 `functionalId("mft")` 生成合法 ManifestId。此原因对应 fixture 问题，仍需
   在修复后的完整 functional run 中验证。

## AH19 续跑与停止点

丢失 runner 的取证痕迹是 `.test-results/ah19-startup-884.jsonl`，最后记录时间
2026-10-22 20:16:37，最后场景为 `AH19 checkpoint-boundary startup
AH17AfterCheckpointEpochCommit`。子 daemon 在运行时路径、layer 和 schema 验证后
exitCode=1，`killed=false`；该日志没有 Vitest 断言、最终 runner manifest 或 runner
退出码。因此只能确定最后活跃场景，无法断定是测试断言失败还是外部 runner 退出。

本续跑先确认该 worktree 没有遗留 AH19/Vitest/daemon 进程，并提交纯测试 fixture 修复
`0ea1e513a59ab8ee63194618db3674c9c8dfd455`。随后完整 AH19 文件以单 worker、无文件并行
启动。以下 11 个测试依次显示 PASS：

- 3 个 Root Work fake 回归；
- startup diagnostic payload exclusion；
- 公共 Work Session history 进入 Native compaction；
- pre-checkpoint restart 重建 latest-64 Work frontier；
- `AH17Before` / `AH17After` 两个边界下 filtered HumanConversation frontier；
- `AH17Before` / `AH17After` 两个边界下真实 ProviderNative checkpoint；
- `AH17Before` source identity restart recovery。

在此之后 Vitest 自动启动了 `AH17AfterCheckpointEpochCommit` source identity case。
为了设备切换，整文件 runner 被 Ctrl-C；该次完整文件运行没有最终汇总，未完成项不计 PASS。
被中断 case 随后以精确 testNamePattern 单独重跑并通过（1 passed / 43 skipped，78.85 秒）。
因此当前可报告的是 **11 个完整文件运行中的已观察 PASS，加 1 个精确隔离 PASS**；
其余 case 仍须在后续设备续跑。被中断 runner 的最新日志仍保留在 `.test-results/`。

测试运行生成的两个未跟踪 schema44 fixture 目录在核对绝对路径位于本 worktree 内、
`LinkType` 和 `Target` 为空后，移动到
`C:\Users\ThinkPad\AppData\Local\Temp\arbor-ah19-fixture-archive-20261022-2038\`；
没有删除。AH19 精确重跑完成后检查未发现残余 Node/Vitest/daemon 子进程。

## 平台限制与下一步

AH19 qualification 使用 test-only Native-capable Provider adapter；stock provider 不
宣称 Native continuation。当前 Windows Native sandbox provider 仍是 Experimental，
空 profile/network tuple，返回 typed Unavailable，生产 `run` 尚未接入。因此真实生产
Native provider restart/continuation 资格受外部 provider/platform 能力限制；本地模拟
适配器的过程资格不能替代它。

后续设备应在本分支最新提交上先检查 status、构建与端口，再按默认串行配置补跑该 AH19
文件尚未完成的用例，随后执行当前 HEAD 的 `pnpm check`、`pnpm test:functional`
（包含完整功能 Vitest、Playwright 与 clean-checkout journey），并单独记录
`pnpm test:functional:ui` / `pnpm test:package` 所需结果及任何真实生产 provider/restart
资格。不要把上面分批/定向 PASS 合并成全量门禁结论。
