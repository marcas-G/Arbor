# P10 — Design Closure: Scope Extraction & Classification (PROPOSAL, not frozen)

> 依据治理指令：本轮仅做范围提取、三分类与治理问题清单（独立 gap review 后返回 true governance questions）；**不起草 P10 契约、不生成 planning**。

**Authority:** DID v1.12 §11 P10, §5.4, §6.1/§6.2 (L6), §10.2/§10.4.1 (projection-runtime), §7.2 (ProjectionQueryPort), Appendix B; SD v1.3 §7.4/§7.5, §10.1 D, §12 全章, §13.9/§13.10, §14 No.37/38/40/45/56; S1/S2/S4; P1 `05`/`06`, P2 `01`/`06`, P3 `04`, P4 `07`, P6 `00`/`04`/`05`, P7 `00`/`05`, P8 `00`/`05`, P9 `00`/`05`; `planning/gaps/P7-GAP-01.md`; `planning/results/P9.result.md`.
**Status:** SCOPE EXTRACTION (reviewed) — awaiting governance decisions GQ1–GQ7 before contract drafting.

## 1. Scope (DID §11 P10 + GQ2 移交 + GAP-01 hook)

```text
视图族：Responsibility Tree / Attention / Workspace Detail / Current Work /
        Verification / Dependency View / Transcript / Usage
状态投影：WorkspaceStatus（Work/Execution/Dependency 等事实派生的标签）
事实投影：EffectiveFacts（Canonical State + Curated Knowledge 的当前投影）
用户动作：Query / Steer / Stop（UI 只发 Command，不直写 DB）
P9-GQ2 移交：concrete business projections 的 at-scale rebuild
             （incremental checkpoints / per-projection retention /
              rebuild orchestration / query correctness）
P7-GAP-01 hook：WaitingOnVacantProducer derived Attention view（强制，不得 descope）
边界铁律：Projection never participates in authority decisions（DID §10.4）
```

## 2. Classification

### A. Upstream design defects / ambiguities（需治理裁决）

| # | 事项 | 证据 | 处置建议 |
|---|---|---|---|
| UD-1 | **视图清单未冻结**：SD §12.1/§12.4/§13.9 给了视图族与示例标签，但 P10 must-deliver 集合、字段形状、WorkspaceStatus 标签的穷尽性均未定（"等事实派生"的"等"字开放） | SD:1272-1278/1311-1322 vs DID §11 P10 九词 | **GQ1**：裁决 must-deliver 视图集与 status 标签穷尽表（P10 契约冻结） |
| UD-2 | **EffectiveFacts 定义过薄且归属模糊**：仅 DID:491 一行 + SD §3.2/Context 第 3 层；derive 输入集、刷新时机、与 Inbox/InboxAdvanced(observedSequence) 的关系无契约；它是认知面（Context Builder 输入）还是 P10 UI 面（或两者共用的一个 canonical-state 派生）未裁决 | DID:491; SD:214/348/609 | **GQ2** |
| UD-3 | **Attention 路由规则缺失**："presentation/routing is P10's frozen scope" 被多处引用但零契约：三级（Normal/Attention/Action Required）如何从六类事实源映射（Unfulfillable/Deadlock/SafetyEnvelope/ReconciliationEscalated/Verifier-orphan/vacant）、冒泡去重合并规则、两 dedup-key 事件的视图层呈现 | SD §12.3; P7-GAP-01:34; P9 04:38 | **GQ3**：裁决路由/分级/冒泡冻结面在 P10 契约 |
| UD-4 | **Query/Steer/Stop 的 External authority 依赖**：P2 `01`:72 点名 external human StopExecution "lands with the governance phase (P6/P10)"——P6 只做了结构检查、Resolver 仍 deferred；P10 用户动作接结构检查（同 P6 SteerWork 先例）还是补 Authority Resolver，或 DEFER 到 P12 生产面 | P2 01:72; P6 03 §1 | **GQ4** |
| UD-5 | **read model 一致性/新鲜度契约缺失**：DID §5.4 仅一句 retry/catch-up/rebuild；无 read-your-writes、无 staleness 可观察标记（S2"正在等待/阻塞"标签以哪个事实为准）、`ProjectionQueryPort` 只有名字无签名 | DID:1665/2180/4625 | **GQ5**：裁决 freshness 模型（建议：单调标记 + 落后可观察，不承诺 RYW SLA） |
| UD-6 | **UI 交付形态 P10 vs P12**：DID §11 P10 含 Query/Steer/Stop；生产 daemon/CLI/API surface 归 P12；apps/web 在 DID §10.1 存在但零实现——P10 交付"投影+查询+动作命令面（程序化，验收测试驱动）"而 UI 外壳（HTTP/console/server）留 P12，还是 P10 连外壳 | DID:3426-3428 vs 各期 boundaries | **GQ6**：建议二分（P10=可编程 read/query/action 契约面；P12=transport 外壳）——与 G6(v1.11) P14 "P10/P12 只消费"相容 |

