# Arbor Web v1 — Product UI / IA 设计方案

**状态**: FROZEN — Web v1 product contract（用户 8 点修订裁决落地；focused review 8/8 CLOSED，FREEZE-CONFIRMED，Blocking=0）
**裁决来源**: 用户 ruling 2026-09-23（Arbor Web v1 技术基线冻结 + prototype 定位）+ 8 点 IA 修订裁决
**前置**: P13 protocol prototype（transport/WS/auth/fixtures/exposure-matrix 五项行为资产已验证）
**基线**: DID v1.15 · api-contracts（9 frozen views）· P12 `10` transport · P13 `02` exposure matrix

---

## 0. 定位与边界

- 当前 `apps/web` 视为 **protocol prototype**：验证了传输、失效、认证、DTO 回归、命令暴露五项行为资产；其 AppShell/页面/组件/表单/视觉全部可重做。
- Web v1 是**正式产品 UI**：围绕终端用户工作流组织信息，**不按 9 个 view API 机械映射 9 个页面**。视图 API 是数据源，不是 IA。
- 范围仍是"观测 + 冻结的人类治理操作"（P13 `02` 七命令）；**chat-first 仍 defer**（transcript 只读不变，EC-8 语义锁继续有效）。
- Server 仍是唯一真相：`/views` 读、`/commands` 写、WS 只 invalidation/refetch、无 optimistic canonical mutation——原样冻结。

### 技术基线（用户裁决，frozen）

```text
React 19 · Vite · TypeScript strict
TanStack Query        唯一 server-state cache
React local state/ctx 仅 client UI state
React Hook Form       治理表单
Zod                   仅 browser/user-input validation（不重定义 api-contracts）
CSS Modules + tokens  样式
native fetch / WS
Vitest + RTL + user-event + jsdom
自维护 typed History router（prototype 规划决策延续）
禁止：Next.js / Redux / Zustand / Tailwind / AntD / MUI / Axios
```

> 治理备注：本基线取代 P13 `05` §4 中"禁止 react-query/表单库"两列（当时 pin 策略）。
> 作为对已冻结合同的 recorded supersession，随本提案冻结记入新 phase 合同的
> TR-B（Arbor Web v1 baseline）；P13 五项行为资产对应测试全部保持绿。

---

## 1. 用户与核心工作流（IA 的组织原则）

**用户**：长期自治工作系统的人类所有者/操作者（S1–S4 的 user/root-parent）。

**六个循环工作流（job → IA 映射）**：

| # | 用户问题（job） | 对应 IA | 数据来源（frozen views） |
|---|---|---|---|
| J1 | "现在整体怎么样？有什么要我处理？" | **概览 Overview**（落地页） | tree(浅) + attention + usage(project) + root workspace-detail |
| J2 | "哪里卡住了/出事了？" | **关注事项 Attention**（独立页+全局嵌入，read-only） | attention |
| J3 | "这个工作区在干嘛？进展如何？" | **Workspace**（master-detail） | workspace-detail / current-work / transcript / inbox-view |
| J4 | "这件工作到什么阶段了？验收了吗？" | **Work Detail** | workspace-detail(currentWork/pendingWorks) + verification(workId) |
| J5 | "轮到我决策/干预了" | **待处理 Governance Queue** + 上下文命令 | inbox-view（各工作区聚合）+ 表单 |
| J6 | "花了多少？" | **Usage** | usage(groupBy) |

**导航模型**：`概览 · 责任树 · 待处理 · 关注事项 · 用量 · 设置` 六个一级入口；Workspace/Work 是**下钻目的地**（不是一级导航，从树/概览/关注/待处理四处进入，URL 可直达）。

**语义边界（钉死）**：

```text
待处理（governance queue） = 存在 concrete human action affordance 的事项
关注事项（attention）     = 诊断、风险、等待、异常事实 = read-only
```

同一 source 可在两处**引用**，但必须使用稳定 identity/dedup（dedupKey/target），
不得制造两个"事件"。UI 文案统一用"待处理 / 关注事项"；内部 feature/module
名保持 governance-queue / attention。

---

## 2. 页面 IA 与内容结构

### 2.1 Global App Shell

