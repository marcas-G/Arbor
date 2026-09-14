# STEP P1-01B — Runtime Project Bootstrap

**Gate/决策**：EXECUTION_BASELINE §3-§12 + §18.1-18.6（D-030 六条：初始骨架模板 / E0 基线 ref / 0001 DDL / show 人读输出 / 重复 init 拒绝 / branch `arbor/root` + worktree `worktrees/root`）。

**实现地图**：
- `domain/project-path.ts`：normalizeProjectPath（§11 全语义）+ isPathWithinPrefix（段前缀）
- `domain/ids.ts`：branded ProjectId/WorkspaceId（uuid 守卫）
- `application/ports.ts`：GitPort/SqlitePort/FsPort + 四类 tagged error + ARBOR_HOME 解析（§4 优先级）+ 布局函数 + effectiveRefName
- `application/workspace-templates.ts`：§18.1 骨架渲染（纯函数）
- `application/project-bootstrap.ts`：init/show 编排（错误通道全收敛 BootstrapError）
- `infrastructure/`：git-cli（spawn argv，Windows 可移植）/ sqlite-node（打开即迁移，事务式逐版本）/ fs-node
- `migrations/0001_initial.sql`：§18.3 逐字（UNIQUE(project_id, kind)）
- `entrypoints/cli.ts`：parseArgs + Layer 组装 + dispatch

**不变式**：store E0 先于 DB 行落库；重复 init typed error（D-030 §18.5）；effective ref 在 init 即指向 E0（无"ref 缺失"边角）。

**验收**：integration 六场景（完整布局断言 / 重启 show 一致 / 重复拒绝 / 非 repo / 空仓库 / 未知 project）+ acceptance 双进程 CLI + UNIQUE 约束测试。

**偏差**：Effect v4 API 差异清单（Context.Service / Effect.callback / catchCause / Effect.result / Layer.provideMerge——记入 D-031-amend）；`@types/better-sqlite3` 9.6.0（types 停更于 9.x，基础 API 兼容 v13）；migrations 按 `process.cwd()` 解析（CLI 从仓库根运行）。
