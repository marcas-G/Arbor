# 对话响应中断后的再次尝试

日期：2026-11-14  
状态：用户已决定允许再次发送/再次尝试。实现与定向验证已完成。

## 用户可见行为

当对话响应在 admission 的中间边界中断，系统不猜测模型是否已经产生答案，也不自动重放原请求。系统会结束遗留的旧 Execution，将该消息标记为“需要处理”，并在页面提供“再次尝试”和“停止本次回复”。

用户选择“再次尝试”后，系统通过带 revision 检查的 `ResumeConversationResponse` 将消息重新排队。后续 admission 使用新的 Attempt 和新的 Execution；旧 Attempt/Execution 身份不会复用，因此不会把一次不确定的旧响应伪装成新响应，也不会因重复点击产生并行响应。

## 恢复规则

- 生产 admission 在同一事务中写入 ConversationResponse Execution、Attempt 和 Running Job。
- 对历史或异常半状态（匹配的 ConversationResponse Execution 已存在、Job 仍可排队、Attempt 缺失），启动恢复和周期恢复会结束旧 Execution，并写入 `AdmissionInterrupted` Attempt。
- 半状态恢复后的 Job 为 `NeedsAttention(UnknownFailure)`，`nextAttemptNo` 前进，后续人工再次尝试必须使用新的 Attempt。
- 运行中的响应不能通过该命令直接取消；用户应使用现有的停止执行操作。非运行状态可以取消。

## 实现与证据

主要实现位于：

- `packages/execution-runtime/src/commands/admit-execution.ts`
- `packages/application/src/conversation-response-runtime.ts`
- `packages/application/src/commands/conversation-response.ts`
- `apps/single-workspace/src/production.ts`
- `apps/web/src/pages/workspace/ConversationTab.tsx`

覆盖证据位于：

- `tests/functional/pending/conversation-admission-restart.functional.test.ts`
- `tests/p17-conversation-response-commands.test.ts`
- `tests/p17-conversation-response-runtime.test.ts`
- `apps/web/test/conversation-tab.test.tsx`

本决定只处理对话响应 admission 的中断恢复，不改变 `docs/design/**` 的冻结语义，也不授权保留用户数据库升级或进程执行能力。
