# 人工补充指导后的任务继续与重复提交

日期：2026-11-15。基线：`e7065a7cb06938a045a00d449b5b345f52cff8eb`
加当前未提交工作树。没有修改设计合同或历史结果文件。

## 实际问题与复现

1. 通过公开 API 创建项目、发送目标、批准分工，让 Work 执行并显式等待人工输入。
2. 等待本次 Execution 结束，通过公开 SteerWork 补充指导。
3. Work revision 正常增加，但没有下一次 Work Provider 请求，任务一直停在 Manual 等待。

完整 `pnpm test:functional` 首先在 AH19 的
`enters ordinary Native compaction from public Work Session history` 暴露超时。
随后 F07 `tests/functional/process/human-steer.functional.test.ts` 独立复现：
指导已提交，后续执行不发生。失败报告保留于
`.test-results/2026-11-14T21-07-27-364Z-553645/`。该批次遇首个失败后停止，
报告中列出的选中文件不能解释为已执行了全部用例；Playwright 未执行。

首次修复恢复继续执行后，增加同一 CommandId 的公开重试，发现新的错误：
任务已经吸收指导并再次等待，重复回执却把这个新等待也解除，Work Provider
调用数从 2 增为 3。该用例先失败，再通过既有 Inbox 消费记录修复。

## 实现与既有合同

- `apps/single-workspace/src/transport/composition.ts` 的 SteerWork 提交后路径，
  改用既有 `HumanIntervention`，携带目标 Work 和原命令 revision 对应的
  `steer:<workId>:<revision>` Inbox key；重试不从最新 Work revision 推导原输入。
- `packages/application/src/wake-sink.ts` 只释放该目标 Work 的普通 Manual 等待。
  同一事务读取原 HumanInput 是否仍未消费；已消费或缺失时，不解除后续等待。
  `Manual + InboxAdvanced` 的 Blocked 等待仍要求绑定的 Inbox sequence 前进。
  普通 InputArrived 不会因此解除 Manual 等待。
- 继续使用现有调度、事务、Inbox、Command receipt；没有新增 wire 格式、
  schema、后台消息系统或权限，也没有抢占普通指导正在运行的 Execution。
- 依据为 P2 `05-scheduler-wait.md` 的 Manual/HumanIntervention 与精确等待、
  P6 `04-human-steer.md` 的局部 HumanInput/重新求值，以及既有 F07 公开行为。

另将 `tests/p12-filesystem-runtime.test.ts` 的跨工作区写入断言改为完整 P4
运行链路实际拥有的 `Denied(ResourceResolutionDenied)`。裸 executor 的输入错误
断言保持原语义；越界目标内容未改变的检查仍保留。该集成文件 6/6 通过。

## 已观察到的检查结果

- 人工指导修复前，一次完整 `pnpm check` exit 0：lint 1491 文件、根 TypeScript、
  架构 38 文件/198 项、启动器 4 项、核心 492 文件的 50 批、Web typecheck/build
  及 Web 39 文件/294 项完成。核心保留既有跳过和 expected-failure，不将它们改写为成功。
- 最终后端修复：根 TypeScript、受影响文件 Biome、架构 198/198 通过。
- 唤醒、人工指导、Blocked settlement、依赖唤醒、Blocked 重启恢复：5 文件/22 项通过。
- 公开 F07、S2 revision/关键指导/重启回执、挂起 Provider 的 StopExecution：
  3 文件/3 项通过。此批次的 F07 已含重复提交检查。
- 随后强化 F07：加入 daemon 重启后再次提交同一指导回执，单项已通过；指导只被
  吸收一次，Work 保持 Open/revision 1，原回执保持一致，不增加 Work Provider 调用。
- 最终 F07 与原失败 AH19 场景合跑 exit 0：2 文件/2 项通过，另 43 项由 `-t`
  明确过滤。AH19 本项包含会话继续、压缩与 daemon 重启，但不代表整个 AH19 矩阵。

最终公开复测命令：

```bash
pnpm exec vitest run --config vitest.functional.config.ts \
  tests/functional/process/human-steer.functional.test.ts \
  tests/functional/process/ah19-provider-native-binding-recovery.functional.test.ts \
  -t 'delivers the revision-bound correction once|enters ordinary Native compaction from public Work Session history'
```

## 验证边界

这些公开流程使用真实 daemon、SQLite 和 HTTP Provider 边界，Provider 决策是脚本化的。
没有把这批证据称为真实外部模型、普通安装包、完整发布套件或干净 Linux VM 验收。
完整检查通过之后又发生了唤醒修复，完整检查不能继承为最终源码的同基线结论。

已验证成功提交之后的重复回执及重启重试，没有验证 SteerWork 提交与提交后唤醒之间
每个 crash 边界，也没有证明运行中指导与旧 revision 结算的全部竞争组合。
AH19 的 Native 指 Provider continuation/压缩机制，不是 Native OS 命令执行资格。
普通 production 的 Native OS Supported gate 仍关闭；命令副作用停止恢复、并行正式
Workspace 和包含构建测试的普通安装包任务仍待验收。
