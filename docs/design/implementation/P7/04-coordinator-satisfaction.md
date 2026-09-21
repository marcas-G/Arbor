# P7 — 04 Coordinator Satisfaction (AnyProducer Auto-Satisfaction)

**Authority:** DID v1.10 G5、G6; DID §5.4（Consumer 规则）、§1.8（structural matcher）、§4.2、§12.10、§12.11（SatisfyDependency 行）; SD v1.3 §7.5:795; P1 `05` §3 / `06`（consumer 基建/死信）、§8（CommandReceipt 幂等）; P3 `03` §3（CommandGateway）; P6 D2（Report ≠ Deliverable）。
**Status:** DRAFT (first draft for contract review).

## 1. Event-driven P7 coordinator（G5 冻结闭合）

> 例如 Deliverable 到达后，Runtime 可直接满足匹配 Dependency；Parent 是否认为
> 结果足够则需要 Agent 判断。（SD §7.5:795）

```text
DeliverableProduced（produce 事务 COMMIT 后）
  → P7 coordinator（P1 consumer 基建上的 at-least-once consumer）
  → candidate lookup（project-scoped；§3）
  → 对每个 matcher=true 的 (deliverable, dependency)：
      SatisfyDependency via CommandGateway
      authority source = P7Coordinator（exact-bound，G6）
      CommandId = deterministic f(deliverableId, dependencyId, dependencyRevision)（§2）
```

- coordinator 是 runtime 执行角色（无 AgentId、无长期认知，DID §1.6 同型）；
  路径全程确定性，无模型调用。
- **正确性性质（冻结，先于触发集）**：对读取快照上每一对 current-and-matching
  的 (deliverable, dependency)——dependency.state=Unsatisfied 且
  `matchesExpectedDeliverable === true`——coordinator 必须最终至少提交一次
  `SatisfyDependency`（不漏）；至多有效一次（不重，§2 幂等）。触发集是该性质
  的充分实现，不是正确性本身。
- 触发时点（冻结最小集）：

| 事件 | 触发语义 |
|---|---|
| `DeliverableProduced` | 主触发：新 candidate 对既有 Unsatisfied Dependencies |
| `DependencyDeclared` | 复检：既有 deliverables 可能已匹配新 requirement（对称完整性，"不漏"的依赖侧入口） |
| `DependencyContractRevised` | 复检：新 contract 可能匹配既有 deliverables（旧 satisfaction 不被重解释，DID §1.8） |
| `DependencyWithdrawn` / `DependencyMarkedUnfulfillable` | 复检时点：terminal state ⇒ Unsatisfied 前置失败 ⇒ 无提交；作为 dependency 侧 revision/state 前进的统一触发保留，幂等无害 |

- 兜底正交：human/agent 显式路径（§5）始终可用；coordinator 延迟/死信不封锁
  satisfaction 通道。

## 2. Deterministic CommandId 与 at-least-once 幂等（DID §5.4）

```text
CommandId = deterministic f(deliverableId, dependencyId, dependencyRevision)
```

- Event→Command 使用 deterministic CommandId；at-least-once 重投由既有
  CommandReceipt 幂等吸收（DID §5.4；P1 §8 规则）。
- coordinator 侧跳过条件（提交前 advisory 检查，非权威）：matcher=false /
  dependency 非 Unsatisfied / 快照 revision 已前移。漏检无害——handler 侧权威
  拒绝（`DomainError.RevisionConflict` / `TerminalLifecycleMutation` /
  `DependencyNotSatisfiable`）。
- 并发竞争：两 deliverable 竞争同一 dependency → 首提交者赢（state/revision
  CAS，DID §12.11 冻结）；败者收 typed rejection；自动路径重投由 CommandId
  幂等吸收。
- 满足成功后的 wake 生产（`DependencySatisfied` → consumer WorkWait wake）归
  P7 wake-integration 契约；本文只拥有命令提交面。

## 3. Candidate lookup 契约接口（非实现）

> candidate lookup 的实现形态（扫描/索引）是 implementation choice，**不得把
> Project full scan 冻结为合同**。（DID v1.10 G5）

```ts
interface SatisfactionCandidateLookupService {
  readonly byDeliverable: (
    project: ProjectId,
    deliverable: DeliverableMatchView,          // §1.8 冻结视图
  ) => Effect<ReadonlyArray<DependencyCandidateView>, CandidateLookupError>;
  readonly byDependency: (
    project: ProjectId,
    dependency: DependencyCandidateView,
  ) => Effect<ReadonlyArray<DeliverableMatchView>, CandidateLookupError>;
}

interface DependencyCandidateView {
  readonly dependencyId: DependencyId;
  readonly revision: DependencyRevision;
  readonly producerBinding: ProducerBinding;
  readonly expectedDeliverable: ExpectedDeliverable;
}
```

