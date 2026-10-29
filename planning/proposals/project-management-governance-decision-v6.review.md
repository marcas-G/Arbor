# 项目管理治理包 v6 — 独立审阅意见

日期：2026-09-30。

## 不可变审阅对象

本审阅按 `v6 amendment > v5 amendment > v4 base` 的明示覆盖顺序解释候选语义，只适用于以下字节版本：

- `planning/proposals/project-management-decision-draft-v4.md`  
  SHA-256 `BA76E1C1AEA7E9A98271E330163CE2170A2356E3D6A16C98E6D56C8175C37C25`
- `planning/proposals/project-management-decision-amendment-v5.md`  
  SHA-256 `1F17C4F1F4D8C4610562E72A2BFFA0B96DAB95EE213684B910164CEEBE71B2E6`
- `planning/proposals/project-management-decision-amendment-v6.md`  
  SHA-256 `D692C2F1E206CF8E6043590C25919ACC44A998D52229E9D2F7D8003BEDA01C74`
- `planning/gaps/DPM-DG-01-project-directory-and-lifecycle-management.md`  
  SHA-256 `C6018DF1C2BCE5E78A974A010F271AE7B63C2D99ED2B3C4025956D4B3799B214`
- `planning/proposals/project-management-governance-submission-v6.md`  
  SHA-256 `B9C67C9AB4B610C8686557276F0C05E1B877924B1A81D85FA364E3979ABBA20D`

五个 SHA-256 均已与磁盘字节复核一致。任一对象发生字节变化，本审阅自动失效。

## 结论

**REVISE — Blocking = 1。不得以当前对象集签发 ACCEPT，不授权实现，不得将 DPM-DG-01 标为 RESOLVED。**

v6 已在技术语义上关闭 v5 review 的三个 Blocking：

1. `StepEffectsCommitted` 不再虚构 successor，而是在 stop fact 下以现有 identity/单调 CAS 形成 `SettlementProposed(Interrupted)`；`NextStepReady`/`OutputRejected(Retry)` 才执行 AHT-6 `ensureSuccessor`。
2. legacy ProjectName remediation 已删除直接 SQL、adapter rewrite 和“治理外修复原始数据”；不合规行保持 feature fail-closed，等待独立、已接受、审计化 migration/repair contract。
3. Gap 的规范性非目标已改为“不 hard delete、不自动 Cancel Work、不强杀、不 Reopen”，并明确 Close 自动提交 cooperative `StopExecution`/Quiescence；自动 stop 的语义冲突已消除。

剩余 Blocking 不是运行时语义，而是**不可变接受对象集仍有两套互斥定义**：Gap 的状态段仍指向 v5，且被继续纳入的 v5 amendment 仍要求最终决定固定 v5 submission/review；v6 submission 则要求另一组六对象。最终人工决定无法在不自行创造优先级规则的情况下判断应固定哪些对象。

本文件是只读审阅产物，不修改冻结设计，不构成治理裁决或实现授权。

## DPM-V6-R1 / P1：接受链仍混合 v5 与 v6 两套候选对象

### 证据 A：Gap 仍把 v5 写成当前候选

位置：Gap 第 20–26 行。

当前固定 Gap 写道：

```text
当前候选治理包由固定 v4 base、其 v5 amendment 和
project-management-governance-submission-v5.md 组成。
...
在 v5 治理包被独立审阅、固定并接受 ... 前，本缺口仍为 OPEN
```

但本轮实际候选还包含 v6 amendment，submission 是 v6，独立 review 也是 v6。Gap 虽然修正了 cooperative Stop 的正文和非目标，却没有把状态/候选链推进到 v6，也没有记录 v5 review 的 `REVISE / Blocking = 3`。若最终决定固定当前 Gap 并称其为 v6 resolving object，Gap 自己仍声明另一个候选包才是当前对象。

### 证据 B：被纳入的 v5 amendment 仍要求固定 v5 submission/review

位置：v5 amendment 第 7 行；v6 amendment 第 7 行；v6 submission 第 23 行。

v5 amendment 第 7 行要求最终决定固定：

```text
v4 base + v5 amendment + Gap + v5 submission + independent review
```

v6 amendment 的范围声明是“只取代 v5 review 指出的三处条款”，没有明确取代 v5 amendment 的接受链句子；而 v6 submission 要求最终决定固定：

```text
v4 base + v5 amendment + v6 amendment + Gap + v6 submission + v6 review
```

因此组合语义同时要求包含 v5 submission/review，又要求六对象 v6 链。v5 submission 与 v5 review 是历史 `REVISE` 证据，不应成为 accepted semantic bundle；但当前 v6 amendment 未明确作此 disposition。

这不能靠“较新文件通常优先”隐式解决：v6 amendment 自己把覆盖范围限制为三处技术条款，接受链不是其中之一。不可变审阅/接受机制的目的正是消除这种可变解释。

### 精确修订建议

