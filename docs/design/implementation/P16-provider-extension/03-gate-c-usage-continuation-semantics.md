# P16 Gate C — Usage & Continuation Semantics (FROZEN design)

**Status**: Gate C Design Closure. 本轮只治理/设计；不修改 production code、不接真实新 Provider。
**Baseline**: master@6f181f6（Gate B FORMALLY CLOSED）。
**Scope guards（违反即越权）**: 不接真实新家族；不改 Agent Runtime / AgentAction；不实现 cache extraction / continuation（仅语义冻结）；CanonicalProviderEvent 扩充仅在满足"最小 contract change"论证后随实现授权落地（§1.7）。

---

## C1 — Usage / Cache Usage Semantics

### 1.1 Canonical usage 模型（冻结）

```ts
/** Canonical usage record — the single provider-neutral usage vocabulary.
 * Every field is `number | null`: null = unknown/not reported. */
interface CanonicalUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningTokens: number | null;   // 见 §1.7 contract-change 提案
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
}
```

**Unknown ≠ 0（冻结，INV-C1-1）**：不可得 = `null`（或省略 optional 字段），**绝不写 0**。0 是"provider 明确报告了零"（合法：cache read 为 0 表示缓存未命中但被计量）。沿 P12 `04` UsageCost 的 `Unknown ≠ 0` 裁决下推到字段级。持久化 JSON 中同样保持 null 语义。

### 1.2 分层责任（冻结）

| 层 | 职责 |
|---|---|
| **ProtocolAdapter** | provider-native usage 帧 → `UsageReported` canonical 事件（一次 attempt 可能 0 或 1 个；末帧语义）。只翻译，不聚合，不派生 cost。不能提取的字段**省略**（≠0）。 |
| **ProviderRuntime** | attempt 事件 → Turn 级聚合：对**成功的最终 attempt**取值（retry 期间的失败 attempt usage 归入 attempt 行，不并入 Turn 聚合语义，但**计费上求和**——两列都持久化，见 §1.5）。 |
| **Model Context** | 不接触 usage（非语义内容；`02` Model-visible Projection 不含）。 |
| **Projection / Observability** | canonical usage → UsageCost 派生（P12 `04` 归属，priceSheetVersion 只在此层消费）。 |

### 1.3 Cache usage 是 capability-dependent（冻结，INV-C1-2）

`ProviderProfile.capabilityFlags.reportsCacheTokens`（Gate B 已冻结）是唯一声明面：
- `false` 的 adapter **不得**产出携带 cacheRead/cacheWrite 的 `UsageReported`（runtime 侧 observation 校验丢弃 + audit——与 A10 同款 fail-closed）。
- `false` 的 adapter 的 Turn usage 中 cache 字段 = null（未报告），不是 0。
- 伪造 0 = 合同违背（等价于错误分类伪造）。

### 1.4 不支持者不得伪造（冻结）

任何 provider/model 不支持的能力维度（cache、reasoning usage）在 canonical usage 中以 **null/省略** 表达。`declared != observed` 是 qualification FAIL 项（对接 C3 INV-C3-2）。

### 1.5 Persistence / telemetry 路径（冻结）

```
UsageReported (attempt 内 canonical 事件)
  → provider_attempts:       canonical_event_prefix_json 已含（attempt 级原样，既有行为，无新表）
  → provider_turns.usage_json: Turn 级聚合 { inputTokens, outputTokens, reasoningTokens,
                                  cacheReadTokens, cacheWriteTokens,
                                  attemptsBilledUsageJson }  // null 语义保持
  → onProgress (ProviderEvent): presentation-only（既有进度面，不新增通道）
  → settleTurn: 上述落库的唯一写点（P14/P15 既有写路径，无变更）
```
不新增持久化结构；`usage_json` 的 JSON 形状升级为 §1.1 模型（向后兼容：旧 JSON 缺字段 = null）。

### 1.6 Qualification 证明 cache extraction 可用（冻结）

一个 deployment 的 `cache usage extraction = PROVEN` 当且仅当：
- L3 three-run oracle：真实响应原生 JSON 的 cache 字段（如 DeepSeek `prompt_cache_hit_tokens`）与 canonical 事件值**逐次相等**（机械 diff），且 ≥3 次运行稳定；
- adapter `reportsCacheTokens = true`（声明面一致，INV-C3-2 前半）。
不满足即 `NOT_RUN`（无真实端点证据）或 `FAILED`（值不一致/伪造 0）。

### 1.7 Contract-change 提案：`reasoningTokens`（随实现授权落地，本轮不改）

Scope guard 要求 CanonicalProviderEvent 扩充的三条件论证：
1. **≥2 独立 provider 证据**：DeepSeek `reasoning_content`（usage 帧 `completion_tokens_details.reasoning_tokens` 同族）与 OpenAI o-series（`usage.completion_tokens_details.reasoning_tokens`）——两个独立协议族原生报告该维度；Anthropic thinking blocks 同类。
2. **现有抽象无法无损表达**：`UsageReported` 现字段只有 input/output/cacheRead/cacheWrite；reasoning 计量塞入 outputTokens 会与正文计量混淆，无法区分"模型推理消耗"与"输出消耗"——usage telemetry 与 cost 派生（P12）都需要独立维度。
3. **最小 change**：`UsageReported` 增加一个 optional 字段 `reasoningTokens?: number`（缺省 = null/未报告）。无新事件 tag、无新事件类型、ProviderRuntime/ModelContext/AgentRuntime 零变更（消费方仅 adapter 翻译层 + settleTurn 聚合 + observability 派生）。
不满足授权条件前，实现保持现状（省略）。

