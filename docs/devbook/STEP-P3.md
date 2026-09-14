# Phase 3 — 向上收敛（D-042）

**Gate**：`P3_GATE.md`（H1 冻结验证 · H2 boundary 隐藏命令集存 parent store 区 ·
H3 promotion=merge+parent 自验证+CAS · H4 隐藏反馈过滤 · H5 命令式 governance 门）。

**实现地图**：
- `application/verify.ts`：runCommands 公共执行器 + verifyCandidate（任意 commit，
  独立 detached worktree，跑完即删）——`arbor verify --project --candidate <sha>` CLI
- `application/finalization.ts`：verification 记录新增 `commandsSnapshot`（H1 冻结：
  prepare 时读到的命令定义进正史，事后改 yaml 无法重写历史）
- `application/boundary.ts`：
  - `boundaryVerify`：parent store 区 `boundary/commands.yaml`（隐藏性=store 物理隔离），
    对 child 最新 effective candidate 在隔离 worktree 执行；`filteredDetail` 只回
    期望名+症状（H4，命令定义不泄漏）
  - `acceptWorkspace`（H3 promotion）：boundary PASS → merge child candidate 到
    parent 分支（冲突=typed error + merge --abort）→ parent 自身 local verification →
    `history/parent-accepted/<child>.json` + store commit + **parent ref CAS**；
    child ref 全程不动
- `application/child-creation.ts`：H5 governance 门——parent 配 `governance.commands`
  则提案 JSON 走 stdin 给独立进程，非零退出即拒（首行输出为理由）
- CLI：`verify` / `boundary verify --workspace <child>` / `workspace accept --workspace <child>`

**不变式**：Local Effective ≠ Parent Accepted（child ref 在 accept 前后逐字节相等——
验收断言）；boundary 失败必阻塞 promotion；隐藏命令的定义与完整输出永不进入任何
agent 可见面；merge 冲突不自动解决。

**验收（173 tests 全绿，三场景 acceptance）**：
- 全链：child 完成激活 → boundary vacuous pass → 配置隐藏失败命令 → fail+过滤详情
  （无 argv 泄漏）→ accept 被阻塞 → 修好隐藏期望 → accept 成功：parent ref 移动、
  child ref 不动、child 产物出现在 parent 分支、ParentAccepted 记录落正史
- 冻结：verification 记录含命令定义快照（name+argv）；verify 对激活 candidate 重跑 pass
- governance：stdin 收提案的独立进程门可拒绝（理由回传）也可放行

**偏差**：accept 的 parent ref CAS 未带 expected-prior（单写者锁已在 agent run 层，
CLI accept 层暂无并发面——记 open，P4 一并）；ParentAccepted 记录按 child 一份
（重复 accept 同 child = 覆盖更新，最新语义）。