- 输入：deliverable 侧视图 + project 的 Unsatisfied Dependencies 视图
  （`byDependency` 为对称反向）。
- 输出：匹配集——`matchesExpectedDeliverable(producerBinding,
  expectedDeliverable, candidate) === true` 的对（§1.8 冻结算法，coordinator
  与 lookup 均无自由度）。
- 冻结的正确性（仅此两条）：

```text
Sound（不重）    返回集内每对在读取快照上 matcher=true；集合语义，无重复
Complete（不漏） 读取快照上 project 内所有 matcher=true 的
                (deliverable, Unsatisfied dependency) 对均被返回
```

- **Implementation choice（显式不冻结）**：full scan / (kind, state) 索引 /
  物化视图 / 任何保持上述两条的形态。快照一致性策略同为实现选择——lookup 是
  advisory candidate 生成，权威校验在 `SatisfyDependency` handler（state +
  targetDependencyRevision + matcher 三重关卡）。
- Scope：同 Project 内；跨 Project 不查、不满足。

## 4. Coordinator 失败语义（DID §5.4 / P1 基建直译）

- Consumer 使用 at-least-once delivery；失败/毒丸事件 quarantine 进 **P1 既有
  `consumer_dead_letters` 基建**（quarantine 与 offset 前移同事务，consumer
  不停摆，P1 `05` §3 / `06`）。
- **不阻塞 produce 事务**：consumer/projection failure 不回滚 Domain
  transaction（DID §5.4）；`DeliverableProduced` 的 COMMIT 与 coordinator
  处理解耦。
- 恢复：retry / catch-up / replay 重投；重投由 §2 deterministic CommandId 幂等
  吸收。
- coordinator 不直接绕过 Command Handler 修改 Domain（DID §5.4）；唯一变更面
  是 `SatisfyDependency` Command。

## 5. Agent 显式请求路径（G6：单一命令面）

> 来源为 `ConsumerExecution`（consumer Work 所在 Workspace 的执行）或
> `P7 coordinator`；Agent/Coordinator 只能**请求** satisfaction，最终 matcher
> 始终 authoritative；自动路径与 agent 路径必须共用同一个 `SatisfyDependency`
> Command。（DID v1.10 G6）

```text
consumer Execution 内 directive: SatisfyDependency { dependencyId, deliverableId, ... }
  ↓ directive handler（P3 `03` §3 输出契约校验）
  ↓ authority fact: SatisfyDependencyAuthority = ConsumerExecution（exact-bound）
SatisfyDependency Command（与 §1 自动路径同一命令、同一 handler、同一 matcher）
  ↓
DependencySatisfied | typed rejection（请求 ≠ 满足）
```

- authority source 二值：`P7Coordinator | ConsumerExecution`；超出即
  `DomainError.AuthorityDenied`。
- **请求 ≠ 满足**：matcher 返回 false → `DomainError.DependencyNotSatisfiable`，
  Dependency 状态不变（DID §1.8）；agent 路径无豁免。
- 两条路径仅差 authority source 与 CommandId 来源（agent 路径
  caller-preallocated；自动路径 deterministic f(...)）——单一命令面，handler
  行为完全一致。
- 命令结果作为 model-visible Observation 回到发起 Execution（沿 P5 `03`
  directive execution result 先例）。

## 6. Must Not Decide

- No matcher / 算法 / Dependency 状态机修改（DID §1.8、§12.11 冻结；P0 domain
  已实现）。
- No 质量判定进入 satisfaction（structural 匹配与 Verification 正交，v1.10
  G2；质量门在 P8 的 Verification → Acceptance 链）。
- No Project full scan 或任何 lookup 实现形态冻结为合同（G5 显式禁令）。
- No coordinator 绕过 Command Handler 的 Domain 直写（DID §5.4）。
- No Message → satisfaction 转化（P6 D2 禁令逆向重申；Report ≠ Deliverable）。
- No scheduler / 决策表 / WorkWait 修改（P2；satisfaction 的调度后果只经
  wake → reevaluate 链）。
- No coordinator 内模型调用 / Agent 语义（确定性 consumer；无 AgentId）。
- No 跨 Project lookup / satisfaction。
- No `ProduceDeliverable` / `Deliver` 语义（归 P7 命令契约；本文只拥有
  satisfaction 提交面）。
