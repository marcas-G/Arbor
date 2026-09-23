# P13 — 03 View Rendering & Problem Presentation

**Owns:** 9 个 frozen view DTO 的呈现契约、fixture/render coverage、Problem 呈现
**Does not own:** view 语义/形状（P10 `05` / api-contracts，frozen）

## 1. 通用规则

1. 渲染输入**只有** `ViewResponseMap[V]` DTO（+ Problem）；组件不得接受
   其他来源的数据构造 view 内容（`01` I2）。
2. DTO 字段语义按 api-contracts 注释原样呈现；**未知枚举值**（如未来的
   `WorkspaceStatusLabel` / `AttentionSource` / severity 扩展）原样展示 +
   muted 样式，不映射不丢弃（`01` I5）。
3. `null` / `undefined` 可选字段 = "未发生/不适用"，呈现为空位，不呈现为
   零值或 false。
4. 时间戳（ISO string）本地化呈现 + 原始值可查（title/展开）。

## 2. 九视图呈现契约

| ViewId | 主呈现 | 关键组件语义 |
|---|---|---|
| `responsibility-tree` | 缩进树（root 顶部；depth 参数控件）；节点卡 = name + `WorkspaceStatusLabel` 徽章 + `subtreeAttention`（attention/actionRequired 计数，>0 高亮）+ `currentWork.objective` 摘要 + `usageSummary`（tokens/cost；cost=`Unknown` 原样呈现 "unknown"，≠0） | 节点点击 → `workspace-detail` 下钻（本文件 §4 导航） |
| `attention` | 按 severity 分组列表（ActionRequired 在前）；行 = source 徽章 + summaryRef + occurredAt + target 链接 | 行点击 → 目标 workspace 下钻；`AttentionSeverity`/`AttentionSource` 未知值原样（I5） |
| `workspace-detail` | 单 workspace 全景：responsibility 摘要、boundary、currentWork、pendingWorks 列表、executionSummary、dependencies 表（state 徽章 + satisfiedBy 链接）、inboxUnconsumed 计数列表、verification（criteriaResults 表：required 标记 + verdict 徽章 + evidenceRefs；acceptance 块）、auditTimeline（sequence + eventType + at，mono） | 各 ID 链接跳转对应下钻；`pendingWorks` 行**不是**选择控件（`02` §4）；activeExecution 卡带"停止该执行"紧急控件（`02` §2 StopExecution，显式确认） |
| `current-work` | 单卡：objective + status + activeExecution（executionId + admittedAt）；`null` → 空态"无当前工作" | 空态不得提供"去选择"动作（`02` §4） |
| `verification` | criteriaResults 全表 + evidenceRefs + acceptance 状态块 | verdict 徽章三态 + 未知值原样 |
| `dependency-view` | 依赖行表：consumer → binding → state → satisfiedBy；project 范围与 workspace 范围两个查询形态（DTO req 二选一） | state 徽章；行内无任何变更动作（变更走 `02` 矩阵，v1 无 dependency 类 Human-actionable） |
| `transcript` | 游标分页列表：kind 徽章 + summaryRef + at；`nextCursor` → "更早"分页 | 只读；不提供输入框（chat = P14+，`02` §5） |
| `usage` | groupBy（workspace/subtree/project）切换 + 行表（tokens/cost/turns） | cost `Unknown` 原样（P12 `04` TR-5）；合计只在 server DTO 提供时呈现，**不在浏览器聚合**（I2） |
| `inbox-view` | unconsumed 列表：kind + summary + watermark；消耗态由 server 呈现于后续 refetch | 无"标记已读"类动作（无对应 Human-actionable 命令） |

### Fixture/render coverage（硬要求 2）

每个 view 至少 3 个 fixture：**typical**（全字段）、**minimal**（仅必填/
空集合/`null` 可选）、**unknown-enum**（含未识别枚举值）。render test
断言：关键字段出现、未知值原样、空位语义（§1.3）。

## 3. Freshness 与 refetch

1. 初次进入视图：普通 query；收到 invalidation（TR-W1）后 refetch 同一
   `(viewId, request)`，可附 `FreshnessRequirement` barrier（P10 freshness
   机制，请求形状由 api-contracts/transport 定义）。
2. `projection/stale` Problem（category `stale`）→ 呈现"数据滞后"态 +
   重试动作；不静默吞掉（`03` §5）。
3. 视图卸载即取消在途请求；重入时以 server 响应为准（无本地合并）。

## 4. 导航与信息架构（v1）

```text
顶栏：brand + project 切换（projectId 输入/记忆）+ token 状态
主导航：Tree · Attention · Usage
下钻：tree/detail/attention → workspace-detail；detail 内 ID 链接
      → verification / transcript / dependency-view / inbox-view
命令区：detail/attention 上下文中的 governance 动作
      （RecordDecision / SteerWork / AcceptWorkOutcome / StopExecution /
       Grant|RevokePermission；`02` §2）
```

路由为纯 UI 状态（URL path/query），不属于任何 server 语义。

## 5. Problem DTO 呈现（硬要求 3）

按 `category`（frozen Problem 词汇）给出**明确 UI treatment**；`code` /
`safeDetails` / `correlationId` 原样展示于详情展开：

| category | HTTP | UI treatment |
|---|---|---|
| `unauthenticated` | 401 | 全局"未认证"态：token 输入/重连；屏蔽内容区 |
| `forbidden`（含 `authority/denied`） | 403 | 明确"权限拒绝"面板：code + `safeDetails.reason`；**不做**客户端预权限判断 |
| `not-found` | 404 | "对象不存在"空态 + 返回导航 |
| `invalid-request`（含 `transport/*`、`projection/invalid-request`） | 400 | 表单错误态 / 请求构造错误提示；`safeDetails` 展开 |
| `stale`（`projection/stale`） | 409 | §3.2 |
| 其他（`projection/unavailable` 等） | 503 | "服务不可用"态 + 重试（按 `retryDisposition` 呈现可/不可重试） |

- `CommandReceiptView` `TerminalRejected` → 命令面板内联错误（rejection +
  correlation 信息），表单保持可改可重提（新 commandId）。

## 6. Must Not Decide

- 不决定 view 语义/新 view/Search；
- 不决定 status label / severity 的再映射表（原样呈现）；
- 不决定命令结果之外的业务推断（如"rejected 后应该……"的下一步编排）。

## 7. Verification

`06` EC-3（9×3 fixtures render coverage）、EC-4（六 category Problem
render tests + TerminalRejected 内联态）。
