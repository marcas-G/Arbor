# P14 — 04 Web Surface（对话面 UI）

**Owns:** 对话面的 UI 落位与输入面
**Does not own:** 命令/执行/read model（`01`–`03`）
**Web v1 关系**：架构不变量全部延续；§0/§2.4/路由模型的 chat 解除按 TR-C
（见 §6），其余零改动

## 1. 落位（frozen，G-F）

```text
Root Workspace
  对话 tab（conversation）           ← 原"对话记录"tab 升级
  ├── transcript（升级 read model）
  └── composer（唯一输入面）

Child Workspace
  对话记录 tab                        ← 保持 read-only，无 composer

Overview
  "与 Arbor 对话" 快捷入口            ← 仅 deep-link：
  /p/:projectId/workspace/:rootWorkspaceId/conversation
```

- **不建 `/chat` 独立产品域**（路由即 workspace conversation tab）。
- rootWorkspaceId 来源：tree nodes[0]（Web v1 既有 root 判定）。

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

## 6. Tracked revision（TR-C，DID v1.16）

对 Web v1 product contract（`planning/proposals/web-v1/01`）的 recorded
supersession：§0 chat-first deferral 由 P14 解除；§2.4 Root 的"对话记录"
tab 升级为 conversation（transcript + composer），child 保持只读；
`WORKSPACE_TABS`/route model 修订（6 tabs）归 P14 实现；EC-8 证据文本
收窄为"无 SendMessage 型输入控件"，语义核心不变。