---

## C2 — Continuation vs Reasoning Round-trip

**总则（冻结，INV-C2-0）**：`ProviderContinuation` 与 `ReasoningRoundTripState` 是**两个不同概念**，禁止合并为单一万能 opaque state。前者是**传输位置**（provider 侧会话游标），后者是**语义内容**（模型推理上下文回传）。二者 owner、持久化位置、生命周期、resume 语义全部不同。

### 2.1 ProviderContinuation

| 维度 | 冻结语义 |
|---|---|
| 语义 | provider 侧可恢复状态引用（`previous_response_id` / server conversation cursor / resumable stream state）——**传输层的"接着说"**，不携带语义内容 |
| semantic owner | **ProviderRuntime**（P15 恢复面：attempt 中断后的续传决策） |
| opaque payload owner | **ProtocolAdapter**（`stateRef`/`cursor` 的编码是协议私有；runtime/上层只透传不解释） |
| persistence | `provider_attempts.continuation_checkpoint_json`（attempt 级）+ retry decision 内（P15 既有） |
| binding | **protocol adapter**（同族共享 resume 语义；换族即失效——跨族 fingerprint 必变） |
| retry/resume 使用 | `decideProviderRetry` 既有输入：checkpoint 存在 + `resumeGuaranteed === true` → 可 Resume；否则 Replay |
| SafeResume 条件 | adapter 声明 `supportsContinuation=true` **且** checkpoint 携带 `resumeGuaranteed=true` **且** `deliveredPosition` 满足幂等（未向下游投递，或 provider 幂等重放保证覆盖已投递前缀） |
| 只能 UnsafeReplay 条件 | 无 checkpoint；`resumeGuaranteed != true`；已产生部分下游投递且 provider 无幂等保证；checkpoint 解码校验失败（P15 既有 `provider-continuation-checkpoint-invalid`） |
| 进入 Model Context | **否——完全不透明**（DID/P3 既有语义：ContinuationState 对 Model Context 不透明；`02` §C0-C6 层不出现） |

### 2.2 ReasoningRoundTripState

| 维度 | 冻结语义 |
|---|---|
| 语义 | 上一 turn 的模型推理内容（`reasoning_content` / `reasoning_details` / thinking blocks）——**语义层的"接着想"**，多轮中回传 provider 以保持推理连贯 |
| semantic owner | **Model Context**（是否回传、注入哪些轮，是模型上下文编译决策——provider 依赖的编译参数） |
| opaque payload owner | **ProtocolAdapter**（每个协议的 reasoning 载体格式私有：字段名、结构、加密形态如 `reasoning.encrypted_content`；Model Context 只持有 opaque 附件 + 注入指令） |
| persistence | **conversation/projected turn history**（turn 的 provider-native 附件），manifest 记录引用（`contextRefs` + provider 附件类型）；不进 provider_turns（那是传输记录面），不进 Session history 正文 |
| binding | **model + protocol**（`modelRef` 级：换模型/协议即失效；编译时由 model-family compiler 决定注入形态） |
| restart/retry/resume 使用 | restart 后新一轮 compileTurn 从 history 取附件注入 messages；**retry 同一 Turn 时**：完整 reasoning 附件已在请求中=重放（replay 语义），不构成 resume。**部分接收的 reasoning**（stream 中断只到一半）不可作为附件（内容不完整）——重试回退到无该附件的完整请求 |
| SafeResume 关联 | **不改变** Safe/UnsafeReplay 判定（它是请求内容不是传输状态）；仅当 provider 声明 reasoning 附件与 continuation cursor 组合安全（如 OpenAI stored reasoning + previous_response_id）时，两者**并存**各自独立生效 |
| 进入 Model Context | **是，粒度 = turn-level opaque 附件**：Model Context 看见"上 N 轮各有一个 reasoning 附件（provider-native blob + 长度/存在性元数据）"，可按 token 预算选择丢弃（compaction 可丢），但**不可解析、不可修改、不可跨 model/protocol 复用** |

### 2.3 为什么禁止合并（冻结论证）

合并成单一 opaque state 会同时破坏两侧不变量：
1. resume 决策（runtime）将依赖语义内容 → 传输恢复被模型上下文污染，跨 model 的 checkpoint 误用成为可能；
2. Model Context 将看见传输游标 → 语义投影泄漏协议细节（违反 Model-visible Projection 定义）；
3. persistence 冲突：checkpoint 属 attempt 行（可归档），reasoning 附件属 conversation history（随会话保留）——生命周期不同，合并后无法独立 retention。

---

## 不变量汇总（本轮新增冻结）

```
INV-C1-1  usage 字段不可得 = null/省略，绝不伪造 0（Unknown ≠ 0）
INV-C1-2  cache usage 提取以 reportsCacheTokens 声明为门；false 而产出 cache 字段 = 合同违背
INV-C1-3  Turn 级 usage 聚合只发生在 ProviderRuntime settleTurn；adapter 不聚合、不派生 cost
INV-C2-0  ProviderContinuation 与 ReasoningRoundTripState 永不合并为单一 opaque state
INV-C2-1  continuation payload 对 Model Context 完全不透明；reasoning 附件对 Model Context 是 turn 级 opaque（可丢弃不可解析）
INV-C2-2  SafeResume 仅由传输面条件决定（checkpoint+resumeGuaranteed+deliveredPosition 幂等）；语义附件不参与判定
```
