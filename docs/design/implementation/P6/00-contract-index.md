# P6 — 00 Contract Index

**Authority:** DID v1.9 §11 P6, G3 (v1.9), G5 (v1.7); SD v1.3 §7.2–§7.5, §8.1–§8.3, §13.5, §14; Scenarios v1.2 S1.4, S2; P1 `01`/`02`, P2 `01`/`05`, P3 `03`, P4 `02`, P5 `03`.
**Status:** FROZEN — manual governance adoption (D1–D4 confirmed with binding constraints); four-way review Blocking=0.

## Documents

| Doc | Owns |
|---|---|
| `01-formation-semantics.md` | `ProposeChildWorkspace` / `SpawnSpecialist` directive 语义、载荷结构、formation 链、FormationProposal governance、第一层 human gate（D1） |
| `02-communication-protocol.md` | `Communicate` / `SendMessage`、work-plane Message 语义（D2）、Inbox admission/promotion/consumption、correlation/causation、`RequestGovernance` 最小路由 |
| `03-authority-delegation.md` | Parent/Child authority 投影、capability ceiling validate-only 检查、delegation 不放大 |
| `04-human-steer.md` | `SteerWork` handler、HumanInput 通道、普通 vs Critical Steer、quiescence 集成 |
| `05-prompt-programs.md` | 4 个 Prompt Program family 的双层版本契约（contractRevision / textRevision，D4）+ 行为 eval 集 |
| `06-acceptance.md` | P6 端到端验收故事与机械可查断言 |

## Scope (from DID §11 P6)

```text
Responsibility Formation Prompt
Bootstrap / Handoff
Parent/Child Authority
Communication Protocol
Human Steer
```

- P6 实现 `ProposeChildWorkspace` 与 specialist spawn（P5 中为 `DirectiveUnsupported`，DID v1.9 G3）。采纳后 P5 `03` §2 表中仅 `DeclareDependency` 保持 `DirectiveUnsupported`（P7）。
- P6 建立在 P1 `CreateChildWorkspace` 与 P2 generic `ExecutionBound` admission 之上（DID v1.7 G5）。

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
| 不变量 1–14（tree/authority）、20–21、31、36 | `03`, `02` |
| S1.4 步骤 4/6（第一层用户确认、深层自主） | `01` §4 |
| S2（下钻纠错、普通纠错不抢占、恢复自治） | `04` §5 |
| DID §13 表（Prompt Program actual text / behavioral eval set = PHASE CONTRACT, P6） | `05` |

## Resolved decisions (manual governance)

| # | 决策 | 冻结内容 | 落点 |
|---|---|---|---|
| D1 | 第一层 formation human gate | `RequestGovernance(FormationApproval)` + `RecordDecision`；RecordDecision **必须绑定 exact formation proposal revision**；Approve **只形成 governance fact**（`DecisionRecorded`），不直接执行；由 Application 作为 consumer 后续经 `CommandGateway` 执行 `CreateChildWorkspace`（deterministic CommandId 幂等，DID §5.4） | `01` §4 |
| D2 | `OutboundMessage` kinds | 仅 `Query / Reply / Report / DecisionRequest`；**Report ≠ Deliverable 且不能满足任何 Dependency**（satisfaction 归 P7 structural matcher）；`Deliver` 留 P7 | `02` §1/§4 |
| D3 | specialist 结果回父通道 | settlement 只进入 **Parent Workspace Inbox projection**；**禁止直接写 Parent Session**；要求 **replay-safe dedup**（deterministic dedup key，at-least-once 投递下幂等） | `01` §3 |
| D4 | Prompt Program 版本模型 | 区分 **contractRevision**（mandatory semantics；变更必须重新治理契约）与 **textRevision**（全文 version/hash；每次变化必须重跑 behavioral eval 全量） | `05` §4 |

## Boundaries (explicitly out of P6)

- Deliverable / Dependency / `DeclareDependency` / `SatisfyDependency` / runnable reevaluation — **P7**。
- Verification / Acceptance / `CompleteWork` 链 — **P8**。
- Authority Resolver（PermissionGrant lookup / principal resolution / RBAC）— deferred；P6 只做结构性 parent-child 检查（`03` §1）。
- `RetireWorkspace` / Successor 迁移完整语义 — 后续治理阶段；P6 仅遵守 DID §1.4A（Retired 禁止列表）。
- Responsibility Tree / Attention 等 Projection UI — **P10**。
- worktree/resource isolation — **P11**。
- 生产 daemon/CLI surface — P12。

## Contract review (four-way)

| Pass | Scope | Findings |
|---|---|---|
| Design fidelity | 逐条 → DID/SD/S/P1–P5 出处核对 | Blocking=0（见下） |
| Dependency / coverage | P5 `03` 两行缺口全兑现；无 P7/P8 越界 | Blocking=0 |
| Executability | 验收故事断言机械可查 | Blocking=0 |
| Risk / gaps | 新增冻结语义均有最小完备载荷/拒绝集 | Blocking=0 |

Review 记录：

- R1（fidelity）：`CommandRejection.ResourceExhausted` / `WorkNotFound` 在 P1 契约未定义——已在 `02` §3 / `04` §2 显式标注为 P6 冻结新增枚举，非引用错误。已消除。
- R2（fidelity）：proposal 阶段四处章节引用错误（DID §3→§1.4A、§5.3→§1.8、§1.4→§2.3、§7.6A→§3.4、§12 表→§12.10）——已全部核对修正。已消除。
- R3（coverage）：D1 约束引入 FormationProposal revision 实体——核对发现 `RecordDecision → DecisionRecorded | DecisionRepository` 本就在 DID §12.10 表冻结（含 "supersede, no in-place history rewrite" 表注），D1 链的命令/事件/store 全部为冻结词汇；modify(proposal') 产生新 DecisionRecorded 记录（supersede 模式），不就地改写历史，与表注一致。FormationProposalRecord 本体是 P6 新增 governance 存储结构（事件词汇扩展沿 P5 `03` 观察词汇先例）。已消除。
- R4（risk）：D3 dedup key 需确定性——冻结为 `specialistExecutionId + settlementFingerprint`；Inbox admission upsert-by-key；wake 幂等（重复 wake 无害，P2 durable wait 语义天然幂等）。已消除。
- R5（fidelity）：Critical Steer 的"SteerWork + StopExecution 同一可靠提交边界"是 P6 对 SD §7.3（"一旦提交即 quiescence"）的接线细化，非 SD 原文逐字；细化只收紧不放松。FormationProposal / MessageStore / Inbox 的 SQL DDL 未在契约层给出（沿 P4 建造阶段先例：契约冻结语义，DDL 归任务级实现并受架构测试约束）。非 Blocking。

**Blocking = 0。**

## Status

```text
FROZEN — adopted by manual governance (session confirmation of D1–D4 with
binding constraints). Source proposal: planning/proposals/P6/ (superseded).
planning/phases/P6.md may now be authored against this contract set.
```
