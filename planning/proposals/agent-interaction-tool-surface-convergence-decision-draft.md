# Agent 交互与工具表面收敛 — 治理决议草案

**状态：ACCEPTED — 人工治理于 2026-10-02 授权落字与实现。**

## 1. 要解决的两个问题

### A. 模型不应感知 Arbor 内部实现

模型应只看到可完成当前任务的动作词汇，例如 `claim_completion`；不应因内部产品
名称、包名、handler 名称或持久化身份而学习 `arbor_claim_completion`。

### B. 模型输出、运行时事实、模型输入混在一起

流式 provider chunk 是临时传输数据；ToolCall/ToolResult 是持久化事实；下一次
provider request 是按协议、模型能力和 token 预算编译出的投影。三者不得互相充当
对方的存储格式。

## 2. 决议

### D1：四层交互边界

```text
Provider wire stream
  → Provider adapter assembly
  → canonical Session / action ledger
  → Context Compiler
  → provider-specific renderer
  → Provider wire request
```

- **Provider adapter assembly** 只接收流式 chunk、组装完整 tool-call batch、生成
  `CanonicalProviderEvent`；不执行工具、不决定 AgentAction。
- **canonical ledger** 只记录已解码、可关联、可恢复的事实：Text、ToolCall、
  ToolResult、ControlResult、ContextUpdate、Checkpoint。它不保存 provider JSON
  作为重放真相。
- **Context Compiler** 是唯一从 trusted policy、Session Timeline、当前 Work、
  budget 和 ResolvedTurnProfile 编译 `PortableModelRequest` 的语义入口。
- **provider renderer** 只把 `PortableModelRequest` 编码为一个协议族的请求。它不
  注入 Arbor 指令、不猜测 authority、不重新解释 tool semantics。

现有 SCRC/P3/P17 的 typed timeline、`PortableInputItem` 和 TurnProfile 保持；本决议
只补全其唯一入口、跨调用复用和 identity 规则。

### D2：Tool identity 与模型可见名称分离

每个注册工具定义为：

```ts
interface ToolIdentity {
  readonly stableId: string;       // 例：core.control.claim-completion
  readonly version: string;
  readonly implementationHash: string;
}

interface ModelToolSurfaceEntry {
  readonly identity: ToolIdentity;
  readonly modelName: string;      // 例：claim_completion
  readonly description: string;
  readonly schemaJson: string;
}
```

- `stableId` 是 registry、authorization、handler、manifest 和 replay 的唯一身份；
- `modelName` 只属于当前 ProviderTurn 的模型协议表面；
- 同一个 `ResolvedTurnProfile` 中 `modelName` 必须唯一；冲突导致 profile 不能编译，
  而不是暴露品牌前缀；
- Agent/Model Context 均不得通过 `modelName` 推断授权；provider output 必须先由
  本 Turn 的 manifest 将 name 解析为 `ToolIdentity`；
- ToolCall ledger 同时保存 `callRef`、`ToolIdentity` 和本 Turn 的 `modelName`。

### D3：新 Turn 的无品牌控制工具表面

| stableId | 新 modelName |
|---|---|
| `core.control.wait` | `wait` |
| `core.control.send-message` | `send_message` |
| `core.control.claim-completion` | `claim_completion` |
| `core.control.propose-workspace` | `propose_workspace` |
| `core.control.spawn-specialist` | `spawn_specialist` |
| `core.control.declare-dependency` | `declare_dependency` |
| `core.control.record-verification-evidence` | `record_verification_evidence` |
| `core.control.conclude-verification` | `conclude_verification` |

`claim_completion` 的语义是“提交完成声明，触发独立验证”，不是完成 Work。

### D4：严格的工具协议投影

对 OpenAI-compatible renderer，连续 ToolCall 必须映射为一个 assistant message 的
`tool_calls` 数组；随后必须有每个 `callRef` 的一个 tool result。一般约束为：

```text
每个 callRef：恰好一个 ToolCall，恰好一个 Tool/Control Result
ToolResult 不得先于 ToolCall
同批 ToolCall 先完整出现，再出现该批全部结果
无结果的中断调用明确投影为 error result 或不进入后续 frontier
```

发送请求前，所有 renderer 必须运行 provider-neutral sequence verifier。失败是本地
`ProtocolViolation`，不得将已知非法请求发给 provider。

### D5：上下文编译规则

Context Compiler 按独立的来源和预算槽组装，而非序列化整个系统：

```text
C0 运行时安全与协议规则                 固定、不可由模型文本覆盖
C1 当前使命：责任、Work、约束、完成要求   分别带 revision/provenance
C2 已提升的协调输入                       一次性、source-keyed
C3 已闭合的对话/工具交互 frontier          按 callRef 保持协议关系
C4 观察和交付证据                         DataOnly，超长时摘要/引用
C5 检索知识                               可丢弃
C6 按需模块/技能                          渐进披露
工具目录                                  由 TurnProfile、权限、能力决定
```

任何未闭合的调用都不能进入下一 ProviderTurn。Context Compiler 可回退到最后一个
闭合 frontier，或请求恢复；不得编造文本化 tool observation 来绕过 pairing。

### D6：兼容与迁移

- 新建 Turn 使用新 `modelName`；
- 旧 Manifest 必须记录或能够解析其历史 name → ToolIdentity 映射，并按原 profile
  replay；
- 新旧 modelName 不在同一个 Turn 同时广告；
- 无法解析历史 alias 时，Turn 必须 typed stale/blocked，不能按字符串猜测路由；
- 不改变 Work、Verification、Acceptance 的领域状态机。

## 3. 实现授权后的交付顺序

1. 先写 sequence verifier 与多调用、交错结果、中断、重启 replay 的失败测试；
2. 提取唯一 OpenAI-compatible renderer，真实资格测试不得再维护一份 lowering；
3. 将控制注册迁移到 `ToolIdentity + ModelToolSurfaceEntry`；
4. 迁移 Manifest、Session ToolCall、decoder 和 registry 的 identity lookup；
5. 在 new-turn profile 中切换到无品牌 modelName；
6. 跑单元、架构、生产进程黑盒和 B11 真实模型连续 3 次资格测试。

## 4. 明确非目标

- 不以 prompt wording 替代 protocol verifier；
- 不让模型直接完成 Work；
- 不修改 provider adapter 之外的 provider wire 格式；
- 不把 OpenCode 的 Session/产品对象照搬进 Arbor；
- 不因工具改名删除历史审计或破坏旧 Execution 恢复。

## 5. 建议接受语句

`ACCEPT_AGENT_INTERACTION_TOOL_SURFACE_CONVERGENCE`
