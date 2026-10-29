# 项目管理治理提交 v4

## 状态

**PENDING INDEPENDENT REVIEW — 不授权实现。**

候选裁决对象：

- C:\Arbor\planning\proposals\project-management-decision-draft-v4.md
- C:\Arbor\planning\gaps\DPM-DG-01-project-directory-and-lifecycle-management.md
- C:\Arbor\planning\proposals\project-management-governance-submission-v4.md

v4 对 v3 独立审阅 Blocking 的处置：

| v3 审阅项 | v4 处置 |
|---|---|
| R1 AgentLoopStep/Provider drain 与 claim gate | DPM-3 将 claim 纳入 gate，复用 Stop/Quiescence，并按 ProviderTurn、handoff、action、successor、settlement 状态冻结 close-drain matrix。 |
| R2 名称视觉冒充与版本 | DPM-2 固定 ProjectNamePolicyVersion 1、Unicode/UTS #39 版本、拒绝 control/format code points、持久 key/skeleton，视觉 collision 统一显示 discriminator。 |
| R3 绝对时延不干扰 | DPM-1 收窄为协议层无 oracle/无应用层人工 delay；明确共享基础设施的物理 timing 不在本阶段保证。 |

## 接受链

独立审阅先固定上述三对象 SHA-256 并明确仅适用于这些字节。随后单独人工治理决定必须固定 v4 draft、Design Gap、v4 submission、v4 review 四个 SHA-256；v1 决定为历史 superseded，v2/v3 为历史 REVISE 证据。只有人工治理将 accepted semantics 写入 owning docs/design/**、记录 resolving revision、再将 DPM-DG-01 标为 RESOLVED 后，才可实现。

任一对象变更均使当前 review/acceptance 失效。

