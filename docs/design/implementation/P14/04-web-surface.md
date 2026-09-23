# P14 — 04 Web Surface（对话面 UI）

**Owns:** 对话面的 UI 落位与输入面
**Does not own:** 命令/执行/read model（`01`–`03`）
**Web v1 关系**：架构不变量全部延续；TR-C 解除 chat-first defer，DID v1.17
TR-WPU-D 把正式项目 landing 校正为 Root Workbench（见 §6）；其余零改动。

## 1. 落位（frozen，G-F）

```text
`/p/:projectId` — Root Workbench（正式项目入口）
  ├── Responsibility Tree context/graph（server-projected parent edges）
  └── Root Conversation（transcript + composer，唯一输入面）

`/p/:projectId/tree` — Tree Focus/deep-link

`/p/:projectId/workspace/:rootWorkspaceId/conversation`
  └── Root Conversation 的 deep-link mirror，不是独立 landing

Child Workspace
  对话记录 tab                        ← 保持 read-only，无 composer
```

- **不建 `/chat` 或 `/workbench` 独立产品域**。
- rootWorkspaceId 只从成功 Tree DTO 中 `parentWorkspaceId === null` 的唯一 server-projected
  root 取得；浏览器不得根据 preorder、name、indentation 或 local state 推断/修复 parent。

## 2. Composer（frozen）

- 表单字段：bounded 文本（P6 quota 内，前端仅长度校验——Zod 输入校验层）。
- 提交 = `SubmitHumanMessage`（**第 8 个 Human-actionable command**，catalog
  追加；P13 `02` 矩阵其余不变——SendMessage 约束继续，`05` seam-10 负向）。
- messageId 客户端预分配（`msg_<uuid-v7>`）+ transport 失败重试同 id
  （Web v1 命令语义延续）；Committed 后回执呈现 + invalidate transcript。
- **无 optimistic 假消息**：Human turn 只在 server refetch 后出现
  （`05` seam-9 关联断言：提交后 composer 清空 + transcript 经 invalidation
  刷新出新 turn；不本地插入）。
- 排队态呈现：one-active-main 下消息 Committed 即"已入列"（durable
  Pending 是事实）；transcript 无 Assistant turn 前显示"排队中"派生态
  （由查询 Pending/最近 execution 状态派生，只读）。

## 3. 禁止项（机械锁定）

| # | 禁止 | 锁定 |
|---|---|---|
| 1 | UI 直连 `AdmitExecution`（任何形式） | web 源码扫描 AdmitExecution 零出现（seam-8） |
| 2 | child workspace 出现 composer | conversation tab 仅 root 渲染（seam-10 负向测试） |
| 3 | streaming/打字机效果/浏览器拼 delta | 除 WS 外无 EventSource/其他推送通道；turn body 只来自 /views（seam-9） |
| 4 | SendMessage 作为 chat 通道 | P13 no-forbidden-controls 延续（seam-3） |
| 5 | chat 里的 steer/stop 快捷语义 | 干预仍走 Web v1 既有上下文治理位（G-B 裁决） |

## 4. 必须呈现

- transcript：Human/Assistant turn（`03` DTO）+ 既有条目原样 + 未知 kind
  muted 原样（Web v1 不变量延续）；
- Problem 六 category（提交失败/幂等冲突走既有呈现）；
- 会话连续性无 UI 特殊态（Session 语义在 server；刷新后 transcript
  refetch 即恢复上下文）。

## 5. Verification

组件/页面测试：composer 校验与预分配重试；Committed→invalidate→refetch
出现 Human turn（非本地插入）；child 负向（无 composer、无 conversation
路由参数）；web 源码扫描（AdmitExecution/SendMessage/EventSource 零出现）。

## 6. Tracked revisions（TR-C + TR-WPU-D）

对 Web v1 product contract（`planning/proposals/web-v1/01`）的 recorded
supersession：§0 chat-first deferral 由 P14 解除；§2.4 Root 的"对话记录"
tab 升级为 conversation（transcript + composer），child 保持只读；
`WORKSPACE_TABS`/route model 修订（6 tabs）归 P14 实现；EC-8 证据文本
收窄为"无 SendMessage 型输入控件"，语义核心不变。

**TR-WPU-D（DID v1.17）**：正式项目入口由独立 Overview/dashboard 调整为
`/p/:projectId` Root Workbench（Tree + Root Conversation）；`/p/:projectId/tree` 保持
Tree Focus；`/p/:projectId/workspace/:rootWorkspaceId/conversation` 是 root conversation
deep-link mirror。只改变 product IA/presentation placement；root-only composer、child
read-only、SubmitHumanMessage semantics、WS invalidation、server single source of truth、
route 不新增 `/chat`/`/workbench` 均不变。D-1 只采纳该合同，未授权 Web route/component
implementation。
