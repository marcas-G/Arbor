# 首版验收项目恢复记录

日期：2026-10-12

## 部署

- 部署代码快照：`50ca63cf55fa9dc86a02f158824534ff0274fca7`。
- `pnpm typecheck`、`pnpm build`、Web typecheck/build、资源边界定向 Biome 检查通过；三份定向 Vitest 文件共 29/29 通过。
- 原首版隔离 SQLite 数据库和 Provider SecretRef 配置继续复用。停止期间未删除或重建数据库；`C:\Arbor` 既有数据库未打开或迁移。
- 恢复服务地址：`http://127.0.0.1:8787`。新 daemon PID 为 `744`，启动脚本就绪检查返回 HTTP 200。

## 验收项目收尾

操作前服务以 PID `9720` 运行。停止入口核对其进程入口和端口后停服；离线 Preview 确认精确验收 Project/Workspace、Workspace revision `1`、一个边界地址和一个有效资源 claim、无未结算 Execution，且无阻断。验收 Work 仍为 Open/current；因此没有伪造不存在的 StopWork，也没有对原 Work 提交其他命令。

经隔离的正式离线 Gateway 流程执行两条命令：

1. `UpdateResourceBoundary`：CommandId `f04573ae-8b78-4e48-8f49-a1f464e980cd`，Committed；Workspace revision `1 → 2`，boundary revision `0 → 1`，释放该验收 Workspace 的唯一 active claim。
2. `CloseProject`：CommandId `2d13058b-5464-4ab7-804a-5bddc4239221`，Committed；只关闭验收 Project，revision 为 `1`。

服务随后从同一数据库和原 Provider 配置启动。没有重新创建 Project。

## 重启后的公开 API 核验

- `GET /projects` 返回原用户 Project lifecycle `Open`、revision `0`，其 Root Workspace ID 为 `ws_01a12e7b-6e7f-7a6c-9d4a-72e9048ec275`；验收 Project 为 `Closed`。
- 用户 Root Workspace 的责任树状态为 `idle`。冻结投影将 `idle` 定义为 Workspace lifecycle `Active`，当前无执行、可运行 Work 或等待/阻塞条件。
- 用户 Workspace 的公开 Detail 返回一个资源边界地址，且与本机已配置的项目根匹配；验收 Workspace 的边界地址数为 `0`。
- 用户 Project 的 Attention 公开读面没有 `WorkspaceResourceActivationPending`，也没有其他目标到该 Workspace 的 Attention。当前 Work 为空。
- Edge 重新打开用户 Project 后显示正常工作台：责任树 Active/空闲、进行中 Work `0`、关注 `0`、需要处理 `0`；浏览器没有 page error，相关 API 响应均低于 HTTP 400。截图：`C:\Users\ThinkPad\AppData\Roaming\ArborFirstRelease\acceptance\06-user-project-after-fix.png`。

公开视图没有暴露底层 ResourceOwnership 行；本记录只报告公开边界、Workspace 状态和 Attention 证据，不推断 API 未提供的 ledger 字段。

## 范围

P15 Rename/Close 外部命令改动因与冻结起源规则冲突而未合入。P39–P42 未并入。此次恢复不构成完整 S1–S4 或完整功能旅程通过声明。

## 前端提示收敛后续部署

- 前端修复提交：`27c621572dd3256a96c5a16656c720f21300a832`；release 当前 HEAD：`8d3576155992389980673c70615f61496ff4e1a2`。构建资源为 `/assets/index-DjC2DDjX.js`。
- Web 测试 33 files / 241 tests 通过；Web typecheck/build 与根级 `pnpm typecheck` 通过。
- 同一隔离数据库启动的 daemon PID `16328` 仍就绪，服务地址仍为 `http://127.0.0.1:8787`。
- 全新上下文只读打开用户 Project 后没有 Pending/Unknown 提示。同一 SPA 的 client-only 模拟先显示 Pending，再从真实 `/views/attention` 读到 0 rows，Pending/Unknown banner 清除；在 Workbench 与 Attention 间导航后仍清除。`/commands` 被拦截一次且转发数为 `0`；没有 Provider 调用或用户数据写入。HTTP 响应均为 200，浏览器 page error 为 0。
- 截图：
  - `C:\Users\ThinkPad\AppData\Roaming\ArborFirstRelease\acceptance\13-user-project-fresh-after-notice-fix.png`
  - `C:\Users\ThinkPad\AppData\Roaming\ArborFirstRelease\acceptance\14-simulated-project-attention-empty.png`
  - `C:\Users\ThinkPad\AppData\Roaming\ArborFirstRelease\acceptance\15-simulated-same-spa-workbench.png`
  - `C:\Users\ThinkPad\AppData\Roaming\ArborFirstRelease\acceptance\16-simulated-same-spa-attention.png`
