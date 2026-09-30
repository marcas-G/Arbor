# 项目管理治理提交 v3

## 状态

**PENDING INDEPENDENT REVIEW — 不授权实现。**

本提交的候选裁决对象：

- C:\Arbor\planning\proposals\project-management-decision-draft-v3.md
- C:\Arbor\planning\gaps\DPM-DG-01-project-directory-and-lifecycle-management.md
- C:\Arbor\planning\proposals\project-management-governance-submission-v3.md

v3 针对 v2 独立审阅的五项 Blocking 作出封闭修订：

| v2 审阅项 | v3 处置 |
|---|---|
| R1 settle/writeback 与 Failed retry | DPM-3c 按“是否曾 committed admission + settlement”分支，保护 Settled writeback，并使 Closed 的失败变为 Declined。 |
| R2 Submit/Inbox 重放 | DPM-3b 令 Submit/Close 共享 gate，并定义 canonical-state-aware Inbox retract/no-op。 |
| R3 mutation/tool 并发 | DPM-3/DPM-3a 冻结 Open mutation 统一 gate、Closed 白名单和无新 Provider/Tool 的 drain。 |
| R4 同名 | DPM-2 固定 name key；DPM-4 对完整 scope snapshot 定义稳定、scope-local discriminator。 |
| R5 token/privacy | DPM-1a 定义逐页 reauth、revoke 线性化、scope-local revision 与统一无 oracle 失败。 |

## 接受链

独立审阅必须先固定上述三个对象的 SHA-256，且确认只针对该字节版本。随后单独的人工治理决定必须同时固定 v3 draft、Design Gap、v3 submission、v3 review 四个 SHA-256，并把 v1/v2 接受记录标为历史 superseded，才可授权人工治理更新 owning docs/design/**。

任何对象的语义或字节变化均使该轮 review/acceptance 失效，必须重新提交。

