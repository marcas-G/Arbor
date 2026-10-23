# P41 manifest mismatch recovery-order fix

状态：**实现与定向单测完成；NOT PROCESS QUALIFIED**。

## 变更

恢复驱动在通用 `AgentLoopStepReplayBindingMismatch` 前增加窄分类入口。仅当
精确 DecisionEpisode 的已提交 DecisionRequest、当前 cursor 的 Pending
`select_current_work` Control Action，以及同一 ProviderTurn 的 settled-success
result 均可读取，且 ProviderTurn 自有 manifest 的 execution/session/step/
provider-turn 身份完整、result manifest 与自有 manifest 一致，而唯一差异是
Step `manifestId` 不同时，纯 preflight 才产生精确的
`SubmittedDecisionBindingMismatch(StepManifestMismatch)` outcome 并延后该通用
hard-fail。Driver 立即把此 typed outcome 交给既有 ExecutionRuntime owning
boundary，由 P9 fact transaction 记录并返回 `RecoveryBlocked`；不会把
`manifestBound` 改写为 true 或继续进入模型上下文/Provider/action 流程。

此入口不解码或执行坏 Step manifest 下的 action，不重新请求 Provider，也不
修改 Step/Manifest。Stop-only 收尾仍只允许使用 ProviderTurn 自有 immutable
manifest 枚举并核对持久 action 身份。缺失/不稳定证据及其他 manifest 身份损坏
继续 fail-closed。

## 验证

- `pnpm build`：PASS。
- `pnpm exec tsc -b packages/agent-runtime/tsconfig.json --pretty false`：PASS。
- 定向 Vitest：`agent-loop-step-resume-cursor.test.ts` 与
  `model-decision-pinned-replay.test.ts`，28/28 PASS；回归断言 exact typed
  preflight outcome，并覆盖错误 Episode、非 Submitted/wrong cursor 与
  ProviderTurn source/result binding 损坏。
- Biome（3 个变更 TypeScript 文件）与 `git diff --check`：PASS。
- 独立静态复审：未发现 B0/B1；确认其他不匹配仍走原 hard-fail。
- 未运行真实 daemon、主 sweep、或全量功能套件；不构成真实进程资格证明。

## 原四案进程资格尝试

Web 产物缺失曾导致第一次运行在 daemon readiness（HTTP 503）失败；未将该次
运行作为 P41 证据。构建 `@arbor/web` 后，在提交
`15a25677757f1b06e309faf165d07a74dc91def7` 上按单 worker、无文件并行、retry 0、
bail 1 重跑原文件。完整 Vitest JSON、verbose 日志、进度文件与命令元数据位于
`.test-results/2026-10-23T14-44-03-p41-manifest-recovery-order-webdist/`。

首次完整文件尝试结果 **3/4 PASS、1 FAIL**：workspace/manifest before-commit 两案
通过，workspace after-commit 通过；manifest after-commit 在 90 秒内未观察到旧
daemon 的 `AH7AfterActionIntentCommit(select_current_work, actionIndex=0)` probe，
超时发生在测试注入坏 Manifest 之前。该失败不证明 P41 修复失败，也不能补足该
case 的资格。独立复核确认超时边界在坏 Step Manifest 注入前。失败测试期待未修改。

之后在同一 production source commit `15a25677757f1b06e309faf165d07a74dc91def7`
上，对唯一 manifest-after-commit case 单独运行，**1/1 PASS**；其余三案按
`testNamePattern` 明确 skipped。JSON、verbose、progress 与命令元数据位于
`.test-results/2026-10-23T15-05-37-p41-manifest-after-isolated/`。

现有证据因此是**分段 process 覆盖**：首次完整文件运行通过三案，随后独立运行通过
先前未达到坏 Manifest 注入点的第四案。未在同一个无中断完整文件运行中获得 4/4，
故 P41 仍 **PARTIAL / NOT FULL PROCESS QUALIFIED**；这也不是完整 release 资格。

为下一次 case-4 重测补入失败诊断：仅包裹旧 `select_current_work` action-intent
probe 等待；失败时保留 provider 工具/候选、P9 probe 尾部、旧 daemon PID/退出/错误，
并在同一只读事务中按精确 ProjectId 捕获 executions/steps/actions/decisions/events。
daemon 停止后通过共享 fixture archive 保存证据；归档失败也保留 fixture，并始终
以原 timeout 作为主错误。90 秒等待、测试流程及 P41 断言未改。此诊断补丁未重跑；
Biome、`tsc -p tsconfig.test.json --noEmit` 与 `git diff --check` PASS，独立复审确认
证据写入失败不会遮蔽原 timeout。资格仍是 3/4、**PARTIAL / NOT FULL PROCESS**。
