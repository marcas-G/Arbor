# 已完成 Work 的公开读取与页面展示 — 治理决策稿

状态：**DRAFT / 等待人工治理接受**

缺口：`FT-DG-02`

实施：**尚未授权**

建议接受标识：`ACCEPT_COMPLETED_WORK_PUBLIC_VIEW`

## 建议决定

增加只读 `work-detail` View，请求精确包含 `{ projectId, workspaceId, workId }`。
服务端校验三个身份的归属；未知或跨项目/工作区目标不泄露目标内容，返回同一类型化
NotFound/Denied 问题。View 从 canonical Work 和已有 Verification/Acceptance
状态投影，不创建第二套 Work 生命周期。最少返回：

```text
workId, projectId, workspaceId
objective, why, completionExpectation, lifecycle, revision
acceptedResult? = {
  acceptanceId, verificationId, targetWorkRevision, verdict: Pass,
  actor, acceptedAt
}
```

`Open`、`Completed` 和 `Cancelled` 都能通过同一 Work 链接读取。`WorkPage` 从该
View 获取目标和生命周期，继续使用 Verification View 展示证据明细。Completed 在
中文界面显示“已完成”，并保留目标、PASS 证据和验收信息。

对 `Completed` Work，`acceptedResult` **必须**来自同一 Work revision 的持久化
Acceptance，且其 `verificationId` 指向同一 Work/revision 的已结论 PASS
Verification。不存在或不一致时返回类型化投影完整性错误，不能显示一个伪造的
“已完成”或任意选中的验证。`Open`/`Cancelled` 没有已验收结果时不合成该字段。
Acceptance 已记录但机械 `CompleteWork` 尚未提交的短暂窗口中，可以同时出现
`lifecycle: Open` 与真实的 `acceptedResult`；页面必须显示“已验收、待完成”，
不得把 Acceptance 当作 Completed。若后续取消，Cancelled 生命周期仍以
canonical Work 为准，验收记录作为历史证据保留。

现有 `verification({workId})` 对所有 Work 优先选择 Open Verification，可能在
已验收 Work 上选中一条旧 Open 记录。此稿同时修正其选取规则：只要当前 Work
revision 有 Acceptance，就优先且只能展示其 `verificationId` 的 PASS 记录与
相应证据；没有 Acceptance 时沿用现有选择规则。对 Completed，这一绑定是强制
完整性条件。这样 WorkPage 的“验证与验收”区与 WorkDetail 的结果保持同一身份，
不需要从 Session 文本推测。

`current-work` 仍只表示 Workspace 当前正在承担的 Work；`workspace-detail` 的干预
审计列表仍只展示其原有事件类型。这样 Work 的终态读取有明确归属。

## 验收

使 `tests/functional/pending/completed-work-visibility.spec.ts` 通过：浏览器进入 Work
页面，记录 Acceptance 后再打开相同链接，仍看到原目标、“已完成”状态和验收结果。
同时验证按 ID 读取陌生/外项目/错工作区 Work 的拒绝、取消态、重启后读取、旧链接
与同一版本 Acceptance/Verification 的绑定；构造旧 Open Verification 与已接受
PASS 并存的反例，确保页面不误选前者。测试不得读取内部数据库充当成功判定。

若接受，仅在拥有相关语义的 `docs/design/**` 文档落字；用户此前的代写授权只在
人工治理明确接受后生效。