```text
┌──────┬────────────────────────────────────────────┐
│ Rail │  Topbar: 面包屑/上下文 · 全局新鲜度 · 问题toast │
│      ├────────────────────────────────────────────┤
│ 品牌  │                                            │
│ 项目  │              Content（路由出口）             │
│ 切换  │                                            │
│      │                                            │
│ 概览  │                                            │
│ 树    │                                            │
│ 待处理n│                                            │
│ 关注 n│                                            │
│ 用量  │                                            │
│ ────  │                                            │
│ 设置  │                                            │
│ 会话  │                                            │
└──────┴────────────────────────────────────────────┘
```

- **Rail（左，桌面常驻）**：品牌、项目切换器（多 projectId 记忆 + 新建入口）、六个一级导航、"待处理/关注"带未读计数徽章、底部会话块（actor、token 状态、断开）。
- **Topbar**：当前上下文面包屑（项目 > 工作区 > tab / 工作项）、全局新鲜度指示（WS 连接态 + 最近 watermark）、Problem toast 挂载点。
- **全局态**：`unauthenticated` → 全屏登录门（复用资产行为）；`unavailable`（全局性）→ 顶栏警示条；其余 problem 就地呈现。
- 移动端（<768px）：Rail → 底部 tab `概览 / 树 / 待处理 / 关注 / 更多`；`更多`收纳 用量、设置、会话/认证。**不引入"我的"概念**。Topbar 保留（简化为上下文+新鲜度）。

### 2.1A 路由基线（projectId-in-URL，frozen）

所有正式路由**必须携带 projectId**——多项目切换与 deep link 下 URL 不脱离项目上下文：

```text
/p/:projectId                    → Overview（项目落地页）
/p/:projectId/tree
/p/:projectId/queue
/p/:projectId/attention
/p/:projectId/usage
/p/:projectId/settings

/p/:projectId/workspace/:workspaceId
/p/:projectId/workspace/:workspaceId/:tab
/p/:projectId/workspace/:workspaceId/work/:workId
```

`Session.projectId` 仅保留"最近选择"会话记忆（新会话默认跳转目标），**不作为
deep-link identity**；URL 中的 `:projectId` 才是权威。切换项目 = 路由切换，
Query keys 随 projectId 维度自然隔离。

### 2.2 Overview（项目落地页）

回答 J1，一屏内三个区块（自上而下按紧急度）：

1. **待处理摘要**：未消费 inbox 中可操作条目 + ActionRequired 关注事项的合并 Top-N（≤5），每条带直达动作（→待处理页/工作区）。跨处引用使用稳定 identity/dedup。
2. **树顶快照**：root + 直接子工作区卡片行（状态徽章 + attention 计数 + currentWork 摘要），点卡片进 Workspace。
3. **健康与用量摘要**：attention 计数（按 severity）、全局 tokens/cost（`Unknown` 原样）、**"Root Workspace 最近活动"**时间线（root auditTimeline 尾部 N 条——文案明确限定为 root workspace，不呈现为"项目最近活动"，不扩大 DTO 语义）。

> Overview 是**客户端组合**：并行查询 tree(depth=1) + attention + usage(project) + workspace-detail(root)。不发明任何服务端聚合语义。

### 2.3 Responsibility Tree（责任树）——只读导航

- 主体：可调深度（depth 控件，映射 `responsibility-tree` 请求参数）的层级导航；节点卡 = 名称 + status 徽章 + subtreeAttention 冒泡计数 + currentWork.objective 摘要 + usage 摘要。
- **Tree 是 read-only navigation surface**，只负责三件事：
  1. **navigate**（点击 → Workspace）
  2. **select**（选中态）
  3. **inspect**（侧栏 mini-detail：status/currentWork/attention）

  **不提供任何快捷治理 mutation**（无 hover/right-click 纠偏/停止）——`SteerWork`
  / `StopExecution` 只出现在 Workspace / Work / active Execution 的明确上下文中，
  避免树变成第二个 mutation surface。
- **已知限制（显式）**：wire 上 nodes 是扁平前序列表（无 depth/parent 字段，P13 已记录的偏差），v1 按"有序节点列表 + 缩进样式待上游 depth-field TR"呈现；树深度控制仍有效（服务端参数）。
- 侧栏（桌面 ≥1280）：选中节点 mini-detail，常驻不换页。

### 2.4 Workspace（工作区，master-detail）

URL: `/p/:projectId/workspace/:workspaceId/:tab?`。头部 + **五个信息 tab**：

