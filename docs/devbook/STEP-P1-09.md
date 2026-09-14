# STEP P1-09 — 故障审计与 Reconciliation

**Gate/决策**：P1_06_09_GATES §P1-09A（D-039）：权威序 **store effective ref > Runtime
SQLite > agent memory**（合同冻结）。reconcile 只修 DB 索引、只报告——**永不激活**。

**实现地图**（`application/reconcile.ts` + ports 扩展）：
- DbHandle 增加 `queryMany`（sqlite-node all() 实现）
- `reconcileProject({projectId, home}, sql)` → ReconcileReport{repairs, effectiveRef, refOk, warnings}
  1. DB 文件丢失：open 自动重建（迁移）——`projects/workspaces/agents` 行从 ARBOR_HOME
     布局恢复；**source repo path 只存在于 DB——恢复时标记丢失，绝不编造**
  2. 未闭合 run（finished_at null）且 transcript 无终止标记 → 标 `crashed`（崩溃一致性）
  3. effective ref 只检查不修复：孤儿 commit（有 commit 无 ref 移动）保持未激活；
     外部移动过的 ref 被如实报告为权威

**故障注入测试矩阵**（PHASE1 P1-09 清单的 P1 可达子集，integration 真 git/sqlite/fs）：
- 模拟 SIGKILL（transcript 剥离 pause_marker + run 行重开）→ marked crashed
- `rm runtime.db` → 从布局重建全部行，canonical ref 前后一致，重建库可查询
- 孤儿 store commit → ref 不动（reconcile 无副作用，幂等）
- ref 被外部移动 → 报告值 = ref 实际值（DB 不覆盖 ref）

**未在本 STEP 覆盖**（P1 清单余项，受 P1 形态限制）：模型调用中断/工具 Unknown 的
运行时中继已在 P1-05（abort 不 commit）与 tool_result state 字段预留；compaction
丢失重建已由 P1-06 确定性保证（同函数重放）；transcript/索引失配的全面审计属后续
phase 的独立 verifier 机制（P1 无独立验证者角色）。

**验收**：四场景全绿；reconcile 后 DB 可用、canonical 状态零变化。
