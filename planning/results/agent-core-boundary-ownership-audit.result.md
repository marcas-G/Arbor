# Agent Core 边界所有权审计结果

**状态：COMPLETE / LIVE B11 CLOSED 3/3 — 2026-10-03**

## 所有权矩阵

| 语义 | 唯一所有者 | 下游只可做什么 | 禁止重复实现 |
|---|---|---|---|
| Provider policy / retry / phase timeout | `provider-runtime` + `ports/provider-policy` | Adapter 执行 cancellation 与已解析的最终 deadline | Adapter/测试选择 timeout、retry 或 maxAttempts |
| Provider wire encode/decode | ProtocolAdapter | Runtime 消费 canonical events | 测试、Agent Loop 自建 OpenAI messages/SSE parser |
| Durable interaction facts | Session Timeline repository | Context Projector 读取 typed items | 保存 provider JSON 作为 replay truth |
| Inbox delivery | Application `InputPromotionService` | Agent Loop 在 safe boundary 触发一次性 promotion | Model Decision 每轮直接读取 unconsumed Inbox |
| Model-visible context | `model-context` ContextProjector/compiler | Agent Loop 请求 PreparedTurn | Agent Runtime 维护第二个 Session/Inbox assembler |
| Loop progression | `agent-runtime` AgentLoopStep/action ledger | Application/settlement boundary执行 canonical mutation | Adapter、prompt 或 UI 推断完成状态 |
| Executable action | ToolRuntime | Agent Loop 路由 typed invocation | Model-facing name承担授权身份 |
| Control action | ControlToolRegistry → AgentAction → owning Application | Model Context 只投影 definition | 通用 directive、字符串路由或 provider-specific action |
| UI / qualification | public API / production adapters 的观察者 | 发起、展示、记录证据 | 复制 Runtime、Context 或 Provider 逻辑 |

## 本轮已删除的重复实现

1. 真实 Provider 资格测试自建的 OpenAI request lowering、SSE parser、deadline 与
   error taxonomy；测试现在只包装正式 `OpenAICompatibleFetchClient` 记录证据。
2. `agent-runtime/src/session-context.ts`：与 ContextProjector 重复的 Session assembler。
3. `agent-runtime/src/inbox-context.ts`：绕过 durable InputPromotion 的 Inbox→Prompt
   旁路；未消费 Inbox 只能在 safe boundary 原子提升进 Session 后进入上下文。
4. ProviderExecutionContext 中 adapter 不应理解的 connect/first-event/idle/retry
   policy 字段；这些策略只由 ProviderRuntime 解析和执行。

统一资格测试与正式客户端后暴露并修复了四个生产缺陷：HTTP 响应开始未进入
observation、缺失 SSE terminal frame 被误判 Stop、未知 finish reason 被误判 Stop、
取消未向底层 stream reader 传播；同时原生 `ECONNRESET` 不再被提前包装为 503，
由 adapter taxonomy 正确分类为响应前 `TransportFailed`。

## 已加机械保护

- P3 architecture test 断言 Agent Runtime 不再存在第二个 Session/Inbox assembler；
- Model Decision 源码禁止 `listUnconsumed` 和 `assembleInboxContext`；
- OpenAI renderer 仍在网络发送前校验 typed call/result pairing；
- control tool 使用 stableId 处理授权/replay，新 Turn 只暴露无品牌 modelName；
- legacy `arbor_*` alias 仅按旧 Manifest version/hash replay。

## 仍需收敛

1. `PortableLegacyMessage` 只应保留为外部兼容输入，不得重新成为生产 universal
   carrier；需继续用架构测试限定生产 `ModelDecision` 只提交 typed inputItems。
2. 等待策略默认值需要真实模型时延证据后再调整；本审计只确定所有者，不改变
   60s/30s/5min 系统默认或 deployment override。
3. B11 已使用重构后的正式客户端和官方 DeepSeek Flash 完成 3/3 稳定性
   验证。资格测试现在创建隔离 Git 工作树、绑定 `FileTree/GitWorktree`、要求
   模型先读取真实证据，再调用 `claim_completion`；Work 保持 `Open`，未绕过
   Verification/Acceptance。
4. `WSC-DG-01` 已裁决并关闭；五条跨工作流 signal route 均已统一接入生产
   daemon。

## 验证

- lint / typecheck：PASS；
- architecture：132/132 PASS；
- Provider Runtime integration：25/25 PASS；
- Provider conformance：44/44 PASS；
- SSE segmentation：19/19 PASS；
- core：278 files，1612 PASS / 1 Windows conditional skip；
- Web：31 files，212/212 PASS；
- production Web build：PASS（既有 chunk-size warning，不是本轮回归）。
- official DeepSeek Flash B11：L1/L2/L3 PASS，真实 Provider 3/3 PASS；
  报告：`planning/testing/core-capability/reports/capability-real-provider-2026-10-02T16-36-09.651Z-43d54834-8597-4931-8386-8c25f9b53e45.json`。
