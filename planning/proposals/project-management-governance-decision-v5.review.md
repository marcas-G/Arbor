# 项目管理治理包 v5 — 独立审阅意见

日期：2026-09-30。

## 不可变审阅对象

本审阅把固定 v4 base 与 v5 amendment 组合解释为 v5 候选语义，只适用于以下字节版本：

- `planning/proposals/project-management-decision-draft-v4.md`  
  SHA-256 `BA76E1C1AEA7E9A98271E330163CE2170A2356E3D6A16C98E6D56C8175C37C25`
- `planning/proposals/project-management-decision-amendment-v5.md`  
  SHA-256 `1F17C4F1F4D8C4610562E72A2BFFA0B96DAB95EE213684B910164CEEBE71B2E6`
- `planning/gaps/DPM-DG-01-project-directory-and-lifecycle-management.md`  
  SHA-256 `B4C78BC681821EF52D82C08D388A501DCF82194299297C50637D98AA7A6C5FD0`
- `planning/proposals/project-management-governance-submission-v5.md`  
  SHA-256 `F5BF3FEAF8075DD4167AB0E477C5D46A002497DE598CE24CA1B4818831B6DFBB`

四个 SHA-256 均已与磁盘字节复核一致。任一对象发生字节变化，本审阅自动失效。

## 结论

**REVISE — Blocking = 3。不得接受 v5，不授权实现，不得将 DPM-DG-01 标为 RESOLVED。**

v5 已正确关闭 v4 R1 的大部分接口断点：Provider-only 中断不再伪造无 refs 的 `OutcomeUnknown`；完整 Provider success 先按 AHT-2/AHT-3 落盘；`OutputRejected` 两分支显式化；`NextStepReady` 先 `ensureSuccessor`、只物化 exact Prepared record 而不发 Provider 请求；真实 Tool refs 才能进入 AHT-5 OutcomeUnknown。claim/lifecycle gate 与 settle→writeback 规则也保持闭合。

v5 也补齐了只读 legacy preflight、合规行 backfill、feature fail-closed、collision/discriminator migration proof，并把 amendment 的覆盖顺序和五对象最终接受链写清楚。

但当前 amendment 把尚未有 successor 决定的 `StepEffectsCommitted` 与 `NextStepReady(successor)` 错误合并；legacy remediation 又保留了绕过 canonical command/event/revision 的治理外原始数据修改通道；固定 Gap 自身仍同时声称“自动 cooperative Stop”与“不自动停止执行”。这三项均会让 owning contract/实现得到互斥指令，必须修订。

本文件是只读审阅产物，不修改冻结设计，不构成治理裁决或实现授权。

## DPM-V5-R1 / P1：`StepEffectsCommitted` 尚未承诺 successor，不能调用 `ensureSuccessor`

位置：amendment 第 22–29 行，尤其第 25 行；P3 `08-agent-loop-step-handoff.md` §4/§8；AHT-6。

`NextStepReady(successor)` 已经 durable 地提交了唯一 successor identity，因此 v5 要求先 `ensureSuccessor` 物化 exact `Prepared` successor，再在 stop gate 下 Interrupted，是对 v4 review 的正确修复。

但 `StepEffectsCommitted` 的冻结语义不同。P3 状态机明确为：

```text
StepEffectsCommitted
  ├─ next model decision → NextStepReady(successor)
  └─ terminal proposal   → SettlementProposed
```

在 `StepEffectsCommitted` 时，系统尚未 durable 选择这两个分支，也不存在“已承诺的 exact successor”。`successor_json` 可以为空。amendment 第 25 行却把 `StepEffectsCommitted / NextStepReady(successor)` 合并，并要求二者都先 `ensureSuccessor`；对前者只能：

- 凭空生成一个 successor identity，违反 AHT-6“successor identity 在决定点持久化、不得恢复时重算”；或
- 调用缺少完整 successor 参数的 `ensureSuccessor`，接口不可实现；或
- 假装它已经是 NextStepReady，跳过冻结状态转移。

Close/Stop 已经是确定的外部控制事实。对 `StepEffectsCommitted` 的合法收敛应是：在 unresolved-side-effect gate clear 后，由既有 stopping path选择并持久化 `SettlementProposed(Interrupted(...))`；如存在真实 unresolved Tool refs，则是 `OutcomeUnknown`。它不需要、也不得发明 successor。只有 durable state 已经是 `NextStepReady(successor)` 或 `OutputRejected(Retry(successor))` 时才执行 `ensureSuccessor`。

精确修订建议：

