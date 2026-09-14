# STEP P1-08 — Working → Effective 激活循环（架构核心）

**Gate/决策**：P1_06_09_GATES §P1-08A（D-038），逐条实现 P1_EFFECTIVE_ACTIVATION_PROTOCOL：
`REPORT COMPLETION → PREPARE → VERIFY → ACTIVATE`，PASS 自动进入 Runtime 持有的激活
（agent 无 activate 工具）；**激活点 = CAS ref 迁移成功的那一瞬**。

**实现地图**（`application/finalization.ts`）：
1. PREPARE：worktree `status --porcelain` 空则 no-changes 拒绝；否则 `add -A` +
   candidate commit（branch arbor/root）→ candidateSha
2. VERIFY：workspace.yaml `verification.local.commands`（structured argv，cwd 相对 worktree，
   各自 timeout）在 worktree 内执行——HEAD 即不可变 candidate（commit 先于验证，此刻树干净）；
   空命令集 = vacuous PASS；非零退出 = FAIL；无法启动/超时 = INCONCLUSIVE（绝不静默转 FAIL）
3. ACTIVATE（仅 PASS）：写三件 canonical 记录到 store
   `history/changes/<changeId>.json` / `history/verifications/<vid>.json` /
   `history/effective-results/<resultId>.json`（D-026 四字段，无自引用 SHA）→
   store commit → `update-ref refs/arbor/effective/<ws> <new> <expected>` CAS
4. 结果联合：pass / fail / inconclusive / no-changes / activation-conflict（CAS 失败 =
   ref 被外部移动——报告冲突，绝不覆盖）

**崩溃一致性**（合同 §8 的实现映射）：candidate 已存未验证 = 只是 commit（未激活）；
store commit 已建 ref 未动 = 暂存未激活；ref 已动 DB stale = ref 权威（P1-09 修 DB）；
激活完成后响应未送达 = 重启后 ref 即事实（不二次激活——CAS expected 保证）。

**验收**：integration 五态矩阵（vacuous PASS + CAS 移动 + canonical 记录断言 + worktree
干净 / FAIL ref 不动 / INCONCLUSIVE / no-changes / 外部移 ref 冲突）；
**acceptance 端到端**：真 init + 真验证命令，Fake 剧本驱动 agent write_file →
report_completion → `activate <resultId>` 进 store log、effective ref 移动、
transcript 记录 workspace_request。

**偏差**：验证在 worktree 内而非临时 checkout（HEAD==candidate 且树干净，语义等价，
避免每验证建临时 worktree；记入 gate 文档）；changeId/resultId 记录的
baseEffectiveResultId 暂为 null（P1 无前序结果链读取器，YAGNI）。
