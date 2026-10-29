# 项目管理治理提交 v2

## 状态

**PENDING MANUAL GOVERNANCE — 不授权实现。**

本提交要求人工治理只对下列不可变审阅对象作出 `ACCEPT`、`REVISE` 或 `REJECT`。

- 决策草案：`project-management-decision-draft-v2.md`
- 关联缺口：`planning/gaps/DPM-DG-01-project-directory-and-lifecycle-management.md`
- 审阅：`project-management-governance-decision.review.md`

本提交固定的 SHA-256：

```text
project-management-decision-draft-v2.md
2035300702F9BE8A3333786DFEA258CBD7F21C410434C6DD4BBE333FB3237DB9

DPM-DG-01-project-directory-and-lifecycle-management.md
7672E7F6CFF3523B040D297331F54282EEBFAD198323DA2CCFA6DB1BA8F9FEE1

project-management-governance-decision.review.md
42679DA6B974FC86388EA67A8C88ED39B4360417BB2D72B6C307EBE336D4FEE5
```

任何草案语义修改都必须生成新提交和新哈希，不能复用本次 ACCEPT。

## 本轮处置

| 审阅项 | 处置 |
|---|---|
| DPM-R1：可变引用 | v2 要求 acceptance 绑定 SHA-256；旧 `ACCEPTED` 记录不再作为实现依据。 |
| DPM-R2：Closed 队列/命令 | DPM-3a/3b 冻结 Closed command matrix、`Declined(ProjectClosed)`、线性化 gate 与独立 recovery discovery。 |
| DPM-R3：目录隐私/版本 | DPM-1a 冻结 principal/scope-bound opaque token、visibility 失效、fail-closed 与无泄露不变量。 |
| DPM-R4：同名项目 | DPM-4 选择允许重名，并要求同名时由 resolver 提供非 raw-ID、稳定、无歧义的辅助标识。 |

## 接受后的唯一下一步

人工治理把 accepted v2 的语义写入 owning `docs/design/**` 与对应 phase contracts，记录 resolving revision，随后将 DPM-DG-01 标为 RESOLVED。只有届时才可开始代码实现。
