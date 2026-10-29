# FT-DG-02 — 完成后的 Work 无法继续查看（已解决）

## 状态

**CLOSED**。治理合同已接受并落地为 System Design v1.10 / DID v1.32；
Work Detail 投影和页面实现完成，正式 F22 浏览器旅程已通过。实现证据：
`planning/results/FT-DG-02-work-detail-implementation.result.md`。

下文记录的是治理前失败场景与定位，保留作历史证据；它不表示当前仍有此产品缺口。

## 用户可见场景

用户在 Work 页面查看目标和 Verification PASS，随后在待处理页记录 Acceptance。待处理项消失后，
重新打开同一个 Work 链接，页面显示“未找到该工作”，无法查看目标、Completed 生命周期和
已记录的验收。

F22 从生产构建、真实后台进程和浏览器复现该结果。测试没有读取 SQLite 或内部 Repository。
单独执行：


```powershell
pnpm exec playwright test --config playwright.pending-functional.config.ts --grep F22
```

## 边界定位

- `current-work` 在 Workspace 没有当前 Work 时返回 null；这符合它的语义。
- `workspace-detail.pendingWorks` 只列 Open Work；完成的 Work 不在列表中。
- Work 页面只从以上两处寻找目标。找不到时不会请求按 `workId` 仍可读取的 Verification。
- `workspace-detail.auditTimeline` 按冻结 P10 合同只列人工干预、WorkSteered 与
  DecisionRecorded，不列 WorkCompleted。不能把这个审计列表当成 Work 历史。

现有 F05 只能证明 PASS 前 Work 仍 Open、Acceptance 已记录且当前 Work 清空；不能
通过公开只读视图直接证明该 Work 的终态为 Completed。F22 因此保留为失败用例。

## 决策归属

需要由 System Design / DID / P10 与 P13 的相应文档决定一个按 `workId` 读取当前及
终态 Work 的公开投影，以及 Work 页对终态的展示。不得把 Completed Work 塞回
`current-work`，也不能靠重放 Session 文本推测生命周期。

建议合同见
`planning/proposals/completed-work-public-view-decision-draft.md`。
