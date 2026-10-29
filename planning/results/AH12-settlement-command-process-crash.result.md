# AH12 SettlementProposed → SettleExecution 进程崩溃资格

日期：2026-10-05

状态：**本文所列 SettlementProposed→SettleExecution 与 CompletionClaimed→Verification 启动恢复资格 PASS；真实 CommandGateway 事务 COMMIT 前及提交后强杀恢复均通过；本批完整功能集成门禁 PASS。资格仅覆盖本文明确的 CompletionClaimed 链，不代表 AH1–AH14 整体完成。**

`tests/functional/process/agent-loop-ah12-settlement-command-crash.functional.test.ts`
使用生产 daemon、隔离 SQLite 和 HTTP Provider。Provider 在一个 Turn
调用 `wait`，先持久化 `SettlementProposed`，随后 Execution Runtime 以
当前 lease generation 提交 `SettleExecution`。测试专用进程内探针分别在
Gateway submission 前、返回已提交回执后暂停，杀进程并从同一数据库以
无探针的正式入口重启。测试子进程用环境变量选择暂停点；正式入口不会
据此装配探针，公开请求也不能启用它。

两侧断言：

- 提交前快照：Step 为 `SettlementProposed`、`wait` 已 Applied、
  Execution 仍 Active，尚无结算 Command 回执。
- 提交后快照：同一 proposal 不变，Execution 已结算，恰有一条
  `Committed` 的结算 Command 回执。
- 重启后两侧都只有同一 proposal、同一 action、一个已结算 Execution、
  一条结算回执，原 Work revision 仍为 0；Provider 只请求一次，daemon
  无错误。

最初探针未命中揭示 daemon 的新 Work 路径先经 `consumeWorkspaceWake`
而非恢复循环。探针接线覆盖该入口后，两侧定向测试 2/2 PASS。
`pnpm typecheck`、`pnpm lint`、架构测试 155/155 PASS。
该证据只关闭 AH12；AH7、AH10 的剩余缺口及 AH13–AH14 仍独立待证。

## 2026-10-09 CompletionClaimed→Verification 启动恢复增量

同一夹具让 WorkEpisode 的 Producer Provider 调用 `claim_completion`。首次增量
使用原名为 `AH12BeforeSettleCommandCommit` 的探针；该探针实际在
`ExecutionRuntime` 调用 `gateway.execute` **之前**，并未进入 CommandGateway 事务，
因此只能证明提交调用前状态，不能作为 COMMIT 前崩溃证据。它已重命名为
`AH12BeforeSettleGatewaySubmission`，仅作为独立的调用前边界保留。该首次增量
两侧定向 2/2 PASS，但不单独宣称真实事务 precommit。

首次增量定向命令：

```text
pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-loop-ah12-settlement-command-crash.functional.test.ts
```

结果：2/2 PASS（BeforeSettleGatewaySubmission、AfterSettleCommandCommit）。

- Before：`agent_loop_steps.settlement_json` 持久保存 `Completed(CompletionClaimed)`
  proposal；Execution 仍 Active、`executions.settlement_json` 为空、无结算回执和
  `ExecutionSettled` event。Work 唯一且仍为 Open/revision 0。
- After：同一 Execution 已结算，存在一条 Committed 结算回执和唯一
  `ExecutionSettled` event；settlement 与 event 的 CompletionClaimed 绑定相同
  WorkId、revision 0 和 claimRef。尚未观察到 Verification 不作为失败条件。
- 两侧重启后均收敛到唯一 Open Verification（目标 Work/revision 0、verdict null）、
  一条 Committed `StartVerification` 回执、唯一绑定的未结算 Verifier Execution；
  Work 仍 Open/revision 0，Producer 的 `claim_completion` 仅有一次 Provider 请求，
  仅有一个 Producer action 和一个结算回执，daemon 无错误。

恢复边界：StartVerification 命令回执、Verification 行、Verifier AdmitExecution 与
Verification 执行绑定是可重放的后续步骤；本资格只要求最终唯一收敛，不要求它们
与 Producer settlement 或彼此处于同一事务。Verifier Provider 返回未给出 verdict
的文本，故本项不覆盖验证结论、Acceptance 或 Work 完成。

### 真实 CommandGateway 事务 COMMIT 前边界

新增仅测试组合注入的 `gatewayQualificationProbe`。它仅匹配
`ExecutionOrigin` 的 `SettleExecution`，并在 `makeCommandGatewayLive` 的事务体内，
Command Handler、ExecutionSettled event append、Committed receipt 和 resolving
attempt 写入之后、`TransactionPort` 发出 COMMIT 之前暂停。正式生产组合不配置该
probe。原 `AH12AfterSettleCommandCommit` 仍保留为事务已提交后的边界。

定向命令仍为上面的 Vitest 命令，最终结果为 3/3 PASS：