1. 在 v6 amendment 明确新增接受链 supersession：其“最终决定固定六 SHA”条款取代 v5 amendment 第 7 行关于 v5 submission/review 的要求；v5 submission 与 v5 review 仅作为历史 `REVISE` evidence，不属于 accepted candidate semantics。
2. 更新 Gap 状态段：记录 v5 review 为 `REVISE / Blocking = 3`；当前候选明确为固定 v4 base + 固定 v5 amendment + v6 amendment + Gap + v6 submission；状态写“v6 bundle 被独立审阅、固定并接受前保持 OPEN”。
3. 保留 Gap 第 22–24、83 行已经修正的 cooperative Stop 语义，不要在纯链路修订时回退。
4. 更新 amendment/Gap/submission SHA，并重新独立 review。最终决定固定这五个候选对象加新 review，共六 SHA；不固定历史 v5 submission/review 为 accepted objects。

## v5 三项 Blocking 复核

| v5 Blocking | v6 结论 | 证据 |
|---|---|---|
| StepEffectsCommitted successor | **CLOSED** | v6 第 13–16 行将无 successor 的 StepEffectsCommitted 与已承诺 successor 的 NextStepReady/OutputRejected Retry 分离；前者 CAS terminal proposal，后者 ensure exact successor。 |
| legacy raw repair | **CLOSED** | v6 第 20–22 行仅允许未来独立人工治理接受的审计化 contract；明确禁止直接 SQL、adapter rewrite 和假 v1 标记。 |
| Gap automatic stop contradiction | **CLOSED** | Gap 第 22–24、83 行与 v6 第 24–26 行一致：自动 cooperative Stop，非强杀、非 Work cancel。 |

## StepEffectsCommitted / Stop 合法性核验

v6 第 14 行与冻结状态机相容：`StepEffectsCommitted` 尚未提交 successor，stop fact 可以作为 terminal-decision input，经 fenced/monotone CAS 进入 `SettlementProposed(Interrupted(...))`；它不调用 `ensureSuccessor`，不生成 ProviderTurn。若 NextStepReady CAS 先赢，恢复按 AHT-6 物化 exact Prepared successor，再在 activity gate 前停止。这个竞态具有唯一胜者，不覆盖 predecessor disposition。

一个不升格为 Blocking、但落入 owning contract 时应保持的严谨点：AHT-5 正常不变量下，`StepEffectsCommitted` 表示没有 unresolved side effect；v6 第 14 行在该状态又看到真实 unresolved Tool refs 的分支，应标为 invariant-conflict safety fallback（durable Attention + 不做普通 Interrupted），而不是把“StepEffectsCommitted + unresolved”描述成普通可达状态。即便保留 OutcomeUnknown 作为保守收敛，也只能使用真实非空 refs，不能削弱 AHT-5 的正常状态不变量。

## Legacy fail-closed 核验

v4 policy + v5 preflight + v6 remediation 组合后满足：

- bundled Unicode/UTS #39 版本固定；
- 任何 semantic write 前只读 preflight 与 digest；
- 只有合规且 canonical name 字节不变的行 backfill metadata；
- 不合规/会变化行不写、不伪装 v1，相关产品面 fail closed；
- 修复必须另有人工接受的 authority/revision/event/Closed/invalidation/idempotency/recovery 合同；
- 无直接数据库或 adapter canonical rewrite；
- discriminator backfill 有 scope 隔离、唯一约束、固定随机值及 crash/restart 幂等 proof。

该边界不会把未来 repair 自动授权；在独立 repair contract 落地和成功执行前，ProjectDirectory/Rename/Close 继续禁用，符合当前“设计接受 ≠ 实施授权”。

## 目录与其他继承合同

v4 DPM-1 的协议层隐私合同继续有效：token 非 bearer、逐页认证/授权、revoke 线性化、scope-local revision、统一无对象存在性错误；只排除共享基础设施物理 timing non-interference，不作不可证明承诺。v6 没有重新打开该边界。

Submit/claim/admit/Close gate、settled writeback 优先、Closed Failed/OutcomeUnknown Declined、delayed Inbox no-op/retract、无 Closed Pending/无主 Claimed 等已关闭规则也未被 v6 改写。

## 已确认可保留的内容

- v6 的 StepEffectsCommitted/NextStepReady 分离及 stop-race 规则。
- Provider complete success、cancelled/incomplete stream、真实 Tool refs OutcomeUnknown 的既有 ADT 映射。
- `OutputRejected(Retry/Exhausted)` 与 AHT-6 successor/settlement identity 保留。
- claim、Submit、Admit 和 Open-required mutations 的 project lifecycle gate。
- ProjectName policy、preflight、metadata/discriminator backfill 与审计化 future remediation 边界。
- Gap 中“不强杀/不 Cancel Work，但自动 cooperative Stop”的正向/非目标表达。
- v6 submission 所述“owning docs 落字、resolving revision、Gap RESOLVED 后才实施”的授权门。

## 再审最小证据

下一版只需闭合治理链，无需再修改已通过的运行时语义：

1. amendment 明确 supersede v5 acceptance-chain sentence；
2. Gap 状态推进到 v6 并记录 v5 REVISE；
3. amendment/Gap/submission 新 SHA；独立 review 后最终决定固定五对象 + review 六 SHA。

## 审阅范围

本次对照了 `AGENTS.md`、冻结 Problem/Goals、DID Canonical Truth/Execution Settlement/Stop/Quiescence/AHT-1…AHT-8，P2 Settlement validation、P3 AgentLoopStep state machine/`ensureSuccessor`、P9 recovery、P14 conversation convergence，以及 v5 review 三项 Blocking。未运行实现测试；未修改 `docs/design/**`、实现代码或五个被审阅对象。
