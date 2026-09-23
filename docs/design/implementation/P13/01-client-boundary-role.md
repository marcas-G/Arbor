# P13 — 01 Client Boundary & Role

**Owns:** `apps/web` 的包边界、角色冻结、状态纪律、依赖规则
**Does not own:** view 语义（P10）、transport 语义（P12 `10`）、command 语义（domain/application）

## 1. Boundary（frozen）

```text
                     ┌─────────────────────────────────────────┐
                     │  apps/web  (Vite + React, TS/ESM)       │
                     │  Projection Renderer + Command          │
                     │  Initiator                              │
                     └───────┬─────────────────────────────────┘
                             │ 仅 HTTP /views/:view · POST /commands · WS
                             │ （浏览器运行时；无进程内调用）
             ┌───────────────▼────────────────┐
             │ apps/single-workspace daemon   │
             │ (api + ws + static hosting)    │
             └────────────────────────────────┘

编译期依赖（唯一允许的后端包）：
  apps/web → packages/api-contracts        ✅（ViewId/DTO/Problem 类型）

编译期禁止（architecture test 强制）：
  apps/web → @arbor/domain                 ❌
  apps/web → @arbor/application            ❌
  apps/web → @arbor/projection-runtime     ❌
  apps/web → @arbor/adapters/*             ❌
  apps/web → @arbor/ports / 其他 packages/* ❌
frontend libraries（react/react-dom 等）     ✅（exact pin，`05` §4）
```

## 2. Role freeze

P13 UI 的角色冻结为 **Projection Renderer + Command Initiator**：

1. **Projection Renderer**：把 server 返回的 view DTO 渲染为 UI；对 DTO 字段
   不做语义再解释——未知枚举值/标签按"原样展示 + muted 样式"处理，不映射、
   不丢弃、不推断。
2. **Command Initiator**：为 Human-actionable commands（`02` 矩阵）构造
   `ExternalCommandEnvelope` 并提交 `POST /commands`；outcome 只读
   `CommandReceiptView`（Committed / TerminalRejected）。

不得成为（negative role freeze）：

- **Domain Interpreter**：不在浏览器解释 domain 状态机/生命周期规则；
- **Authority Resolver**：不做任何权限判断、不隐藏"服务器会拒绝"的提交；
  AuthorityDenied 作为普通 Problem 呈现（`03` §5）；
- **Workflow Engine**：不在浏览器编排多命令序列的"事务"；多命令操作
  （若 UI 提供）逐条提交并逐条呈现 receipt，不发明客户端原子性。

## 3. State discipline（单一真相）

1. **Server views 是唯一 projection 状态源**。浏览器持有的只是
   render cache：`(viewId, request) → DTO` 的可丢弃缓存，随时可被
   refetch 覆盖，刷新后语义不变。
2. **WS 只用于 invalidation/refetch**（TR-W1）：收到
   `{kind:"invalidate", view, watermark}` 后，对当前展示中且 viewId 匹配的
   视图执行 refetch（可带 FreshnessRequirement barrier）。**禁止**在浏览器
   根据 domain event 自行 replay / 增量更新 / 维护第二套 canonical 或
   projection state。
3. **命令乐观更新禁止**：提交后 UI 状态只能来自 server 返回的 receipt +
   后续 view refetch；不做乐观本地变更。
4. UI 本地状态（选中节点、展开/折叠、表单草稿、token 输入）不属于
   projection state，不受本节约束。

## 4. Auth & identity

- 浏览器只持有 **token**。**存放方式冻结**：内存态（React state/context）
  + 显式输入框；**禁止** localStorage / sessionStorage / cookie 持久化
  （v1 无记住登录）；页面刷新后需重输。
- principal 由 server transport boundary 证明（P12 `10` §3 static
  authenticator；生产可换 IdP adapter，边界不变），UI 不自证身份；
  **无 principal 查询端点**——server 不返回 principal 摘要。
- envelope 的 `actor` 字段由 client 作为 opaque string 填写（来源：用户
  显式输入，本地记忆于会话态）；Authority 只由 server Authority Resolver
  决定，`actor` 填错导致的拒绝按普通 Problem 呈现（`03` §5）。

## 5. Invariants

| # | Invariant | Enforcement |
|---|---|---|
| I1 | `apps/web` 编译期零 domain/application/projection-runtime/adapters/ports imports | architecture test（`06` EC-2） |
| I2 | 所有 view 数据来自 `/views/:view` 响应；组件不得从 command receipts 或 WS 帧构造 view 内容 | code review + render test fixtures 只含 DTO 形状 |
| I3 | 所有变更经 `POST /commands`；无其他写路径 | architecture test：`apps/web` 源码 fetch/XHR/WS 调用白名单（`/views/*`、`/commands`） |
| I4 | WS 帧不进入 render cache 的写路径（只触发 refetch） | 单元测试 + review |
| I5 | 未知 DTO 枚举值原样渲染（muted 样式），不映射不丢弃 | render tests 含 unknown-enum fixture |

## 6. Must Not Decide

- 不决定新的 view / query / Search 语义（out-of-v1，P12 `10` §2）；
- 不决定命令的 authority 规则（server 唯一 enforcement）；
- 不决定 chat-first 对话面（P14+）；
- 不决定 `SelectCurrentWork` 之外是否新增 human selection 语义（`02` §4）。

## 7. Verification

`06` EC-1/EC-2/EC-3/EC-5/EC-9；render/invalidation 单测见 `03`/`05`。