- **头部（常驻）**：名称/ID、responsibility purpose、boundary 摘要、status 徽章、subtreeAttention；右侧**上下文治理动作区**（见 §5 命令布置）。
- Tabs：
  - **概要**：current-work 卡（objective/status/activeExecution，**无选择动作**——selection 属 scheduler，P13 `02` §4 约束延续）+ pendingWorks 列表（→Work Detail）+ executionSummary。
  - **依赖**：dependencies 表（consumer/binding/state/satisfiedBy；行内无变更动作）。
  - **验证**：verification 块（criteriaResults 表 + evidenceRefs + acceptance）。
  - **对话记录**：transcript（只读、游标分页"更早"、**无输入框**）。
  - **收件箱**：inboxUnconsumed（kind/summary/watermark；不可操作条目只读）。
- Tab 即 URL 参数（可深链/刷新恢复）。

### 2.5 Work Detail（工作项）

URL: `/p/:projectId/workspace/:workspaceId/work/:workId`。从 Workspace 概要/概览进入：

- 生命周期头部：objective、status、activeExecution。
- **验证与验收区**：verification(workId) 全量（criteriaResults/verdict 徽章/evidenceRefs/acceptance 块）。
- **治理动作**：`AcceptWorkOutcome`（当验证通过且待验收时主呈现；acp_ 预分配）、`SteerWork`（带 exact workId/revision 预填）。
- 数据组合：父 workspace-detail 的 work 引用 + verification 视图；不发明 work 级新视图。

### 2.6 Attention（关注事项）——read-only

独立页 = 可筛选事故清单：severity 分组（ActionRequired 在前）、source 筛选（六源单选）、行 = source 徽章 + summaryRef + occurredAt + 目标工作区链接。Overview/Tree 徽章均为本页子集（同 dedupKey 引用）。**关注事项是诊断面，只读**：不在此呈现任何变更动作（变更动作在目标 Workspace 上下文）。

### 2.7 Governance Queue（待处理）

回答 J5——"轮到我的事"。**队列条目 = 存在 concrete human action affordance 的事项**：

- **决策卡（条件性，W-00 决定）**：仅当 frozen inbox DTO 能**机械恢复** proposalId + proposalRevision（结构化绑定，非解析 presentation string）时，DecisionCard 才提供 RecordDecision 动作（绑定 exact revision）。**若不能机械恢复：队列只显示该条目 + 点击进入对应 Workspace 收件箱，不显示 RecordDecision 动作**——正式产品不提供"手工输入 proposalId"的降级路径，不呈现假 action。未来若需完整 queue action target，走 transport DTO enhancement（上游治理），不由 Web 解析字符串。
- **待验收卡**：验证通过且未验收的 work（来自可见工作区 pendingWorks/verification 组合）→ [验收]。
- **只读条目折叠区**：其余未消费 inbox（无对应人类动作的）。
- 排序：ActionRequired > 时间倒序。与关注事项重叠的条目以稳定 identity/dedup 引用，不复制事件。

### 2.8 Inbox / Activity

不设独立页：inbox 按 workspace 并入 Workspace 收件箱 tab + 跨工作区可操作摘要并入待处理（"活动流"呈现已在 Overview/Workspace 的 auditTimeline；避免发明跨工作区聚合语义）。

### 2.9 Usage

groupBy 三态（workspace/subtree/project）+ 行表（tokens/cost/turns，`Unknown`≠0 原样）+ 与 ceilings 的**只读对照条**（若 DTO 提供；不发明预算语义）。

### 2.10 Settings

- **权限管理**：Grant/Revoke（现存 grants 列表 + 授权表单；pgr_ 预分配、`capability@target` scope、lifetime）。**issuer = 当前 authenticated principal，UI 呈现为 read-only**——不提供自由文本编辑，不发明"代表另一 principal 发 grant"的 delegated issuance 语义（负向 UI 测试锁定）。
- **项目**：项目切换管理 / CreateProject（引导表单，含全量冻结 payload 组装）。
- **会话**：token/actor 状态、断开、（内存态政策说明文案）。

---

## 3. Component Hierarchy

