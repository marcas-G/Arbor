# P9 direct Control gen1 lease-timeout diagnosis

状态：**已证实为测试续租竞态；测试编排修正待定向复测；NOT QUALIFIED**。

## 原 sweep 证据

主 sweep `.test-results/2026-10-23T07-58-30Z-ae2630-remaining8/` 中，
`agent-loop-p9-direct-control-effects.functional.test.ts` 为 9 PASS、1 FAIL、1
SKIP。唯一失败为 `update_plan suppresses a live stale gen0 effect after gen1
commits the same action`。该 case 在 gen0 生成 `AH7AfterActionIntentCommit`、测试
过期其 generation-0 lease 并启动 gen1 后，等待 45 秒仍未观察到 exact
`AH10AfterLeaseAcquired` probe；gen1 `startAdditionalDaemon` 已返回，错误附带
`last=undefined`、`daemonErrors` 为空。候选逻辑没有报告更深的执行或 Action 结果。

原 JSON、progress 与 log 未保存 project/execution/lease snapshot、AH10 probe 尾部、
provider 调用摘要或 gen1 PID 快照。该 run 的 schema44 失败 fixture 未找到；已有
schema44 根目录的创建时间晚于本次 case，且不能归属该失败。没有据此判断运行时接管
实现失败，也没有修改生产代码、45 秒等待或测试期望。

后续精确复现归档 `.test-results/2026-10-23T08-47-24Z-d89103-priority-retests/`
证实原等待失败的原因：old gen0 在测试将 lease `expires_at` 改为 epoch 后继续续租。
归档中对精确 execution 的 `AH10BeforeLeaseRenewal` probe 共 5 次，均为
`pauseRequested=false`；失败快照中 lease 仍是 `worker:local`、原 incarnation、
generation 0，`updated_at=08:57:17.697Z`，`expires_at=08:57:47.697Z`。因此 gen1
没有可接管的过期 lease，未发出 `AH10AfterLeaseAcquired` 是该旧租约仍有效时的预期
结果；这不证明 Scheduler/Execution takeover 实现有缺陷。

## 诊断增强

测试文件现在让 `update_plan` 与 `claim_completion` 共用同一个 gen1 lease wait
failure capture。它记录测试的 project/work/execution/action/call tuple、失效前旧
lease 和失败时 lease、ExecutionEpisode、Step/Action、P9 direct effect projection、
ProviderTurn/Attempt、项目事件、provider 调用摘要、旧/新 PID 状态、stderr/startup
phase、AH10 probe 尾部和 gate 文件。SQLite rows 在单个只读事务内读取并精确限定
project/execution；诊断不替代公开成功断言。超时仍为 45 秒，成功流程未改变。

资格用例现仅在 test fixture 中打开旧 generation 的延迟 lease-renewal gate，观察到
精确 execution 的 `AH10BeforeLeaseRenewal(pauseRequested=true)` 后才把 gen0 lease
设为过期并等待 gen1 acquisition。旧 gen0 和旧 ActionIntent gate 保持存活；现有 gen1
commit 与 gen0 stale-effect suppression 断言不变。该测试编排修改未运行 process case，
尚待 root 排定的单 case复测。

静态验证：目标文件 Biome 与 `pnpm exec tsc -p tsconfig.test.json --noEmit` PASS。
未运行测试或 daemon。

## 待安排的精确 case

```powershell
pnpm exec vitest run --config vitest.functional.config.ts --maxWorkers=1 --no-file-parallelism --retry=0 --bail=1 --testNamePattern 'update_plan suppresses a live stale gen0 effect after gen1 commits the same action' --reporter=verbose --reporter=json --reporter=./scripts/testing/vitest-progress-reporter.mjs --outputFile <runDir>/report.json tests/functional/process/agent-loop-p9-direct-control-effects.functional.test.ts
```

运行前设置 `ARBOR_TEST_RESULT_DIRECTORY=<唯一run目录>` 与
`ARBOR_VITEST_PROGRESS_BASENAME=P9-update-plan-gen1-takeover`。保留相同 case 的原有
45 秒条件；本记录不声称该 case 或 release qualification 通过。
