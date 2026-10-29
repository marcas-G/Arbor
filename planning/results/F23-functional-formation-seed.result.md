# F23 Functional Formation Seed Result

日期：2026-10-10
隔离树：`C:\Users\ThinkPad\.codex\worktrees\f23-recovery-command-id\Arbor`
基线：`03fe99750fe88edb4b12c1f49e62fff62111c1fa`

## 范围

只迁移 `cross-work-wake.functional.test.ts` 与
`ah15-inbox-input-promotion-crash.functional.test.ts` 的 child Workspace/Work
setup，并在 `public-client.ts` 增加测试专用的公开形成辅助函数。未修改生产代码、
`docs/design/**`、权限策略或其他场景。两个场景均通过真实 daemon、HTTP/API 与
隔离 SQLite fixture 运行；未调用 internal Gateway。

Child 创建路径现在是 Root `SubmitHumanMessage` → Agent Runtime
`propose_workspace` → 公共 Governance Inbox 暴露精确 `FormationProposal` ID/修订 →
`RecordDecision(Approve)` → formation consumer。辅助函数批准前确认责任树仅有
Root，批准后从公开责任树取得新 child 的 `WorkspaceId` 与 initial Work。

F19 producer 的 initial Work 先进入 Manual wait；consumer 仍先通过 Root
`assign_work` 与精确 CAPA approval 建立，声明绑定到该 child `WorkspaceId` 的
Dependency 并等待。测试保留 producer 后续公开 `SteerWork`、精确 Deliverable
满足依赖、consumer 被唤醒并看到对应 Delivery 的断言。前置“恰两回合”只统计
含 `declare_dependency` 的 consumer Work provider turn，不把新增 Root 控制回合
误计为 consumer 执行回合。

AH15 在真实形成 child 与其 initial Work 后才等待 crash probe。保留
`AH15BeforeInboxPromotionCommit` / `AH15AfterInboxPromotionCommit` 两侧 kill/restart，
以及 Parent/Child 身份、MessageId/event、Inbox、InboxEpisode、Session Input、
ProviderTurn/Attempt 和重启后仅一次 Query admission/settlement 断言。child 的
ResourceBoundaryDraft 精确复用父 Root 当前 `fixture.workspaceDirectory` FileTree，
不扩大边界；child 与 parent 仍通过不同 WorkspaceId 区分。

## 验证证据

- 首次直接启动定向 Vitest 时，隔离检出未生成 `apps/web/dist`，三个用例都在
  daemon 根 URL readiness 等待中超时，未到达旧命令调用；该次不计作 RED。
- 按仓库 `test:functional:process` 的前置构建，只运行 `pnpm build` 与
  `pnpm --filter @arbor/web build`。随后两目标文件的原始 RED 均到达真实
  `/commands` 并因 `UnsupportedOrigin:CreateChildWorkspace` 返回 403：AH15 两边界
  与 F19 一案，共 3 failed。
- 修订后的 F19 定向运行：1/1 PASS。
- 修订后的 AH15 `BeforeInboxPromotionCommit` 定向运行：1/1 PASS（另一边界被
  Vitest `-t` 跳过）。
- 修订后的 AH15 `AfterInboxPromotionCommit` 定向运行：1/1 PASS（另一边界被
  Vitest `-t` 跳过）。
- `pnpm exec biome check` 三个变更测试文件：PASS。
- `pnpm exec tsc -p tsconfig.test.json --noEmit`：PASS。

未运行全量 `pnpm test:functional`、全量 `pnpm check` 或其他功能文件。此结果只
证明本次两个迁移场景及各自既有断言的定向资格；不声称 AH15/F19 整体阶段关闭。