```text
providers: ErrorBoundary > SessionProvider > QueryClientProvider
         > WSInvalidationProvider > RouterProvider

AppShell
├─ Rail(NavItem, ProjectSwitcher, SessionBlock, AttentionBadge)
├─ Topbar(Breadcrumbs, FreshnessIndicator, ToasterHost)
└─ <Outlet/>
   ├─ OverviewPage(AttentionDigest, TreeSnapshotRow, HealthSummary, MiniTimeline)
   ├─ TreePage(TreeNodeList, DepthControl, MiniDetailSidebar)
   ├─ WorkspacePage(WorkspaceHeader, ContextualGovernance, Tabs)
   │   ├─ OverviewTab(CurrentWorkCard, PendingWorkList, ExecutionCard)
   │   ├─ DependencyTab(DependencyTable)
   │   ├─ VerificationTab(CriteriaTable, EvidenceList, AcceptanceBlock)
   │   ├─ TranscriptTab(TranscriptList, LoadMore)
   │   └─ InboxTab(InboxList)
   ├─ WorkPage(WorkHeader, VerificationPanel, GovernanceActions)
   ├─ AttentionPage(SeverityGroups, SourceFilter, AttentionRow)
   ├─ GovernanceQueuePage(DecisionCard, AcceptanceCard, ReadOnlyInbox)
   ├─ UsagePage(GroupBySwitch, UsageTable)
   └─ SettingsPage(PermissionsPanel, ProjectPanel, SessionPanel)

shared: ViewSection(query-bound 渲染容器) · ProblemCard(6 category) ·
        FreshnessChip · StatusBadge(statusTone) · DataTable · KeyValue ·
        EmptyState · Dialog · Tabs · Field(Input/Select/Textarea) · Button ·
        MonoText · TimeText
commands: CommandDialog(RHF+Zod 包装：提交态/回执/内联拒绝/重试同 id)
          × 7 frozen forms
```

---

## 4. State / Query Ownership

| 层 | 拥有 | 说明 |
|---|---|---|
| **TanStack Query** | 全部 server state | `queryKey = ['view', viewId, request]`；fetcher = 统一 transport 模块（解包 `QueryResult.value`、Bearer、401 升级、本地 unavailable Problem——移植自 prototype 两处 fetch 层并合一） |
| WS Provider | 单连接 | 帧 → `queryClient.invalidateQueries({queryKey:['view', frame.view]})`，**仅此一效**；重连退避；连接态供 FreshnessIndicator |
| Session ctx | token/actor/projectId（纯内存） | 401 全局门；projectId 仅"最近选择"记忆，deep-link identity 在 URL（§2.1A） |
| Router（typed History） | URL/选中/tab | project-scoped 路由（§2.1A）：`/p/:projectId`（overview）/p/:projectId/tree · /queue · /attention · /usage · /settings · /workspace/:id/:tab? · /workspace/:id/work/:workId |
| RHF | 七表单本地态 | Zod schema 镜像**冻结 payload 形状**（仅输入校验，不改语义）；commandId/acp_/pgr_ 预分配 + 失败重试同 id（资产行为） |
| Committed 副作用 | invalidate 相关 view 查询 | 回执 Committed → 按命令类型失效树/详情/队列等 query keys |

**禁止**（延续冻结）：帧内容写缓存、乐观更新、浏览器端聚合"合计"、第二套 projection 状态。

---

## 5. Command Placement（七命令布置）

| 命令 | 位置 | 触发条件 |
|---|---|---|
| CreateProject | Settings·项目 + 项目切换器"新建" | 未设 projectId 时 Overview 也给引导 |
| RecordDecision | 待处理·决策卡（主）+ Workspace·收件箱条目 affordance | **仅当 W-00 证明 frozen inbox DTO 可机械恢复 proposalId+revision（结构化绑定）**；否则条目只读展示 + 跳转，无假 action、无手工输入路径 |
| SteerWork | Workspace 头部 + Work Detail | currentWork 存在；预填 workId/revision（Critical 双确认延续）。**Tree 不提供** |
| StopExecution | Workspace 头部 danger 区（activeExecution 卡上） | 两段式确认延续；external Human/Parent stop 请求，resolver 唯一 enforcement。**Tree 不提供** |
| AcceptWorkOutcome | Work Detail（主）+ 待处理·待验收卡 | 验证通过待验收 |
| Grant/Revoke | Settings·权限 | Revoke 需现存 grant；**issuer = authenticated principal read-only**（§2.10，负向测试） |

> **W-00 前置证明（frozen 规则）**：Queue 的 action target 可行性在 W-00
> 机械验证——能结构化绑定 → DecisionCard 提供动作；不能 → 只展示条目 +
> 跳转 Workspace 收件箱。**"手工输入 proposalId"不是正式产品的降级路径**；
> 未来完整 queue action target 走 transport DTO enhancement（上游治理），
> 不由 Web 解析 presentation string。

---

## 6. Design System（植物学纸面，延续 GQ3）

