# 已完成 Work 的公开读取与页面展示 — 治理决策稿

状态：**DRAFT / 等待人工治理接受**

缺口：`FT-DG-02`

实施：**尚未授权**

建议接受标识：`ACCEPT_COMPLETED_WORK_PUBLIC_VIEW`

## 建议决定

增加按 `workId` 精确查询的只读 `work-detail` View。它从 canonical Work 和已有
Verification/Acceptance 状态投影，不创建第二套 Work 生命周期。最少返回：

```text
workId, projectId, workspaceId
objective, lifecycle, revision
selectedVerificationId / targetWorkRevision / verdict（若存在）
acceptanceId（若存在）
```

`Open`、`Completed` 和 `Cancelled` 都能通过同一 Work 链接读取。`WorkPage` 从该
View 获取目标和生命周期，继续使用现有 Verification View 展示证据明细。Completed 在
中文界面显示“已完成”，并保留目标与验收信息。未知、跨项目或无权读取的 Work 使用
类型化错误，不回退成“当前列表没有，所以 Work 不存在”。

`current-work` 仍只表示 Workspace 当前正在承担的 Work；`workspace-detail` 的干预
审计列表仍只展示其原有事件类型。这样 Work 的终态读取有明确归属。

## 验收

使 `tests/functional/pending/completed-work-visibility.spec.ts` 通过：浏览器进入 Work
页面，记录 Acceptance 后再打开相同链接，仍看到原目标、“已完成”状态和验收结果。
同时验证按 ID 读取陌生/外项目 Work 的拒绝、取消态、重启后读取、旧链接与同一版本
Verification 的绑定。测试不得读取内部数据库充当成功判定。

若接受，仅在拥有相关语义的 `docs/design/**` 文档落字；用户此前的代写授权只在
人工治理明确接受后生效。
