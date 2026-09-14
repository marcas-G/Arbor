# Phase 2 — Recursive Workspace Tree（D-041）

**Gate**：`P2_GATE.md`（G1 独立 worktree per workspace · G2 engineering-tree.json + `refs/arbor/tree` CAS ·
G3 树不变量（单 root/单 parent/无环/子集/兄弟不重叠/深度 3）· G4 Governance=确定性结构校验（语义判断留 P3）·
G5 `request_create_child` 工具 + `project tree` CLI · G6 per-workspace 惰性 agent）。

**实现地图**：
- `migrations/0003_multi_workspace.sql`：workspaces 的 UNIQUE(project,kind) →
  root 部分唯一索引；agents 加 workspace_id + UNIQUE(project, workspace)
- `domain/engineering-tree.ts`：TreeNode/EngineeringTree Schema + validateTree/
  validateAddChild 纯函数（复用 §11 段前缀语义；covers/overlaps）
- `infrastructure/tree-store.ts`：engineering-tree.json 读写 + commitTree
  （store commit + `refs/arbor/tree` CAS）+ treeRefCommit
- `application/child-creation.ts`：读 parent 正式 writable → 隐式 root 树 →
  结构校验 → child 骨架（模板 + CONTRACT.md 四要素）→ 单次 store commit →
  tree CAS + child effective ref（指向该 commit 即其 E0）→ 从 parent worktree
  HEAD 切 child worktree（branch `arbor/<ws-id>`）→ db 行
- `agent-runtime/tools/workspace-requests.ts`：+`request_create_child`（幂等
  requestId；拒绝理由作为 tool result 回给模型）
- `application/agent-runner.ts`：workspace 维度参数化（resolve ws → per-ws
  agent ensure → per-ws worktree → projection/activation 全链按 ws）
- `entrypoints/cli.ts`：`agent run --workspace <id>`、`project tree --project <id>`

**不变式**：结构真相 = 树 ref（CAS 原子迁移）；child 激活只动自己的 effective ref，
root 的 ref 分毫不动（物理隔离由独立 worktree 承担）；被拒的结构请求零副作用
（骨架写在校验之后，且校验失败早退）；"." 根前缀语义 = root 拥有全仓库（子集
违规只能出现在收缩过 writable 的非根 parent 下，或路径非法时）。

**验收（165 tests 全绿）**：
- 全链：init → createChild(src/core) → 树 2 节点 + CAS ref + child effective ref →
  child worktree 独立分支 → child agent 干活并激活（child ref 移动、**root ref 不动**、
  文件只落 child worktree）→ db 1 root + 1 child、child 惰性 agent
- 违规矩阵：非法路径拒绝（prefix-not-in-parent）、兄弟重叠拒绝（src/a vs src/a/sub）、
  幽灵 parent 拒绝；被拒后树保持原样
- agent 侧：request_create_child 合法通过 / 非法被拒且 `CHILD REJECTED` 理由
  作为 tool result 落 transcript（模型可读）

**偏差**：CONTRACT.md 为 child 合同的落点（WORKSPACE.md 骨架仍 TBD 模板——投影
读取侧 P2 未合并 CONTRACT.md，P3 处理 parent 视角时统一）；语义 Governance
（独立性/完备性判断）记 OPEN_QUESTIONS 留 P3。

**与概念的对照**：PROJECT_EXECUTION_MODEL 的"向下运动"六步在 P2 落地为
1-2（agent 提案 via 工具）→ 3（结构校验 governance）→ 4-5（apply+骨架+worktree）
→ 6（per-ws 持久 agent，惰性）；P9 的 ParentChildEffectiveRelation 与向上收敛全部留给 P3。
