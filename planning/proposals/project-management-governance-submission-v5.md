# 项目管理治理提交 v5

## 状态

**PENDING INDEPENDENT REVIEW — 不授权实现。**

本轮候选治理包由以下对象组成：

- v4 base draft：C:\Arbor\planning\proposals\project-management-decision-draft-v4.md
- v5 amendment：C:\Arbor\planning\proposals\project-management-decision-amendment-v5.md
- Design Gap：C:\Arbor\planning\gaps\DPM-DG-01-project-directory-and-lifecycle-management.md
- 本 submission：C:\Arbor\planning\proposals\project-management-governance-submission-v5.md

v4 base 的 SHA 必须保持 BA76E1C1AEA7E9A98271E330163CE2170A2356E3D6A16C98E6D56C8175C37C25；v5 amendment 明确取代其中冲突条款。独立 review 必须固定四个候选对象的 SHA。随后人工治理决定必须固定 v4 base、v5 amendment、Gap、submission 和 v5 review 五个 SHA。

| v4 review Blocking | v5 处置 |
|---|---|
| R1 Provider/OutputRejected/NextStepReady | V5-1 只使用既有 TurnFailed/Interrupted/Failed/真实 Tool refs OutcomeUnknown；补齐 OutputRejected 两分支、AHT-6 ensureSuccessor 和 Stop 过渡。 |
| R2 legacy name 初次迁移 | V5-2 规定只读 preflight、合规原子 backfill、非法/变更 legacy 的 feature fail-closed 与独立人工治理修复。 |
| R3 Gap 自动 stop 冲突 | V5-3 明确 Close 自动 cooperative StopExecution/Quiescence，不强杀、不自动 Cancel Work。 |

任一对象变更均使 review/acceptance 失效。人工治理写入 owning docs/design/**、记录 resolving revision并将 Gap 标为 RESOLVED 前，实施仍未授权。

