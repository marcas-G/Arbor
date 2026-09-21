# P6 — Phase Contract Index (PROPOSAL)

> **SUPERSEDED（2026-09-21）**：本提案已被人工治理采纳并落位冻结为
> `docs/design/implementation/P6/**`（D1–D4 confirmed + binding constraints，
> four-way review Blocking=0）。本目录仅存档，不再维护。

> **本目录是 Planning Agent 起草的提案，不是冻结设计。**
> 人工审查定稿后，内容由治理者手工落位到 `docs/design/implementation/P6/**`
> 并冻结。在此之前本目录不构成任何 Authority 来源。

**Authority:** DID v1.9 §11 P6, G3 (v1.9), G5 (v1.7); SD v1.3 §7.2–§7.5, §8.1–§8.3, §13.5, §14; Scenarios v1.2 S1.4, S2; P1 `01`/`02`, P2 `01`/`05`, P3 `03`, P4 `02`, P5 `03`.
**Status:** PROPOSAL DRAFT — awaiting manual governance review.

## Documents

| Doc | Owns |
|---|---|
| `01-formation-semantics.md` | `ProposeChildWorkspace` / `SpawnSpecialist` directive 语义、载荷结构、formation 链与第一层 human gate |
| `02-communication-protocol.md` | `Communicate` / `SendMessage`、work-plane Message 语义、Inbox admission/promotion/consumption、correlation/causation |
| `03-authority-delegation.md` | Parent/Child authority 投影、capability ceiling validate-only 检查、delegation 不放大 |
| `04-human-steer.md` | `SteerWork` handler、HumanInput 通道、普通 vs Critical Steer、quiescence 集成 |
| `05-prompt-programs.md` | P6 拥有的 4 个 Prompt Program family 的版本化契约 + 行为 eval 集要求 |
| `06-acceptance.md` | P6 端到端验收故事与机械可查断言 |

## Scope (from DID §11 P6)

```text
Responsibility Formation Prompt
Bootstrap / Handoff
Parent/Child Authority
Communication Protocol
Human Steer
```

- P6 实现 `ProposeChildWorkspace` 与 specialist spawn（P5 中为 `DirectiveUnsupported`，DID v1.9 G3）。
- P6 建立在 P1 `CreateChildWorkspace` 与 P2 generic `ExecutionBound` admission 之上（DID v1.7 G5）。
- P6 兑现 P5 `03` §2 表中两行的真实语义。

## DID / SD governance inputs mapping

| Input | 落点 |
|---|---|
| DID v1.9 G3（P6 owns ProposeChildWorkspace/SpawnSpecialist） | `01` |
| DID v1.7 G5（generic ExecutionBound admission；P6 owns spawn semantics） | `01` §3 |
| DID §8.15 AgentDirective + P3 `03` §3 载荷名 | `01` §2, `02` §2 |
| DID §4.2 命令清单（SteerWork/SendMessage/RecordDecision） | `02` §3, `04` §2 |
| DID §12.10 表（SendMessage→MessageSent；SteerWork→WorkSteered） | `02` §3, `04` §2 |
| SD §7.2 work-plane primitives（P6 子集：Query/Reply/Report/DecisionRequest） | `02` §1 |
| SD §7.4–§7.5 Inbox / Admission→Promotion→Consumption | `02` §4 |
| SD §8.1–§8.3 authority model / capability ceiling | `03` |
| SD §7.3 Stop / Critical Steer quiescence | `04` §4 |
| 不变量 1–14（tree/authority）、20–21、31 | `03`, `02` |
| S1.4 步骤 4/6（第一层用户确认、深层自主） | `01` §4 |
| S2（下钻纠错、普通纠错不抢占、恢复自治） | `04` §5 |
| DID §13 表（Prompt Program actual text = PHASE CONTRACT, P6） | `05` |

## Boundaries (explicitly out of P6)

- Deliverable / Dependency / `DeclareDependency` / `SatisfyDependency` / runnable reevaluation — **P7**。
- Verification / Acceptance / `CompleteWork` 链 — **P8**。
- Authority Resolver（PermissionGrant lookup / principal resolution / RBAC）— deferred；P6 只做结构性 parent-child 检查（`03` §1）。
- `RetireWorkspace` / Successor 迁移完整语义 — 后续治理阶段；P6 仅遵守 DID §1.4A（Retired 禁止列表）。
- Responsibility Tree / Attention 等 Projection UI — **P10**。
- worktree/resource isolation — **P11**。
- 生产 daemon/CLI surface — P12。

## Open decision points（需要人工定稿拍板）

| # | 决策点 | 提案立场 | 备选 |
|---|---|---|---|
| D1 | 第一层 formation 的 human gate 通道 | 复用 `RequestGovernance` + `RecordDecision`（冻结命令集内闭环） | 新增专用命令（需 DID 变更，不建议） |
| D2 | P6 `OutboundMessage` kinds | `Query / Reply / Report / DecisionRequest`（`Deliver` 绑定 Deliverable，归 P7） | 含 `Deliver`（与 P7 边界混淆，不建议） |
| D3 | specialist 结果回父通道 | specialist Execution settle → `SpecialistSettled` 观察 + Inbox admission + wake | 直接注入父 Session（违反 Inbox 投影语义，不建议） |
| D4 | Prompt Program 文本冻结粒度 | 契约冻结文本骨架 + 必备条款 + eval 集通过标准；全文随实现版本化 | 契约内写死全文（审查成本高） |

## Contract review (four-way)

| Pass | Scope | Findings |
|---|---|---|
| Design fidelity | task → DID/SD/S 逐条可追溯 | 待人工评审 |
| Dependency / coverage | P5 缺口全兑现；无 P7/P8 越界 | 待人工评审 |
| Executability | 验收故事机械可查 | 待人工评审 |
| Risk / gaps | 载荷结构为 P6 新增冻结语义 | 待人工评审 |

## Status

```text
PROPOSAL — not frozen; not a planning authority source.
After manual adoption: docs/design/implementation/P6/** becomes FROZEN
and planning/phases/P6.md may then be authored.
```