- **tokens**：沿用 prototype `tokens.ts`（30 token：paper/ink/leaf/branch/attention/danger/muted/sky + serif/mono + 阶梯），新增：`--arbor-surface`（弹层底）、`--arbor-focus`（focus ring 色）、密度变量（紧凑表格行高）。
- **组织方式**：CSS Modules（组件级）+ 全局仅 tokens.css/reset；**EC-10 扫描测试延续**（色/字号字面量仅 token 文件）。
- **组件语言**：纸面卡片（细线 + 单层阴影 + 3px 圆角）；serif 标题/正文、mono 数据（ID/时间/事件/数值表）；leaf 确认系、rust 危险系、amber 注意系、muted 未知/空位；树连接线用 branch 色 1px 竖线（缩进层级感）。
- **motion**：≤150ms ease-out（弹层进入/徽章态变化）；无大位移动画。
- **图标**：不引图标库（延续）——排版符号 + token 色。
- **暗色**：不做（token 预留换肤能力）。

## 7. Responsive Behavior

| 断点 | 布局 |
|---|---|
| ≥1280 | Rail + Content + Workspace 页可选右侧 mini-detail 栏 |
| 768–1279 | Rail 收窄为图标栏；master-detail 上下堆叠；表格横向滚动 |
| <768 | 底部 tab（概览/树/待处理/关注/更多——`更多`收纳 用量/设置/会话）；单列；表格 → KeyValue 列表；树 → 缩进列表；命令 Dialog → 全屏 sheet；Topbar 简化为上下文+新鲜度 |

---

## 8. Prototype 资产处置（保留 / 重做）

### 保留（行为资产 1–5，测试随迁保持绿）

| 资产 | 文件/模块 | 处置 |
|---|---|---|
| API transport behavior | `data/client.ts` + `session/useSessionFetch.ts` 的解包/认证/401/本地 Problem 逻辑 | **合并**为 `src/api/transport.ts`（Query fetcher），行为与测试用例随迁 |
| WS invalidation/refetch | `data/invalidation.ts`（channel） | 原样保留；消费端改为 invalidateQueries |
| authentication boundary | `session/*`（内存 token、禁持久化、401 全局门、LoginCard/UnauthorizedGate 行为） | 行为保留，视觉并入设计系统 |
| DTO fixtures/regression | `views/fixtures.ts` + render/problems 测试用例 | fixtures 原样；用例指向新组件 |
| exposure matrix | `commands/catalog.ts` + `envelope.ts` + `uuid7.ts` + `submitCommand.ts` + `useCommandSubmission` 语义（预分配/重试同 id/回执态） | 原样保留；表单层换 RHF+Zod |
| tokens | `tokens.ts/tokens.css` | 原样 + 增补 |
| 服务端 | daemon/TR-W1/W2、e2e、architecture tests（p13-web-boundaries/p13-closure） | 不动（pins 测试按新基线更新清单） |

### 重做

`App.tsx`、全部页面/视图组件 UI、表单 UI（RHF+Zod）、CSS（CSS Modules 重写）、路由（升级为 typed router 模块）、导航与 IA。

---

## 9. 不变量（延续冻结，开发计划验收项）

1. `apps/web → @arbor/api-contracts`（type-only）；禁 domain/application/ports/adapters/projection-runtime
2. 七命令暴露集 == `02` 矩阵；无 SelectCurrentWork 控件 / 无 SendMessage chat / 无 Search
3. WS 只 invalidation；无乐观更新；无浏览器聚合语义
4. Problem 六 category 明确呈现；401 全局门；TerminalRejected 内联可重提
5. 未知枚举原样 + muted；cost Unknown ≠ 0；时间戳原始值可查
6. token/actor 纯内存（禁 localStorage/sessionStorage/cookie）
7. 依赖 exact pin（新基线集合：+ @tanstack/react-query、react-hook-form、zod、@testing-library/user-event）
8. **所有正式路由携带 projectId**（§2.1A）；Session.projectId 非权威
9. **Tree 只读导航**（navigate/select/inspect；无任何 mutation surface）
10. **待处理 / 关注事项语义边界**：queue = concrete action affordance；attention = read-only 事实；跨处引用用稳定 identity/dedup
11. **GrantPermission issuer = authenticated principal，UI read-only**（负向 UI 测试锁定，无 delegated issuance）
12. Queue action target 只能来自 frozen DTO 的**结构化绑定**（W-00 证明），不得解析 presentation string；无假 action、无手工 proposalId 输入路径
13. Overview 时间线文案 = "Root Workspace 最近活动"（不扩大为项目级语义）
