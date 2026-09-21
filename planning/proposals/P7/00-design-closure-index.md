# P7 — Design Closure Proposal (PROPOSAL, not frozen)

> **SUPERSEDED（2026-09-21）**：GQ1–GQ7 已裁决（DID v1.10）；契约冻结于
> `docs/design/implementation/P7/**`（Blocking=0），planning 见
> `planning/phases/P7.md`。本目录仅存档。

**Authority:** DID v1.9 §1.8, §4.2, §5.3, §5.4, §6.2, §8.15–§8.18A, §11 P7, §12.8, §12.10, §12.11; 治理裁决 v1.7 G3 / v1.9 G2; SD v1.3 §3.7/§3.8, §5.2, §7.2/§7.5/§7.6, §12.1, §13.5, §14 No.20/42/49/53/55; Scenarios S1 步骤10–11, S3 步骤2–5/12/14; P2 `02`/`05`, P3 `02`, P5 `02`/`03`, P6 `00`–`06`; `planning/results/P6.result.md`。
**Status:** DESIGN CLOSURE DRAFT — awaiting governance decisions GQ1–GQ6.

## Documents

| Doc | Owns |
|---|---|
| `01-dependency-deliverable-commands.md` | DeclareDependency / ProduceDeliverable / SatisfyDependency（+GQ1 待正式化的 Withdraw/MarkUnfulfillable/Revise）载荷、拒绝表、事件、authority |
| `02-runnability-reevaluation.md` | 取代 provisional RunnableWorkSource 的语义（GQ3 冻结解读）、DeliverableProduced→SatisfyDependency 自动满足路径（GQ6）、reevaluation 触发 |
| `03-wait-graph-deadlock.md` | Wait-for graph、确定性 cycle 检测、Deadlock Attention、L4/L6 分层细化（GQ4） |
| `04-wake-integration.md` | DependencyChanged wake 生产（observedRevision 匹配器）、wake 消费管线、与 P2 §8.16 事务边界对齐 |
| `05-deliver-report-p8-boundary.md` | Deliver 原语裁决提案（GQ2）、Deliver vs Report vs Message、P8 Verification 正交边界（GQ5） |
| `06-acceptance-outline.md` | P7 验收故事概要（冻结版在契约落位时定稿） |

## Authoritative scope (DID §11 P7 + G2/G3 裁决 + P2/P5/P6 前向引用)

```text
DeclareDependency / ProduceDeliverable / SatisfyDependency（命令）
Wait-for Graph / Deadlock Attention
automatic runnable reevaluation
dependency-aware RunnableWorkSource（取代 P5 provisional 实现，port 形状不变）
DependencyChanged wake-signal 生产（P7 是 source phase；P2 拥有 durable wait 机制）
```

明确不在 P7：Verification/Acceptance/CompleteWork 链（P8）、InboxAdvanced 生产（P6 已接）、timer/wake 机器与 lost-wake-up 防护（P2）、Responsibility Tree 语义（P6）。

## 实现基线（可复用 vs 空壳）

可复用（已冻结在代码且测试绿）：domain dependency.ts 全集（6 转移 + matcher + producer-loss 批量后果 + Acceptance 校验）、WakeCondition.DependencyChanged / WakeReason.DependencySatisfied 类型、RunnableWorkSource port + SQLite、P5 provisional 实现（整体替换对象）、§8.18A 决策表（scheduler.decide）。

空壳（P7 必须补）：5 个 Dependency/Deliverable 事件载荷（现 `{}` 空壳且被 events.test.ts 锁死）、ports/repository/DDL（dependencies/deliverables/deliverable_artifacts 三表，migration id 6）、DeclareDependency directive handler（最后一个 DirectiveUnsupported）、reevaluate 的 wakeReason 求值（现为 `_wakeReason` 忽略）、wake 消费管线（AdmissionOutcome.wakeReason 零消费方、clearWorkWait 零调用、无 daemon）、composition 仍用 P4_MIGRATIONS（P6 遗留缺陷顺带修）。

## Unresolved-items classification

### A. Upstream design defects（需人工治理修订 DID/SD；P7 不可自行闭合）