1. 把第 25 行拆成两行：
   - `StepEffectsCommitted`：以 durable stop fact 选择既有 terminal proposal；不创建 successor；
   - `NextStepReady(successor)`：必须 `ensureSuccessor`，再对 exact Prepared successor 停止，不发 Provider。
2. 明确 race：若 StepEffectsCommitted→NextStepReady 已先提交，则 Close 走 successor 分支；若 stop fact 先在线性化点生效，则 StepEffectsCommitted→SettlementProposed Interrupted。两者不能都提交，使用 fenced/CAS monotone transition 决胜。
3. 验收增加 `stop commit ↔ StepEffectsCommitted branch commit` 两侧注入，并断言：terminal 分支无 successor；successor 分支 identity 恰好一个且被物化；无新 ProviderTurn。

其余 v4 R1 子项——Provider-only no refs、OutputRejected、NextStepReady、claim gate、Stop identity 与 settlement/writeback——本次均通过。

## DPM-V5-R2 / P1：legacy remediation 仍允许绕过 Canonical Truth 的治理外原始数据修改

位置：amendment 第 39–45 行，尤其第 43 行；Problem/Goals G7；DID 三层真相模型与 canonical mutation 规则。

只读 preflight、分类 digest、仅对“合规且值不变”行 backfill、其他情况 feature fail-closed，均是正确的首次采用边界。问题在第 43 行给出的第二种出路：

> “或在治理外明确修复原始数据并重新运行 preflight”

`Project.name` 是 Canonical Truth。直接修改原始存储会绕过 `RenameProject`/专用 migration 的 authority、revision CAS、`ProjectRenamed`/migration evidence、updatedAt、directory invalidation 与审计链；对 Closed Project 还会形成 amendment 同句前半段刚禁止的 rename bypass。即使操作者“明确”知道在修复，也不能把业务不合规名称等同于存储介质损坏，从而在治理外改写 canonical state。

这还会破坏 preflight digest 的可追溯性：第二次 preflight 能证明新值符合 v1，却不能证明谁、为何、依据什么 authority 将旧 canonical name 改成了新值。

精确修订建议：

1. 删除“治理外修复原始数据”作为普通 remediation 选项。
2. 不合规 legacy name 只能通过单独人工治理批准的、审计化且可恢复的数据迁移/repair command 处理；该合同必须明确 old/new bytes、reason、authority、Closed disposition、Project revision、updatedAt、event或等价 immutable migration ledger、directory revision 与回滚/恢复证据。
3. 只有真正的 storage corruption/backup restore 才进入 Durability Envelope 的运维修复；它不能用来改变一个可正常读取但不符合新业务策略的 ProjectName。若保留 break-glass，必须记录不可变操作者/原因/前后 digest，并在恢复后重建 canonical audit，而不是称为“治理外”。
4. migration exit proof 必须把 initial preflight digest、每条 approved remediation record、final preflight digest 与 backfill transaction 串成可核验链。

除这一绕过通道外，v4 R2 所要求的 policy/version/table/preflight/backfill/collision/crash fixtures 已经闭合。

## DPM-V5-R3 / P1：固定 Gap 仍保留与 cooperative Stop 正面冲突的旧非目标

位置：Gap 第 20–25、62–65、78–83 行；amendment V5-3；submission 第 14、20 行。

Gap 第 22–24 行已经正确新增：Close 会自动提交协作式 `StopExecution`/Quiescence。amendment V5-3 也给出应采用的精确非目标：“不强杀、不自动 Cancel Work；但自动 cooperative Stop”。

然而同一个被固定并拟共同接受的 Gap 第 83 行仍写：

```text
不实现硬删除、自动取消工作、自动停止执行或 Reopen。
```

“不自动停止执行”按项目既有命令术语直接否定自动提交 `StopExecution`。这不是仅有历史背景的句子，而是当前 Gap 的 `## 非目标` 规范条目。虽然 amendment 第 49–53 行声称冲突旧措辞被取代，但它同时要求 Gap 的非目标“必须表述为”新句；当前固定 Gap 并未满足该要求。submission 第 14 行只明确 amendment 取代 **v4 base** 冲突条款，没有清晰声明它按行取代 Gap 第 83 行。

治理包可以使用 amendment 覆盖 base，但不应让同一轮固定的 Design Gap 在正文头部和规范性结尾保留互斥合同，再要求实施者靠文件优先级猜测。尤其最终动作还要把此 Gap 标为 RESOLVED，Resolved 记录本身必须无矛盾。

精确修订建议：

