# Phase 5+6 — 变更传播与人工控制面（D-044）

**Gate**：`P5_P6_GATE.md`（问题式，含用户两处修正：K2 必须实时非静态导出、
K3 阶段固化替代终态完成）。

**实现地图**：
- `application/impact.ts`：analyzeImpact（父两次 accepted 状态间 diff 文件 ∩
  child 前缀；**排除正被接受的 child 自身**——实测发现的 fast-forward 场景）；
  invalidateAffected（ParentAccepted 记录加 status:stale + 重叠路径，store commit）；
  accept-log.json（prev 指针）；acceptanceStatus（child 投影用）
- `application/boundary.ts`：acceptWorkspace 尾部自动传播（J1/J2 一体化）；
  K1 审批门（approval.required → pending-approval + 材料落 store；
  skipApproval 内部参数供 approve 后续接）
- `application/approvals.ts`：pending-approvals CRUD（决策即 commit）+
  **K3 里程碑**：confirmMilestone/currentMilestone——单调阶段号
  `history/milestones/<n>.json`，项目无终态
- `entrypoints/dashboard.ts`：K2 实时面板——Node 内置 http，树状态卡
  （kind/writable/effective@sha8/running-by-lock）+ 全局事件流，
  页面 2s 轮询；无树文件项目合成隐式 root（实测发现的 P1 项目盲区）
- CLI：approvals list/approve/reject（approve 自动续走 accept）、
  project milestone、dashboard

**不变式**：失效只改接受的有效性（历史永不删）；被接受的 child 自身不在
失效判定内；传播在每次 accept 后自动发生；里程碑只增不减——阶段固化，
没有"项目完成"终态（用户修正的语义）。

**验收（181 tests 全绿）**：传播三段式（A/B 互不干扰 → root 侵入 src/a →
下一次 accept 的窗口把 A 打 stale 带路径证据）；审批（挂起→拒绝保持未接受→
里程碑 1→2 递增）；dashboard API/页面轮询结构。

**实测发现的两个真问题（均已修+回归锁定）**：① fast-forward merge 使被接受
child 的自身变更落入 diff 窗口 → 自我失效（排除自身）；② 无树文件项目
dashboard 空视图（隐式 root 合成）。