### B. P10 phase-scoped closure（契约权限内）

1. 视图族契约：Tree/Detail/CurrentWork/Verification/DependencyView/Transcript/Usage 各自的 derive 输入（canonical 表+journal 事实）与查询形状（按 GQ1 裁决的 must 集）。
2. Attention 路由/分级/冒泡（按 GQ3 裁决形状）+ 六源映射表 + **WaitingOnVacantProducer 派生视图**（GAP-01 强制项：`dependencies(Unsatisfied∧WorkspaceBound) × works(无 Open Work ∧ workspace ¬Retired)` join，零新事件）。
3. ~~Human Override propagation derive~~ → **升格 GQ7**：`HumanInterventionApplied` 事件零 payload 且从未被发射（events.ts:141-144 空壳；application 全域零引用）；`WorkSteered` 实现载荷与 P6 `04` §2 契约不一致（P6 遗留偏差补录）；Intervention Summary 所需 actor/目标/内容/时间事实源全缺——推导建立在无字段事件上，需上游裁决。
3a. **Inbox 投影的 P10 消费面**（BLK-2 修复）：P9 `05` §3.2 点名的 P10 surface 含 `InboxProjectionStore`——语义归 P6 `02` §4（admission/promotion/consumption），P10 拥有：Inbox 视图（未消费输入的查询/呈现）、GAP-01 同族的 at-scale rebuild 面、`InboxAdvanced(observedSequence)` 水位在 freshness 模型（GQ5）中的读取面。
4. `ProjectionQueryPort` 签名冻结 + api-contracts DTO（`api-contracts` 包依赖仅 domain——DID §10.4.1）；Problem DTO（§10.5）为错误呈现契约。
5. 业务投影 at-scale rebuild（GQ2 移交四项）：incremental checkpoint（按 sequence 水位）、per-projection retention **仅限投影侧状态生命周期（journal horizon 所有权归 P1 `04`，不变）**、rebuild orchestration（startup/手动/检测 drift）、query correctness（rebuild 后同状态——RB-4 语义在业务面重申）；复用 P1 generic 机制 + P9 修复后形态。
6. Transcript 读路径（session_entries 生产 SELECT + provider_turns/manifests 映射）与 Usage 聚合（per-workspace/subtree/project，输入 provider_turns.usage_json；默认只观察——不变量 45）。
7. Query 消费面：P14 只读消费（spawn query execution + 结果 Message/Inbox 回流呈现）；Steer/Stop 命令面（复用 P6 04/P2 命令，UI 只发 Command）；SD §12.5 第四动作 **Governance Change** 经既有治理命令面（formation approval/steer/stop/acceptance）呈现——无新语义，P10 只做入口呈现。
8. 偏差承接评估：P9.result 三条隐式契约中 lease-renew-expiry 与 one-Open 索引属 P12/文档注记，consumer A skip 属视图呈现语义（P10 契约写明视图如何显示 skipped）。

### C. Implementation / empirical choices

投影存储形态（extension of generic projection_state vs 独立物化表）；搜索索引是否引入；视图 API 风格（函数式 port vs SQL 视图）；Transcript 分页/过滤参数；Usage 聚合时机（读时 vs 定时）；rebuild 检测 drift 的比较粒度；P14 query execution 的驱动接线形态。