1. 直接把 Gap 第 83 行改为：“不实现 hard delete、自动 Cancel Work、强杀 Execution 或 Reopen；Close 的协作式 StopExecution/Quiescence 依 accepted v5 contract 执行。”
2. Gap 第 64 行“不能擅自终止”补充“但 accepted Close 会提交 cooperative stop request”，避免被读成 Active Execution 必须继续普通 Agent loop。
3. 修订 Gap 后更新 SHA、submission，并重新独立 review；不要依赖 amendment 对同一固定 Gap 内冲突语句做隐式遮蔽。

因此 v4 R3 在语义方向上已决定，但候选 Gap 文本尚未达到可接受的一致状态。

## v4 R1–R3 复核表

| v4 项 | v5 结论 | 证据 |
|---|---|---|
| R1 Settlement ADT / Provider / OutputRejected / AHT-6 | **PARTIAL — Blocking R1** | Provider-only/no refs、OutputRejected、NextStepReady 已关闭；StepEffectsCommitted 被错误要求 ensure 尚不存在的 successor。 |
| R2 legacy preflight/backfill/remediation | **PARTIAL — Blocking R2** | preflight/backfill/fail-closed/fixtures 已关闭；“治理外修复原始数据”绕过 canonical audit。 |
| R3 Gap cooperative Stop 一致性 | **PARTIAL — Blocking R3** | Gap 前段和 amendment 正确；Gap 当前非目标仍明确禁止自动停止执行。 |

## 接受链审计

接受链结构正确：独立 review 固定 v4 base、v5 amendment、Gap、submission 四个对象；最终人工治理决定再固定这四者与 v5 review，共五个 SHA。amendment 第 7 行明确固定 base 且只覆盖明示冲突，避免修改已审阅 base；submission 也没有把旧 review 冒充本轮证据。

最终决定还应明确解释顺序：`v5 amendment > fixed v4 base` 仅对 amendment 明确替换的条款生效；Gap、submission 和 review 是状态/证据对象，不应靠未声明的跨文件优先级消除自身矛盾。三个 Blocking 修订会改变固定对象字节，因此当前 review 不可被未来 ACCEPT 复用。

## 已确认正确、可保留的内容

- Provider complete success 优先 durable 收敛；incomplete/cancelled provider path 使用 TurnFailed + Interrupted/Failed，不伪造 tool OutcomeUnknown。
- 只有真实、非空 unresolved ToolInvocation refs 才允许 `OutcomeUnknown(ReconciliationRequired(refs))`。
- `OutputRejected(Retry)` 保留 successor identity并 `ensureSuccessor`；`Exhausted` 保留 settlement identity。
- `NextStepReady` 不重算 successor、不发新 Provider 请求；exact Prepared successor 进入 existing stop path。
- Close/Submit/claim/Admit/Open-required mutations 共享 lifecycle gate；CreateProject bootstrap 排除；Closed 不回 Pending。
- settle→writeback、Inbox replay/rebuild 和 Declined 规则保持无丢答、无复活 actionable entry。
- ProjectNamePolicy 固定 Unicode/UTS #39 bundled tables、危险类别拒绝、key/skeleton 持久且不进 DTO。
- initial preflight 在任何 semantic write 前完成；合规且值不变行可原子 backfill；其余 feature fail closed。
- discriminator backfill 有 scope 隔离、唯一约束、随机固定长度和 crash/restart 幂等要求。
- v4 directory protocol privacy 边界与 timing threat-model 收窄保持有效。
- owning `docs/design/**` 落字并记录 resolving revision 前，Gap 保持 OPEN、实现保持未授权。

## 再审最小证据

下一版至少应提供：

1. 拆分后的 `StepEffectsCommitted` 与 `NextStepReady(successor)` stop-race/transition 规则；
2. 删除治理外 raw canonical data edit，并给出审计化 legacy remediation 证据链；
3. 删除 Gap 中“不自动停止执行”的冲突非目标；
4. amendment/Gap/submission 的新 SHA（若继续固定同一 v4 base，可保留其 SHA），再由独立 review 固定四对象。

## 审阅范围

本次对照了 `AGENTS.md`、冻结 Problem/Goals、DID Execution Settlement、Stop/Quiescence、Canonical Truth 与 AHT-1…AHT-8，P2 Settlement validation、P3 Provider cancellation/AgentLoopStep state machine/`ensureSuccessor`、P9 recovery、P14 conversation convergence，以及 v4 review R1–R3。未运行实现测试；未修改 `docs/design/**`、实现代码或四个被审阅对象。
