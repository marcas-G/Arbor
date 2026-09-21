# P7 — 03 Runnability Classification

**Authority:** DID v1.10 §8.18A（Runnability single authority）、G3（v1.10）; SD v1.3 §5.2, §7.6, 不变量 20/53; P2 `02` §7, P2 `05` §2/§4/§5; P5 `02`（superseded）。注意：planning/proposals/P7/02 中 "classify 不读 Dependency 状态" 的推导与 G3 最终裁决相反，以 v1.10 为准。
**Status:** DRAFT (first draft for contract review).

## 1. Supersession（取代条款）

> **P7** later supersedes it with a dependency-aware implementation.（DID v1.9 G2 / §11 P5；v1.10 G3 重申）

- P5 `02` 的 provisional single-workspace `RunnableWorkSource` 实现自 P7 起被
  **dependency-aware 实现取代**。
- **Port 签名不变**（P2 `02` §7 冻结）：

```ts
interface RunnableWorkSourceService {
  readonly classify: (workspaceId: WorkspaceId) => Effect<{
    readonly current: Option.Option<WorkId>;
    readonly runnable: ReadonlyArray<WorkId>;
  }, RunnableWorkSourceError>;
}
```

- 取代对象是实现与分类语义，不是 port：P2 `ExecutionScheduler` 继续经由同一
  port 消费（P2 `05` §4），P2 不新增 runnable 语义。
- P5 `02` §2 的 provisional 语义（current/open only，无 wait 维度）整体作废；
  其 §3（P2 集成）与 §4（Must Not Decide）由本文继承并收紧。

## 2. classify 权威规则（冻结）

> `RunnableWorkSource` 的 classify 是 Work 是否 runnable 的唯一权威判定——
> `active WorkWait` 与 `unresolved blocking Dependency` 均不得被 classify 为
> Runnable。（DID v1.10 G3 / §8.18A）

```text
waiting(w) :⇔ w 存在 active WorkWait（P2 `02` §8 store 语义）
           ∨ w 存在 unresolved blocking Dependency（§3）

current    = workspace.currentWorkId 指向的 Work w，当 w ∈ Open ∧ ¬waiting(w)
          = None（unset / 非 Open / waiting(w)）

runnable   = { w ∈ Open(workspace) | ¬waiting(w) } − { current }
```

- current 基础语义沿 P5 `02` §2（currentWorkId pointer + Open 检查）；G3 吸收
  条款叠加其上：waiting 的 current 不得作为 continuable 呈现（classify 返回
  None）。
- 确定性排序沿 P5：by `WorkId`（stable）。
- **单负定义（冻结）**：`Unsatisfied Dependency` 单独不使 Work 非 runnable——
  只有存在引用它的 active WorkWait 时才 blocking（DID §8.16：DeclareDependency
  后不一定 Yield；S3 步骤 3：依赖≠停摆）。WorkWait 仍是唯一等待注册源，等待
  是认知决定。
- classify 是只读分类：不注册/清除 WorkWait（注册/清除事务归 P2 `05` §5）、
  不产生 wake、不变更任何 canonical 状态。
- 读取集（同一快照事务，沿 runnable-source.ts 既有 TransactionScope 模式）：
  `WorkspaceRepository.currentWorkId`、`WorkRepository` Open 集、`WorkWaitStore`
  active 集、`DependencyRepository` Unsatisfied 集。

### 2.1 与 §8.18A 决策表的关系（呈现输入）

> 上表的 "active WorkWait" 列因此是 classify 已保证事实的呈现输入，`decide()`
> 不承担隐藏 blocking 判定。（DID v1.10 G3 / §8.18A）

- `current = Some(w)` ⇔ 冻结表行 "Current Work Open 且无 active WorkWait"；
  `current = None` 覆盖其余表行。
- 决策等价性：表行 2–4（current 有 active WorkWait）与表行 5–7（currentWorkId
  =None）在相同 runnable 计数下产生相同决策（Idle / SelectCurrentWork /
  Admit Coordination）——classify 吸收 wait/blocking 后 decide() 无需独立
  WorkWait 输入即可复现整表。
- runnable 集合本身已排除一切 waiting Work（G3 禁令的直接落点）。

