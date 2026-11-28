# Provider 边界与支持矩阵

更新日期：2026-11-28

本文是当前实现的工程导览和发布口径。它不修改 `docs/design/**` 的冻结合同。
Provider 的“支持”必须同时满足协议实现、请求/响应能力、配置装配和
deployment 级资格证据；仅仅把模型名发送到一个兼容端点不构成发布支持。

## 职责边界

| 层 | 负责 | 不负责 |
|---|---|---|
| `model-context` | 根据已解析的 `ModelCapability` 编译便携请求、控制输入预算、保留绑定后的 reasoning 附件引用 | 选择供应商、拼接 HTTP 请求、解析供应商响应 |
| `ports` | ProviderPort、canonical event、failure taxonomy、deployment/profile 的纯数据合同 | 访问网络、读取凭据、判断模型是否“应该”调用工具 |
| `provider-runtime` | attempt 生命周期、deadline、取消、观察事实、持久化、恢复和重试决策 | 选择协议、拼接 provider body、执行工具或解释模型语义 |
| `adapters/provider-*` | 一个协议族的 wire request/response 翻译、SSE/JSON 解析、协议错误到 canonical failure 的转换 | Work/Agent 决策、权限、工具执行、持久化、跨协议 fallback |
| `apps/single-workspace` | 读取配置、解析 SecretRef、建立 registry、解析 `ModelDeployment`，在 Composition Root 装配 adapter | 把供应商协议逻辑散落到 transport、runtime 或 UI |
| qualification | 对具体 `(adapter, deployment)` 观察能力，绑定 endpoint、wire model、版本和 fingerprint | 修改 catalog 声明或替 deployment 自动“升级”能力 |

`ProviderRegistry` 是静态注册表。模型目录只决定 `modelRef -> adapterId` 和
声明能力；具体 endpoint、wire model、凭据引用和配置参数属于
`ModelDeployment`。`ResolvedModelBinding` 是唯一允许进入运行时的解析结果。

## 当前支持矩阵

| 供应商/协议 | Arbor adapter | 当前可用范围 | 当前状态 |
|---|---|---|---|
| OpenAI-compatible Chat Completions SSE | `provider-openai` | 文本、流式、工具调用、结构化输出请求、`reasoning_content` 解析；显式 reasoning 参数由 deployment 配置传入 | 已实现；每个 deployment 仍需资格 |
| DeepSeek compatible endpoint | `provider-openai` | 通过 Chat Completions 兼容端点；可配置 `thinking` 或 `reasoning_effort` | 可接入；不能把单次连接成功当作 reasoning/tool qualification |
| Qwen compatible endpoint | `provider-openai` | 通过 OpenAI-compatible endpoint；可配置 `enable_thinking` | 可接入；具体模型和工具组合需单独资格 |
| OpenRouter | `provider-openai` | 通过其 OpenAI-compatible endpoint；路由和站点 headers 由 deployment 配置 | 可接入；路由后的实际模型必须绑定并重新资格 |
| OpenAI Responses API | 无 | `response.output`、reasoning items、`previous_response_id` 等 Responses wire contract 尚未有 adapter | Design Gap |
| Anthropic Messages | 无 | content blocks、thinking blocks、tool_use/tool_result 与 Chat Completions 不同 | Design Gap |
| Google Gemini `generateContent` | 无 | `contents/parts`, functionCall/functionResponse 和 thinking 配置需要独立翻译 | Design Gap |

兼容端点的“可接入”只表示它们共享现有协议族的 transport 形状。它不声明
供应商、模型、区域、路由结果或 reasoning round-trip 已通过资格。

## 缺口与处理顺序

1. **现有兼容族**：继续完善 deployment 配置、headers、model profile 和真实
   qualification evidence。DeepSeek、Qwen、OpenRouter 不新增 adapter。
2. **OpenAI Responses**：新增独立 `provider-openai-responses` adapter，保留
   `provider-openai` 的 Chat Completions 语义；需要单独定义 reasoning item、
   continuation 和 tool round-trip 的 wire tests。
3. **Anthropic Messages**：新增独立 adapter，不能把 thinking block 降级成
   `reasoning_content` 后宣称无损支持；必须证明 tool pairing、thinking 回传和
   usage 映射。
4. **Gemini**：新增独立 adapter，明确 streaming JSON/SSE、function calling、
   safety finish reason 和 thinking token 的映射，再建立 deployment 资格。

在第 2–4 项的设计治理完成前，不能把对应 adapter 加进生产 registry，也不能在
catalog 中声明其 native capability。Fake/testecho 只能证明扩展机制，不能证明
真实供应商行为。

## 变更准则

- 新模型但 wire contract 不变：只改 catalog/deployment/qualification 数据。
- 新供应商但复用已资格化协议：不改 core，不复制 adapter；新增 deployment 级
  identity 和证据。
- 新 wire contract：新增 `adapters/provider-*`，只依赖 `domain` 和 `ports`，
  通过 registry 装配；禁止修改 `provider-runtime` 来适应供应商字段。
- Provider adapter 输出 canonical event 前必须完成 wire validation；未知字段可以
  丢弃，未知终止状态、损坏工具参数和不完整 reasoning payload 必须 fail closed。
- 任何协议配置改变都必须进入 binding fingerprint，使旧 qualification evidence
  自动失效。

