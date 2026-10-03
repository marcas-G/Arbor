# AITSC-DG-01 — 模型交互分层与工具身份混合

## 状态

**RESOLVED / IMPLEMENTED — 人工治理已接受并完成边界迁移；仅剩 B11 真实
Provider 3/3 资格证据，由 `BLACKBOX-GAP-01` 单独跟踪。**

## 触发证据

2026-10-02 的 B11 真实 DeepSeek 资格测试中，模型先提出 `list` 与
`shell`，未立刻提出完成声明。资格测试的 HTTP 适配器随后把两个相邻的
`ToolCall` 分别重建为两个 assistant message，再追加两个 tool result。
该序列不满足 OpenAI-compatible 协议；provider 正确以 400 拒绝。

生产 OpenAI adapter 已对相邻 `PortableToolCall` 做 batch lowering，并在发送前
校验 pairing；资格测试适配器却重复实现了另一份不等价的 lowering。这说明：

1. 已采纳的 `SessionItem → PortableInputItem → ProtocolAdapter` 分层没有由一个
   唯一的、可复用的边界实现强制；
2. 当前控制工具的内部注册身份直接等同于模型可见 `name`，例如
   `arbor_claim_completion`。模型可见名字、持久化 replay 名字、handler lookup
   identity 和 manifest identity 无法独立演进。

失败证据：

- `planning/testing/core-capability/evidence/real-provider/B11-L3-REAL-2026-10-02T11-24-30.612Z-c8711f97-19ec-48cb-89ae-80f05b646121.json`
- `planning/testing/core-capability/evidence/real-provider/B11-L3-REAL-2026-10-02T11-25-02.832Z-ca7b5819-9f87-4284-a06b-42833c4f46f0.json`

## 为什么现有设计不足以直接改名

SCRC / P3 已冻结并采纳：typed Session Timeline、`PortableInputItem`、稳定
`callRef`、Context Projector、provider-last rendering。P17 又冻结了
`ResolvedTurnProfile`。因此本缺口**不是**重新设计 Context 的授权。

但 P17 当前把 control registration identity 表述为 `{ name, version, hash }`。
直接把 `arbor_claim_completion` 改成 `claim_completion` 会同时改变：

- 当前和历史 Manifest 的 identity；
- Session Timeline 中的 ToolCall name；
- ControlToolRegistry 的 classify/decode/handler lookup；
- provider replay 所需的 function name。

这会破坏旧 Turn replay，且违反“模型不需要感知 Arbor”的产品约束，不能用全局
字符串替换解决。

## 所需治理决定

以 `planning/proposals/agent-interaction-tool-surface-convergence-decision-draft.md`
为唯一待审提案。它必须决定：

1. 内部 `ToolIdentity` 与 model-facing `modelName` 分离；
2. ToolCall Timeline 同时保存解析后的内部身份和本次 provider wire name；
3. Context Compiler 是唯一编译 `PortableModelRequest` 的语义入口；
4. ProtocolAdapter 是唯一把 portable items 降级为 provider messages 的入口；
5. provider request 在网络发送前必须通过 call/result sequence verifier；
6. 旧 Manifest/replay 通过已记录的 profile/identity alias 解码，新 Turn 只暴露
   无品牌名字；
7. tool catalog 以 TurnProfile 和 capability 筛选可见集合，内部工具冲突不通过
   给模型加产品前缀解决。

## 禁止事项

- 不修改 `docs/design/**`，直到人工治理采纳；
- 不把 provider wire JSON 当作 Session canonical truth；
- 不用提示词或 `tool_choice` 强迫来掩盖消息序列错误；
- 不以模型可见名称作为授权、handler 或历史 replay 的唯一 identity；
- 不让 completion claim 绕过 Verification 或 Parent Acceptance。

## 关闭条件

1. 人工治理在 owning docs 落字并记录 supersession；
2. 一套 canonical Tool Transcript/renderer 被生产 adapter 和真实资格测试共同使用；
3. 多调用、并行结果、失败/中断、重启 replay、跨 provider renderer 的 pairing
   测试均通过；
4. 新 Turn 只广告无品牌工具名，历史 Turn 仍按原 profile 可重放；
5. B11 连续 3/3 PASS，且无非法 provider request。

## Resolution

- 治理接受：
  `planning/proposals/agent-interaction-tool-surface-convergence-decision-draft.md`；
- owning contracts：DID §7.5/§7.6、P3 `01`、P17 `04` 已落字；
- 新 control surface 使用无品牌 `modelName`，Runtime 使用 stableId，旧
  `arbor_*` 仅按历史 version/hash replay；
- 真实资格测试复用生产 OpenAI renderer/client，只保留 evidence capture；
- Agent Runtime 的重复 Session/Inbox assembler 已删除；
- Inbox 只能经 InputPromotion safe-boundary 原子提升进 Session；
- ProviderRuntime 独占阶段 timeout/retry policy，Adapter 不再接收这些策略字段；
- 机械证据：`planning/results/agent-core-boundary-ownership-audit.result.md`。

B11 的真实模型稳定性不是未决设计语义，因此不保持本 Design Gap 为 OPEN。