- `AH12BeforeSettleGatewaySubmission`：旧的 ExecutionRuntime 调用前边界；
- `AH12BeforeSettleExecutionCommit`：CommandGateway 真实事务 COMMIT 前边界；
- `AH12AfterSettleCommandCommit`：Committed 回执返回后边界。

TDD RED：从 test child 临时移除 Gateway probe 注入，只运行
`-t AH12BeforeSettleExecutionCommit`，测试在 4.18 秒按预期失败并报告
`AH12 probe absent`（另外两例 skipped）。恢复 test-only 注入后，最终定向矩阵
3/3 PASS。

在真实 COMMIT 前暂停期间，独立只读 SQLite 连接观察到 Producer Execution 仍 Active，
`settlement_json` 为空；该 SettleExecution 的 Command receipt、command attempt、
`ExecutionSettled` event 和 Verification 均不可见，Work 仍唯一且 Open/revision 0。
强杀后同库重启，未提交事务回滚；新 generation 通过唯一 Committed SettleExecution
receipt 收敛，最终只有一个 `ExecutionSettled` event、一个 Open Verification、一个
绑定到该 Verification 的未结算 Verifier Execution 和一条 Committed StartVerification
receipt。Producer Execution 在崩溃快照及恢复快照均明确绑定
`WorkEpisode/workId/revision=0`；CompletionClaimed settlement 与 event 保持同一
WorkId、revision 0、claimRef。Work 保持 Open/revision 0，Producer claim Provider
调用一次，无第二 Producer action，daemon 无错误。

门禁前 `pnpm check` PASS：Biome 964 files（有一条既有
`model-decision.ts:3917` non-null assertion warning）；TypeScript build/typecheck；
architecture 31 files / 158 tests；core 319 files / 1745 passed、3 skipped；Web
typecheck/build 及 31 files / 223 tests。Web build 有既有 chunk size 提示。门禁前尚未
运行 `pnpm test:functional`。此结果不覆盖 Verification verdict、Acceptance、Work
完成、AH7/AH10 其余缺口或 AH13–AH14。

### Review 补强

独立 review 后追加三项窄补强并复跑定向 3/3：

1. `SingleWorkspaceConfig.gatewayQualificationProbe` 标明为 test-only；生产启动不
   从环境变量或 HTTP 请求装配该 probe。
2. 恢复后的 `ExecutionSettled` event payload 也逐字段核对同一 Producer
   Execution、WorkId、revision 0、claimRef 与 `Completed(CompletionClaimed)`。
3. 恢复后的 Execution、Work、Verification、VerificationExecution、settlement 与
   StartVerification receipts、ExecutionSettled events 由一个 SQLite read-only
   transaction snapshot 一次读取，避免跨查询混入不同时点。

在上述补强后的验证：AH12 定向 3/3 PASS；`pnpm typecheck` PASS；`pnpm lint` PASS
（964 files，仍仅有既有 `model-decision.ts:3917` warning）；`pnpm architecture`
PASS（31 files / 158 tests）。当时未重跑 `pnpm check`，最近完整结果见上节；本次修改
仅补充测试 oracle 与 probe 配置注释，没有改变运行时行为。

## 2026-10-09 最终集成门禁

冻结本批工作树后串行运行 `pnpm check`，随后运行一次完整
`pnpm test:functional`；两项之间及执行期间没有编辑。结果：

- `pnpm check` PASS：Biome 964 files（仅既有
  `packages/agent-runtime/src/model-decision.ts:3917` non-null assertion warning）；
  TypeScript build/typecheck；architecture 31 files / 158 tests；core 319 files、
  1745 passed / 3 skipped；Web typecheck/build 与 31 files / 223 tests。Web build
  有既有 chunk-size 提示。
- `pnpm test:functional` PASS：functional Vitest 31 files / 119 tests；Playwright
  3/3（F14/F15 approval and acceptance、F22 completed Work visibility、项目对话
  restart）。AH12 的三个测试均在该批中通过：Gateway submission 前、真实
  CommandGateway COMMIT 前、提交后强杀恢复。
- F20 clean-checkout 子测按定义从当前 HEAD 创建干净检出运行，因此只算
  HEAD 基线证据，不覆盖本批未提交 AH12 diff；其余完整功能批次针对当前工作树。

本结果的 CompletionClaimed 资格仅证明 Producer settlement 与
Verification 启动链在本文列出的崩溃边界后恢复为唯一绑定状态。它不覆盖
Verification verdict、Acceptance、Work 完成，也不构成 AH1–AH14 全部闭合或
其他 AH 项的新增资格。`docs/design/**` 未修改；完整门禁后 P12 实现文档与结果
仍相对 HEAD 无差异。门禁生成的 `planning/results/P12.restore-drill.json` 两个
运行期字段已按 HEAD 基线精确恢复。