## 3. True governance questions（6 项）

- **GQ1（UD-1 + BLK-3，改）视图 must 集**：裁决材料含 SD §13.9/SD:1417 **全量**派生清单与 DID §11 九词的差异——`Search Index` / `Workspace Summary` / `Project Overview`（SD 列、DID 未列）与 `Agent Tree` vs `Responsibility Tree` 命名差异、**Inbox 视图**（BLK-2）逐项 disposition（must / descoped-with-rationale / 延后）；再定 must 集与 WorkspaceStatus 标签穷尽表（建议：Tree/Attention/Detail/CurrentWork/Verification/DependencyView/Transcript/Usage/Inbox 视图 must；Search 建议延后——无冻结查询语义；Summary/Overview 作为 Tree 的聚合呈现并入；status 标签五枚举 executing/waiting-runnable-not-admitted/waiting-blocked/idle/attention-flagged + 派生规则式）。
- **GQ2（UD-2）EffectiveFacts**：裁决为 canonical-state 派生的单一 read model（P10 拥有投影；Context Builder 按 P3 冻结面消费同源事实，不经 UI 面）？还是明确它是认知面资产、P10 仅提供其 derive 的查询面？
- **GQ3（UD-3）Attention 路由**：P10 契约冻结三级映射 + 冒泡（subtree 聚合不复制上下文）+ dedup（沿用事实源 dedup key）——确认此冻结面归属？
- **GQ4（UD-4，收窄）External authority 模式**：P10 承接 external 用户动作（含 Stop）的 authority 走 P6 结构检查先例（human principal 约定 + typed 拒绝；Resolver 仍 deferred），还是 P10 实现 Resolver？（注：P2 `01`:70-72 冻结 external Stop "lands with P6/P10"——无 defer-P12 选项，若要 defer 需先改 P2 冻结文本。）
- **GQ5（UD-5）Freshness 模型**：冻结为"投影单调水位（sequence）+ 读取时携带水位与 canonical lastSequence 的落后差可观察；无 RYW 承诺；stale 恢复沿 §5.4 retry/catch-up/rebuild"？或需要更强等级？
- **GQ7（UD-7，新增）Human Override 事实源**：裁决 `HumanInterventionApplied` payload schema（最小：actor/target workspace/summaryRef/occurredAt？）与发射点（SteerWork/Stop handler 同事务发射）；一并 disposition `WorkSteered` 实现-契约 payload 偏差（P6 `04` §2 冻结 {workId, fromRevision, toRevision, severity} vs events.ts 空壳——补录 P6 遗留 gap 并修复）。Intervention Summary derive 在此事实源裁决后回 phase-scoped。
- **GQ6（UD-6，改）交付形态二分**：P10 = 程序化投影/查询/动作契约面（验收测试驱动；apps/single-workspace 为先例形态）；P12 = transport 外壳（HTTP/console/server）。注：DID §11 P12 列表无 transport 明文、P10/P12 边界在 DID 无明文——本 GQ 即请求冻结该二分。apps/web（DID §10.1）是否 P10 建骨架留 P12 接线？

## Review record (independent gap review, round 1)

3 Blocking + 4 material findings — all fixed above:
R1 Human-Override derive promoted to GQ7 (fact sources absent: empty unequipped event, P6 payload deviation filed); R2 Inbox projection P10 face added (B-3a); R3 SD/DID view-list divergence (Search/Summary/Overview/naming) folded into GQ1 material; R4 GAP-01 join gained ¬Retired; R5 GQ4 defer-P12 option annotated against P2 frozen text; R6 retention hard-constraint pinned to P1 `04`; R7 Governance Change dispositioned; GQ6 assertion corrected (no DID transport-boundary text exists).

## 4. Status

```text
SCOPE EXTRACTION COMPLETE. No P10 contracts, planning, or implementation.
Next (after GQ1–GQ7): contracts →
four-way review → Blocking=0 → planning → implementation authorization.
```