## 3. blocking Dependency 判定式（冻结）

复合查询（跨 `dependencies` 与 `work_waits`，同一快照）：

```text
blocking(d, w) :⇔ d.state = Unsatisfied
               ∧ d.consumerWorkId = w
               ∧ ∃ wait ∈ activeWorkWaits(w):
                     wait.conditions ∋ DependencyChanged(d.dependencyId, _)
```

- `_` = 任意 observedRevision：等待只要引用该依赖即成立，不比较版本。
- 蕴含关系（显式记录，防止两头误读）：`blocking(d, w) ⇒ waiting(w)` 已由
  active WorkWait 析取支成立。blocking 条款的价值是**封死反向实现**——不得把
  Unsatisfied Dependency 无条件当作 blocking，也不得把 blocking 判定挪回
  decide() 或任何 scheduler 侧逻辑。
- 本判定式同时是 Wait-for graph 结点与 deadlock attention（DID §11 P7、
  v1.10 G4；SD 不变量 42/A3）的定义输入，由对应 P7 契约文件引用。

## 4. Inherited evolution（P5/P6 对齐条款）

> P5/P6 既有实现作为 inherited evolution 对齐本裁决。（DID v1.10 G3）

现状基线：P5/P6 中 wait 感知位于 `scheduler.decide()` 的 `hasWait` 输入
（`scheduler.ts` 在 reevaluate 内直查 `WorkWaitStore`）；classify 本身无 wait
维度。G3 后该语义迁移至 classify：

| 项 | 迁移 |
|---|---|
| `apps/single-workspace/src/runnable-source.ts` | classify 扩查询 `work_waits`（active）+ `dependencies`（Unsatisfied ∧ consumer 引用），按 §2/§3 计算 current/runnable；port 签名与 TransactionScope/ambient 模式不变 |
| `packages/execution-runtime/src/scheduler.ts` `decide()` | **代码不变**；其输入语义变化——`reevaluate()` 不再直查 WorkWaitStore 计算 hasWait，hasWait 由 classify 保证（`current = Some ⇒ ¬waiting` ⇒ 恒 false 等价） |
| `ExecutionSchedulerLive` | WorkWaitStore 依赖从 reevaluate 判定路径移除（register/clear/dueTimers 用途保留，P2 `05` §5/§6 机制不变） |
| 现有 p5-runnable-source 测试 | 按 P7 期望更新：waiting current → None；Unsatisfied 无 wait → 仍 runnable；blocking 复合条件四象限；current-None-各-runnable-计数回归 |

- 决策表不变（P2 `05` §4 冻结）；本次迁移是输入语义归位（§2.1 等价性），
  不是决策语义变更。
- P2 stub（`RunnableWorkSourceStubLive`）不受影响（空分类满足 §2）。

## 5. No.20 联动

> No runnable work → no model call.（SD §5.2；不变量 20）

- classify 结果（`current = None ∧ runnable = ∅`）→ decide() = `Idle` → 无
  Execution admission → 无模型调用。
- waiting Work 的重新进入由 durable wake 驱动（DependencyChanged wake-signal
  生产归 P7 wake-integration 契约；机制归 P2），classify 不轮询、不补发 wake。
- 等待期间禁止模型轮询（不变量 53）。

## 6. Must Not Decide

- No `RunnableWorkSource` port 签名修改（P2 `02` §7 冻结）。
- No scheduler 决策表 / WorkWait 注册-清除机制修改（P2 `05` §4–§5；§2.1 的
  等价性说明不是表修改）。
- No 模型轮询 / classify 内模型调用（不变量 53；classify 是确定性查询）。
- No 质量判定进入分类（satisfaction/Verification 正交，v1.10 G2；质量门在
  P8）。
- No classify 直接读 Verification 状态（VerificationChanged 只作为 WakeCondition
  经 WorkWait 参与等待语义，P2 `05` §2；分类输入集以 §2 读取集为准）。
- No canonical 状态变更 / Work 生命周期转移（classify 只读）。
- No global / cross-workspace runnability 语义（分类范围 = 单 Workspace 内其
  Open Work；沿 P2 `02` §7 边界）。