| # | 缺陷 | 证据 | 建议 |
|---|---|---|---|
| UD-1 | `WithdrawDependency` / `MarkDependencyUnfulfillable` / "revise expected contract" 出现在 DID §12.11 状态机与 §5.3 事件目录，但未列入 §4.2 命令清单、无 §12.10 表行（store/pipeline/authority 未定） | DID:4126-4129 vs DID:1398-1405, :3987-3988 | **GQ1**：补 §4.2 三命令 + §12.10 三行（提案命名：`WithdrawDependency` / `MarkDependencyUnfulfillable` / `ReviseDependencyContract`，store=DependencyRepository，pipeline=application） |
| UD-2 | SD §7.2 第 6 原语 "`Deliver` — Child → Parent 正式交付" 与 SD §10 原子提交清单含 Deliver，但 DID 命令/事件目录无 `Deliver`/`Delivered`；P6 `00` 仅说 "Deliver 留 P7"。组合方案 b 隐含三处未冻结扩张：(i) Inbox `Deliverable` kind 越出 P6 D2 四枚举（P6 `02`:26/88）；(ii) agent 交付入口缺失——§8.15 AgentDirective 词表只有 `DeclareDependency`，无 Produce/Deliver 指令； (iii) parent 唤醒 reason（ChildDelivered 已在 WakeReason 预留但语义未定） | SD:753, SD:1121 vs DID §4.2/§5.3/§8.15:2769-2787; P6 `02`:26/88, P6 `00`:53 | **GQ2**（扩容）：Deliver 落点裁决必须同时覆盖 (i)(ii)(iii)（见 `05`） |
| UD-3 | `DeadlockAttentionRequested` 是承载 SD No.42/A3 强制语义的事件，但 DID §5.3 事件目录从未目录化（与 UD-1 同属目录缺口） | SD:1510, SD:1604 vs DID §5.3:1541-1545 | **GQ4**（重构为）：裁决该事件入 §5.3 目录（分层细化本身已被 DID §7.1:2047 + §6.2:1609 + SD A3 锚定，无需再确认） |
| UD-4 | `SatisfyDependency` 显式提交通道的 authority 未定义（谁有权 satisfy：producer/consumer/任意 Workspace/human）；且 agent 侧无 `ProduceDeliverable`/`SatisfyDependency` 的 §8.15 指令入口（只有 DeclareDependency） | DID §4.2（仅列举）, §8.15:2769-2778; 提案 `01` §4 空洞 | **GQ7**（新增）：裁决显式提交面与 authority |

### B. P7 phase-scoped closure（契约权限内可冻结，采纳即闭合）

1. **runnability 最小解读（GQ3——语义裁决，非冻结解读背书；采纳即冻结）**：classify **不读** Dependency 状态——`runnable = Open Work 且无 active WorkWait`（与 P5 同式）；Dependency 通过两条正交通道影响调度：(a) Agent 认知 Yield→WorkWait(DependencyChanged)，(b) satisfaction 事件→wake→reevaluation。依据：SD §5.2 "被阻塞后才寻找其他 Pending Work"、S3 步骤3（依赖≠停摆，等待是 Agent 认知决定）、P2 冻结的 decide() 决策表（hasWait 是唯一 wait 输入）、DID §8.16:2868（DeclareDependency 后不一定 Yield）。
2. **自动满足路径**：DeliverableProduced → Coordination Consumer（Event→Command，deterministic CommandId 幂等，DID §5.4）→ SatisfyDependency（matcher 过）。AnyProducer candidate 发现：produce 时点扫描同 Project 全部 Unsatisfied Dependency（推荐，O(D) 于 produce 时而非持续索引）——**GQ6** 确认。
3. **Wait-for graph / Deadlock**：graph = 节点(Open Work) + 边(consumer Work --expected--> producer binding 目标)；cycle + 受影响 Work 全部 hasWait 且无 runnable → 发 `DeadlockAttentionRequested` 事件（事件目录化=UD-3/GQ4；分层细化已被冻结文本锚定）。检测为确定性域纯函数（L1/L4），Attention 呈现/路由为 L6。
4. **wake 集成**：SatisfyDependency 提交事务内对每个匹配 `WorkWait.conditions` 中 `DependencyChanged(id, observedRevision)` 且 observedRevision < 新 revision 的等待发 wake 信号（同一提交边界，不变量 36 模式）；scheduler 消费侧补 wakeReason→相关 workspace reevaluation 路由。
5. **P6 promotion seam 兑现**（P6 result:54 移交）：P6 `02`:88 "P7 之前的 promotion 集不含任何 Dependency satisfaction" → P7 起 promotion 集加入：Deliverable 到达 → 自动满足匹配 Dependency（`02` §2 路径即该规则的实现）。
6. 事件载荷、DDL、repository、directive handler、拒绝表——常规契约内容；并发语义显式冻结：两 deliverable 竞争同一 dependency 时首提交者赢（CAS），败者收 typed rejection，自动路径由 deterministic CommandId 幂等吸收；DeclareDependency 拒绝表补跨 Project producer binding 行。

