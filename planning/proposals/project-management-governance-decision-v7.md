# 项目管理治理决定 v7

## 决定

**ACCEPTED — 2026-09-30。**

人工治理接受 v7 候选治理包。该决定只接受下列精确 SHA-256 对应的字节版本；任一候选对象后续变更均不包含在本次接受中。

| 对象 | SHA-256 |
|---|---|
| project-management-decision-draft-v4.md | BA76E1C1AEA7E9A98271E330163CE2170A2356E3D6A16C98E6D56C8175C37C25 |
| project-management-decision-amendment-v5.md | 1F17C4F1F4D8C4610562E72A2BFFA0B96DAB95EE213684B910164CEEBE71B2E6 |
| project-management-decision-amendment-v6.md | D692C2F1E206CF8E6043590C25919ACC44A998D52229E9D2F7D8003BEDA01C74 |
| project-management-decision-amendment-v7.md | 1B79D2EF990A2CABE5AE086ACAF00E9F06CD420EA47DA7EEC7C052EAB7EC2509 |
| DPM-DG-01-project-directory-and-lifecycle-management.md | FD615F976743467399FE562686E07B7A926CE5E412D9B35FB75552DF9527F321 |
| project-management-governance-submission-v7.md | 4088C15C5FC80F7A5937BAA9279578BD0567A20BD8D3D6FA9A1FC8B08757D94E |
| project-management-governance-decision-v7.review.md | CD32D2DABDE2F7CFA60279BFD948163E9ACD081DE8291F0F9588B6979DC17E2D |

## 已接受的产品与语义边界

- 项目管理支持创建、目录切换、重命名、归档；不做硬删除或 Reopen。
- Project 与项目内部 Workspace/责任树严格分离；日常 UI 以名称导航，完整 ProjectId 只用于诊断/复制。
- ProjectDirectory 为 principal-scoped、逐页重新鉴权、可撤权、无协议层 oracle 的独立读契约。
- Rename/Close 是授权、CAS、审计化 canonical commands。
- Close 是归档：拒绝新业务活动，自动提交既有 cooperative StopExecution/Quiescence；不强杀 Execution、不自动 Cancel Work，已开始的 Provider/Tool/AgentLoopStep 按既有 durable recovery/settlement 收敛。
- 人类消息、Inbox、claim/admission、settlement/writeback、legacy ProjectName 迁移均按 accepted v4-v6 条款处理。

## 后续动作与限制

本决定授权**人工治理**将 accepted semantics 写入拥有语义的 docs/design/** 与对应 phase contracts，并记录 resolving revision。该设计落地前，DPM-DG-01 仍为 OPEN，工程实现仍未授权。

写入 owning contracts 后，按“目录读口 → Rename/Close 后端链路 → Web 项目管理面 → 机械验收”实施。若落实中出现未被本决定覆盖的产品选择、并发反例或恢复失败，应重新提出 Design Gap，而不是自行扩展语义。

