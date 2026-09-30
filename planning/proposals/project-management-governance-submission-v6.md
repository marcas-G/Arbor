# 项目管理治理提交 v6

## 状态

**PENDING INDEPENDENT REVIEW — 不授权实现。**

候选治理包：

- C:\Arbor\planning\proposals\project-management-decision-draft-v4.md（固定 base）
- C:\Arbor\planning\proposals\project-management-decision-amendment-v5.md（固定 amendment）
- C:\Arbor\planning\proposals\project-management-decision-amendment-v6.md
- C:\Arbor\planning\gaps\DPM-DG-01-project-directory-and-lifecycle-management.md
- C:\Arbor\planning\proposals\project-management-governance-submission-v6.md

v6 仅处置 v5 review 的三项：

| v5 review | v6 处置 |
|---|---|
| StepEffectsCommitted successor | 不创建 successor；按已 resolved effects 形成 Interrupted，或真实 Tool refs 形成 OutcomeUnknown。NextStepReady/OutputRejected Retry 才 ensureSuccessor。 |
| legacy 原始数据修复 | 删除治理外/直接数据修复路径；只允许未来独立人工治理的审计化 migration/repair contract。 |
| Gap 自动停止矛盾 | 直接修订 Gap 非目标为“不强杀”，明确 Close 自动 cooperative StopExecution/Quiescence。 |

独立 review 必须固定五个候选对象 SHA；最终人工治理决定固定五对象和 review 共六 SHA。任何字节改变均使 review/acceptance 失效。只有 owning docs/design/** 落字、记录 resolving revision、Gap RESOLVED 后，才可实现。