### C. Implementation choices（不改契约，任务级）

- events.test.ts 空壳断言更新；composition 升级到 P7_MIGRATIONS（顺带修 P6 遗留）；AnyProducer 扫描的实现形态（SQL join vs 内存过滤）；deadlock 检测触发时机（satisfaction/withdraw 事务后 vs 周期性）；DependencyChanged 匹配器的存储位置。

## True governance questions（独立 review 修订版：7 项；GQ5 撤销独立资格，见备注）

- **GQ1**（UD-1）：三个状态机操作正式化为命令（提案命名 WithdrawDependency / MarkDependencyUnfulfillable / ReviseDependencyContract + §4.2 三行 + §12.10 三行）；裁决文本须同时包含 `DependencyContractRevised` 作为 §5.3 新增事件行。
- **GQ2**（UD-2，扩容）：Deliver 落点 = (a) 独立命令 `Deliver` 还是 (b) 组合行为原语（推荐 b）。裁决输入必须含三个子决策：(i) Inbox `Deliverable` kind 是 P6 D2 枚举的显式扩张（需认可）；(ii) agent 交付入口——扩 §8.15 词表（上游修订）或以 InvokeTool 组织动作面承载（P6 `03` 未禁）；(iii) parent 唤醒 reason 取 `ChildDelivered`（建议，语义已在 WakeReason 预留）。
- **GQ3**（B-1，改标签）：runnability **最小解读是语义裁决而非冻结解读的背书**（"dependency-aware" 一词在 DID 未定义；P5 `02` 契约文本预期 wait 维度进 P7 classify，而现行代码把 wait 放在 decide()——裁决以何者为准）。附带闭合：active WorkWait := 行存在且未被消费；satisfaction 后的失效判定（clearWorkWait 调用点）归 wake 消费侧。
- **GQ4**（UD-3，重构）：`DeadlockAttentionRequested` 入 DID §5.3 事件目录（分层细化无需再确认——DID §7.1:2047 DeadlockAnalyzer=确定性领域逻辑、§6.2:1609 L6=呈现、SD No.42/A3 已锚定）。
- ~~GQ5~~（撤销）：satisfaction/Verification 正交已被 SD:322 + §1.8 matcher 三条件 + SD:795 三重锚定；唯一残点（ProduceDeliverable 无 Verification/CompletionClaim 前置）作为契约层显式说明，并入 GQ2 裁决文本。
- **GQ6**（B-2，保留）：AnyProducer 自动满足 = 常开 Coordination Consumer + produce 时点 Project 全扫描？
- **GQ7**（UD-4，新增）：SatisfyDependency 显式提交的 authority 归属（提案：consumer Work 所在 Workspace 的治理链——与 Declare 对称；producer/human 可观察不可裁决）+ agent 侧 Produce/Satisfy 的指令入口（与 GQ2(ii) 一并裁决）。

## Status

```text
DESIGN CLOSURE — proposal only. No P7 planning, no implementation.
After GQ1–GQ6 decisions: contracts land in docs/design/implementation/P7/
(frozen), then planning review → phases/P7.md → tasks.
```
