# FT-DG-02 治理决策稿审阅

日期：2026-10-04

对象：`planning/proposals/completed-work-public-view-decision-draft.md`

当前 SHA-256：
`6E9D25F8EFCAB0722456A750F002D88297B21E7B41E4E08AD5D51E6187842BB8`

结论：**可提交人工治理决策；未接受、未授权实施。**

## 反证与边界

F22 使用真实后台进程和浏览器完成 Goal、审批、独立 PASS 与 Acceptance。重新打开
原 Work URL 后，页面显示“未找到该工作”，没有“已完成”、目标或验收记录。失败快照
位于 `.functional-test-results/pending/`。

源码边界：

1. `current-work` 在当前 Work 清空时返回 null，这符合名称语义，不能为显示历史而改写。
2. `workspace-detail.pendingWorks` 只列 Open Work；WorkPage 当前只从这两个入口取目标。
3. `workspace-detail.auditTimeline` 只列指定干预事件，不是 Work 历史库。
4. `verification({workId})` 优先选任意 Open Verification。若旧 Open 与正式验收的
   PASS 并存，恢复页面可能展示错证据。
5. Acceptance 和 CompleteWork 是分开的提交；短暂的“已验收、Work 仍 Open”不能
   被错误显示为 Completed。

决策稿把只读 WorkDetail 定为终态来源，并规定 Acceptance 精确绑定的 Verification
优先级、跨项目/工作区拒绝、投影完整性错误、取消态和重启读取，不靠 Session 文本
推测生命周期。

## 接受后的测试顺序

先将 F22 浏览器失败测试迁入默认功能门禁，再补公开 View 的陌生/外项目/错工作区、
取消、重启、验收与完成异步间隙，以及旧 Open Verification 反例。随后按接受稿
落地 `docs/design/**` 和实现；完成后运行全量 `pnpm check`、`pnpm test:functional`
与干净检出测试。F22 通过不能代替 F21 的资源授权证明。

本审阅不是人工接受。
