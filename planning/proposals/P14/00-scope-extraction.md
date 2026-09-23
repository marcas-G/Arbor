# P14 提案 — Chat-First 主工作区对话面：Scope Extraction

**状态**: 裁决已落（GQ-A–F，2026-09-23，含事实前提修正）；本文件降级为历史研究记录。
**基线**: DID v1.16 · P6 `02`/`04`（冻结，不改动）· S1 §1–3/§13 · P13 `02` §6 U-3 · Web v1（已闭环）
**日期**: 2026-09-23

## 0. 动机

S1 的产品核心是"用户 ↔ Main Agent 多轮高层讨论"（调研/澄清/方案/材料/推演，
方向明确后才组织分工）。当前系统无此面：Web v1 transcript 只读；
external `AdmitExecution` 被 P13 `02` U-3 显式 defer（"主执行发起与用户启动/
恢复对话工作流耦合，属 P14 chat 面语义"）。

## 1. 事实前提（源码核验修正版）

**P6 并不存在可直接泛化的"通用 Human Message → Inbox"实体通道**：

- `SteerWork`（P6 `04`）：human-originated **command**，写
  `InboxEntry(kind="HumanInput")`，同时产生 `WorkSteered` /
  `HumanInterventionApplied`——它是治理纠偏语义，不是自由对话输入；
- `SendMessage`（P6 `02`）：严格的 **Workspace→Workspace** 通信，payload 带
  `senderWorkspaceId`（由 authority fact 绑定），并有 Query/Reply/Report/
  DecisionRequest/Deliver 的 parent/ancestor/correlation 规则。

因此 P14 **不得**把"扩展 SendMessage origin"当作低成本方案——那会污染 P6
整条组织通信规则。

**Domain 已有的可复用冻结语义**（源码核验）：

```text
ExecutionFocus = Work(workId) | Coordination          （execution.ts）
Completed      = … | CoordinationCompleted | QueryCompleted
```

即：**空闲对话轮不需要（也不得）伪装成"对话型 Work"**——直接复用
`WorkspaceMain + focus=Coordination` 的既有执行语义。

## 2. 裁决记录（GQ-A–F）

| GQ | 裁决 | 关键内容 |
|---|---|---|
| A 消息命令 | **新增 `SubmitHumanMessage`** | Authenticated Human → Root Workspace；payload {messageId, targetWorkspaceId, bodyRef}；principal 来自 authenticated External context，payload 不自报 sender；caller-preallocated id；durable/idempotent；不修改 Work；无 Steer 语义。**不扩展 SendMessage**。新增独立事件 `HumanMessageSubmitted`（不硬套 `MessageSent`——其 payload 语义是 workspace sender，硬套会伪造 senderWorkspaceId） |
| B 执行模型 | **复用 WorkspaceMain + Coordination**（非 conversational Work） | 链：SubmitHumanMessage → durable human message + Root Inbox → deterministic P14 conversation trigger → scheduler/Application admission → **AdmitExecution(WorkspaceMain, focus=Coordination)** → 既有 P2/P3/agent/provider 链 → SettleExecution(Completed(QueryCompleted)) → transcript projection。**浏览器不得为聊天直接调 external AdmitExecution**（P14 关闭的是 server-side wiring，不推翻 P13 U-3 的 UI 面）。Root 已有 Active Main Execution 时：消息 durable pending、不开第二个 main、不打断、settle 后再调度（v1 串行模型）；需立即干预仍走冻结的 SteerWork/StopExecution——chat 无 interrupt 语义 |
| C 回复读取 | **升级 transcript read model** | 呈现 Human（messageId/body/occurredAt）与 Assistant（executionId 关联/bounded body/occurredAt）turn；WS→invalidate、/views 权威；v1 无 provider token streaming、无 message 专用流式 transport、浏览器不拼 delta |
| D 权限 | **Root Workspace only** | Authenticated Human ↔ Root Workspace；child = read-only transcript + SteerWork；不得绕开 Responsibility Tree / parent coordination（防绕开 root 协调中心）；未来 direct-child conversation 单独治理 |
| E 轮次 | **1 accepted HumanMessage → 1 bounded Coordination Execution → 1 user-visible response episode** | execution 内可多 ProviderTurn/ToolInvocation；跨轮连续性 = same Root Workspace + same WorkspacePrimary Session + different executions。**Session = cognition continuity；Execution = bounded episode**。contract 须冻结：pending 消息消费/claim 顺序、crash/replay 不重复回复、message↔execution↔response correlation、one-active-main 排队 |
| F UI | **Root Workspace 对话 tab + Overview 快捷入口** | Root：`对话`（transcript + composer）；Child：`对话记录`（read-only）。Overview "与 Arbor 对话"仅 deep-link 到 `/p/:projectId/workspace/:rootWorkspaceId/conversation`；不建 `/chat` 独立产品域 |

## 3. 治理路径（已定）

- DID v1.15 → **v1.16**（P14 phase + 命令/事件/执行/read-model ownership）；
  System Design 不改（Human/Root interaction 已被允许，P14 只闭合
  command/event/execution/read-model ownership）；
- 合同 `docs/design/implementation/P14/**`；
- 十个 review seams（见 05-acceptance）：durability/idempotency、root-only
  exact binding、HumanInput 与 Steer 不混义、Coordination 与 Work execution
  不混义、one-active-main 排队、crash 后 exact-once logical response、
  transcript correlation、Web 无直连 AdmitExecution、v1 无 streaming、
  child 零 composer。

## 4. Must Not（延续钉死）

- 不改 P6 `02` 四种 message kinds 的 agent↔agent 语义；
- 不绕 Inbox（人消息走 admission/promotion/consumption）；
- 不做 optimistic 对话状态（server 唯一真相；WS 只 invalidation）；
- chat 不获得 interrupt/steer 语义（立即干预 = 冻结的 SteerWork/StopExecution）；
- Search 仍 out-of-v1。
