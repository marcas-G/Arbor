# STEP P1-07 — Workspace Request API v0

**Gate/决策**：P1_06_09_GATES §P1-07A（D-037）：四个高层请求工具
（inspect_workspace / report_status / report_blocker / report_completion）；
请求只表达意图、绝不直接改正式状态（REQUEST_PROJECTION_BRIDGE 的 Bad/Good 清单）；
每次调用记 transcript `workspace_request` 事件，uuid requestId = 幂等键。

**实现地图**：
- `agent-runtime/tools/workspace-requests.ts`：makeWorkspaceRequestTools({pkg, record, onCompletion})
  - inspect：渲染 ContextPackage（身份/合同/资源/有效状态）
  - status/blocker：记录后返回确认
  - completion：记录 + 委托 onCompletion（P1-08 的 finalization）并把裁决文本回给模型
- `application/agent-runner.ts`：工具接入（record → transcript writer 延迟绑定；
  onCompletion → finalizeCompletion）

**不变式**：请求工具不触碰 effective ref / store——唯一的正式状态变更路径是
report_completion 触发的 Runtime-owned finalization。

**验收**：unit（inspect 渲染、记录 payload、completion 委托）+ acceptance（见 P1-08：
真 init 下 agent 报完成 → transcript 含 workspace_request/report_completion）。
