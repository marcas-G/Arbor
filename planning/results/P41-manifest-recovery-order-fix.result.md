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
