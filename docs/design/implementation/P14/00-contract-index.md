# P14 — Contract Index — Chat-First 主工作区对话面

**Phase:** P14 · **Baseline:** DID v1.16 (G-A–G-F) · **Status:** FROZEN — review R1 Blocking=3 (TR gaps) fixed, R2 FREEZE-READY

## Doc map

| Doc | Owns |
|---|---|
| `01-human-message.md` | `SubmitHumanMessage` 命令语义、payload/前置/拒绝、`HumanMessageSubmitted` 事件、persistence/DDL、幂等 |
| `02-conversation-execution.md` | deterministic conversation trigger、`AdmitExecution(WorkspaceMain, Coordination)` server-side wiring、one-active-main 排队、exact-once logical response、crash/replay |
| `03-transcript-read-model.md` | transcript read model 升级 DTO（Human/Assistant turn）、correlation、projection 归属 |
| `04-web-surface.md` | Root Workspace 对话 tab（composer + transcript）、child read-only、Overview deep-link、无 /chat、无 streaming、UI 无直连 AdmitExecution |
| `05-acceptance.md` | 十 review seams 的机械化验收 + 完成定义 |

## Frozen upstream（本 phase 不改，除下列 TR 外）

- P6 `02`（SendMessage Workspace→Workspace 及全部 ancestry/correlation 规则）、`04`（SteerWork/HumanInput 治理通道）
- P2 执行模型（ExecutionFocus/one-active-main/SettleExecution）、P3 agent 链
- Web v1 架构不变量（TanStack Query 唯一 server-state、WS 只 invalidation、无 optimistic、projectId-in-URL）

## Tracked revisions to frozen artifacts（P14 拥有，DID v1.16 记录）

| TR | 目标 | 内容 |
|---|---|---|
| TR-A | P6 domain `InboxEntry`/`InboxArrival` kind 封闭集 | +`HumanConversation`（chat 对话轮，≠`HumanInput` steer 专属）；api-contracts `InboxEntryKind` 随扩；P6 其余不 reopen |
| TR-B | P13 `02` §2 暴露矩阵 | Human-actionable 7 → 8（+`SubmitHumanMessage`）；P13 `06` EC-6 与 Web v1 §9 不变量 2 的"七"随更；EC-8 语义核心（SendMessage 永不进 chat 面）不变（演进机制 = P13 `02` U-2） |
| TR-C | Web v1 `01`（product contract） | §0 chat-first deferral 由 P14 解除；§2.4 Root 的"对话记录"tab 升级为 conversation（transcript+composer），child 保持只读；WORKSPACE_TABS/route model 修订归 P14；EC-8 证据文本收窄为"无 SendMessage 型输入控件"，语义核心不变 |

## Reconciliation record

| 日期 | 项 | 结论 |
|---|---|---|
| 2026-09-23 | settle response write-back 协议（`02` §4） | 上游只要求 durable two-step（B）；合同由"同事务"精确修订为 §4.1 协议 + §4.2 settlement 分支；sweep 为 correctness mechanism；P2 不 reopen（`02` §4.3） |

## Phase state

```text
P14 design closure: contracts FROZEN（两轮 review，Blocking=0）
P14 planning COMPLETE (planning/phases/P14.md)
P14 implementation COMPLETE; P14 FORMALLY CLOSED (planning/results/P14.result.md)
```
