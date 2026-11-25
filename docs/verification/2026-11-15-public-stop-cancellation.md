# 公共 StopExecution 取消 Provider 验证

日期：2026-11-15；当前工作树源码与构建产物。

## 验证内容

使用公开 HTTP API 创建项目、通过公开对话创建 Work，并让真实守护进程连接到一个
故意不返回模型响应的 HTTP Provider。随后通过公开 `StopExecution` 命令停止同一
Execution。Provider 响应在停止命令提交前一直保持挂起，测试没有释放它来推动流程。

结果：停止标记提交后，运行中的 Provider 请求被标准 `AbortController` 中断，Provider
attempt 从 `InProgress` 收敛，Execution 不再保持为当前活动运行；停止路径没有创建
新的 Provider 调用。最终恢复扫尾继续负责 `Interrupted(StopRequested)` 或副作用未知
时的既有 reconciliation 处理。

## 实现落点

- `packages/execution-runtime/src/execution-runtime.ts` 以 100ms 有界轮询观察持久
  `stop_requested_at`，触发运行控制中断，并释放当前 lease。
- `packages/ports/src/execution.ts` 将标准 Provider cancellation signal 传入驱动。
- `packages/agent-runtime/src/agent-loop-driver.ts` 与 `model-decision.ts` 原样传递
  信号到 `ProviderRunInput`。
- `packages/provider-runtime` 已有的 `AbortController`、attempt 取消落盘和 provider
  transport signal 继续负责取消细节。

## 证据

定向测试：

```text
pnpm exec vitest run --config vitest.functional.config.ts \
  tests/functional/process/stop-held-provider.functional.test.ts
```

结果：1 file / 1 test passed。该测试使用真实 daemon、真实 SQLite、公开命令和真实
HTTP 请求边界；Provider 内容是脚本化挂起响应，因此它证明公共取消链路，不能替代
真实外部 Provider 的发布资格，也不能证明 Native 进程副作用的完整停止/恢复矩阵。

## 边界

这次修复解决的是运行中的 Provider 取消入口。Native 进程、网络工具、跨调用共享
服务、两个正式 Workspace 同时运行和安装包完整发布资格仍按
`docs/KNOWN_PROBLEMS.md` 的独立问题验收。
