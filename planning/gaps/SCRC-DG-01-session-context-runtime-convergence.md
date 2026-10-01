# SCRC-DG-01 — Session / Context Runtime 收敛合同缺口

## 状态

**OPEN — SCRC-1…SCRC-12 已获人工治理接受；等待 owning design landing。**

人工治理裁决：
[`session-context-runtime-convergence-governance-decision.md`](../proposals/session-context-runtime-convergence-governance-decision.md)。

固定提案：
[`session-context-runtime-convergence-decision-draft.md`](../proposals/session-context-runtime-convergence-decision-draft.md)，
SHA-256
`200D9EE0F252915F1816C57FC5FEE470E77D7FB924A95A7474E03DF68BFAFD05`。

本缺口只有在人工治理把 accepted semantics 写入拥有语义的设计文档、完成跨文档
一致性审计并在此记录 resolving revision 后，才能标记 `RESOLVED`。治理方向已被
接受不等于冻结合同已经落地，也不授权代码实现。

## 失败证据

当前生产实现存在以下机械证据：

1. `packages/ports/src/provider.ts` 的 `PortableMessage` 只有 `role + text`，无法表达
   `callRef`、ToolCall/ToolResult 状态、Attachment、ContextUpdate 或 Compaction
   checkpoint。
2. `packages/agent-runtime/src/session-context.ts` 把所有 Observation 降低为无调用
   关联的 `role = tool` 文本。
3. `packages/agent-runtime/src/model-decision.ts` 每个 Provider Turn 都重新读取
   `listUnconsumed`，再把全部 Inbox entry 追加为 user message；没有在 Session
   promotion 后原子 `markConsumed`。
4. 同一生产路径把 `contextEpoch` 固定为零，未使用 Session monotonic epoch。
5. `NeedsCompaction` 被映射为 `SafetyStop("CompactionRequired")`，与 DID 将其定义为
   success/control result、Compaction 为显式 Provider 操作的合同不闭合。
6. `packages/model-context/src/request-budget.ts` 只有 `chars / 4` 粗估算，尚无真实
   usage、provider/model estimator、overflow recovery 或 binding-aware native
   checkpoint。

这些证据说明继续扩展字符串 assembler 会扩大迁移面；它们不是修改冻结设计的
授权。

## 已接受但尚未落地的最小合同

- append-only typed Session Timeline；
- Canonical Control State 与 Active Model Window 分离；
- provider-neutral `PortableInputItem`；
- stable `callRef` ToolCall/ToolResult pairing；
- source-key idempotent Inbox promotion；
- Steer/Queue safe-boundary semantics；
- consistent `AgentStepContext` snapshot；
- in-loop Compaction + same logical step resume；
- Summary/ProviderNative compaction 与 binding fingerprint；
- provider-aware multi-level budget evidence；
- Runtime authority boundary 不从 Context 恢复；
- durable Timeline 与 lossy model projection 分离。

## 受影响的设计所有权

| 主题 | Owning contract | 当前缺口 |
|---|---|---|
| Session Timeline / epoch / checkpoint | DID Session / persistence | 缺 typed item、source uniqueness、frontier 与 crash transition |
| Model request | DID Model Context / Provider | `PortableMessage` 无法无损表达 tool/compaction items |
| Inbox / Steer / Queue | DID Agent Runtime / Application | 缺一次性 promotion 和 safe-boundary delivery |
| Tool loop | DID Tool Runtime / Agent Runtime | 缺 call/result pairing 与恢复规则 |
| Compaction | DID §8.13、§9.10 + P3/P9 | 有方向，无生产闭环、native portability 和 same-step resume |
| Budget / overflow | DID Model Context / Provider | 缺多级证据和一次性 overflow recovery |
| Authority | DID §8 / P4 | 已有 resolver；需明确不从 summary/session 恢复 |
| Recovery / safety | P9/P12 | 缺 promotion/tool/checkpoint fault windows |

## 当前阻塞范围

在本缺口 `RESOLVED` 前，禁止：

- 为 `PortableMessage` 增加新的伪结构化字符串协议；
- 把更多 Inbox/Dependency/Child Report 每轮重复拼入 Prompt；
- 用无 `callRef` 的 Tool text 支持新的 Provider 或工具；
- 把 `CompactionRequired` 作为面向用户的正常恢复机制；
- 实现 Provider-native opaque checkpoint 持久化；
- 迁移生产 Session/Inbox 数据到尚未冻结的结构。

允许继续的工作：

- 只读调研、故障证据保全、测试 fixture 设计；
- 不改变新语义的现有 bug 修复；
- ToolAuthorityResolver / ControlBasisResolver 的既有边界修复；
- 人工治理执行 owning-contract landing 和一致性审计。

## 解决条件

1. 人工治理更新所有 owning `docs/design/**` / implementation contracts；
2. 记录 resolving document versions/revisions；
3. 明确旧 `PortableMessage`、Session Observation、Inbox Context 和
   `CompactionRequired` 证据的 supersession/compatibility；
4. 完成跨文档一致性审阅，Blocking = 0；
5. 更新本记录为 `RESOLVED` 并链接 resolving revision；
6. 另行创建 implementation authorization、phase/tasks 与 TDD acceptance matrix。

## 非目标

- 不让 Session 替代 Domain canonical truth；
- 不从 Prompt/summary 恢复权限；
- 不删除完整 Tool result 或历史审计事实；
- 不照搬 Codex/OpenCode 产品专属对象；
- 不因治理方向已接受而宣称实现完成。
