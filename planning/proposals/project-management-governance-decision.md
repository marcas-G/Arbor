# 项目管理治理决定

## 决定

**ACCEPTED — 2026-09-30，人工治理确认。**

人工治理认可
[`project-management-decision-draft.md`](./project-management-decision-draft.md)
中 DPM-1 至 DPM-5 的完整规则，作为 Arbor 后续项目管理能力的设计方向：

```text
创建 / 名称目录切换 / 重命名 / 归档（Close）
不做硬删除
本次不引入 Reopen
Workspace 树始终是 Project 内部责任结构
```

本决定特别确认以下原本可能被实现任意猜测的语义：

1. Project directory 是独立、principal-scoped 的读契约；本地单用户
   composition 可看到本地全部 Project，多主体 deployment 必须经 visibility
   resolver。
2. `RenameProject` 是 Open 项目的 CAS、授权、可审计 canonical command，改名
   不改变 `projectPolicyRevision`；Closed 项目不可改名。
3. `CloseProject` 在产品中称为“归档项目”，仅阻止新 autonomous admission；不
   自动停止已有 Execution、取消 Work 或删除任何历史，read/recovery/audit 继续。
4. 默认目录过滤 Closed，但用户可显式查看已归档项目；ID 不作为日常 UI 的主要
   显示内容。
5. 项目 ID 仍是 identity / 导航和诊断依据，不以名称唯一性替代。

## 后续治理动作

该决定授权**人工治理**在拥有语义的冻结设计文档中落地：DID 的 Project
command/event/transition/read-transport contracts，以及受影响 P1/P10/P12/P13/P14
phase contracts。此前，DPM-DG-01 保持 OPEN，工程实现不获授权。

拥有设计文档更新并标明 resolving revision 后，需：

1. 更新 DPM-DG-01 为 RESOLVED；
2. 建立带 TDD 验收矩阵的实施 phase/task；
3. 才能开始目录、RenameProject、CloseProject 与 Web 项目管理面的代码改动。
