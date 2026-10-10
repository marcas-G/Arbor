# F23 AH10 Direct-child Public Seed Result

日期：2026-10-10
隔离树：`C:\Users\ThinkPad\.codex\worktrees\f23-recovery-command-id\Arbor`
测试基线：`2c0a92ba6dc5a0f17ed6bee45a83033857273f84`

## 范围与种子路径

只迁移以下两文件中的外部 Workspace/Work setup；新增一项测试专用
`proposeAndApproveChildWithoutWork` helper。未修改生产代码、权限策略、
`docs/design/**` 或共享 `production-fixture.ts`。

- `agent-loop-ah10-direct-child-assign-work-receipt-binding.functional.test.ts`
- `agent-loop-ah10-direct-child-assign-work-takeover.functional.test.ts`

目标 child 与 sibling 均经 Root `SubmitHumanMessage` → `propose_workspace` →
Governance Inbox 暴露的精确 FormationProposal ID/修订 →
`RecordDecision(Approve)` → formation consumer 创建。审批前验证目标不存在；
consumer 创建后从公开责任树/Workspace Detail 取得并核对真实 WorkspaceId 与边界。
它们没有 initial Work；现有 Parent Agent 的 `list_workspaces` opaque ref、
direct-child `assign_work`、Grant/Approval、目标身份绑定与 receipt-first takeover
矩阵仍是唯一创建被测 target Work 的路径。

普通 Root Parent Work 通过 Root `assign_work`，并按精确 CAPA Inbox 项执行
`ResolveControlApproval`。`non-root-parent` 分支通过 Root Formation 批准 Parent，
并由同一 FormationProposal 的 `initialWork` 创建 Parent WorkEpisode；Parent Agent
随后分别提议 target child 与 sibling，测试对每项读取 Parent Workspace Inbox 的
精确 proposal revision 并调用 `RecordDecision`。这避免预建被测 target Work，且保留
非 Root Parent WorkspaceId 归属。

为避免 `ARBOR_AH10_GATE_ACTION_KIND=assign_work` 探针拦截 Root Parent Work seed：先用
普通 daemon 完成公开 seed；等同一 Parent WorkId 处于 Open、无 active execution、
并在 Manual wait 后，kill/restart 到 instrumented AH10 daemon，再用公开
`SteerWork` 恢复该 Work。测试显式断言 WorkId、目标 revision（0/1 或 2）与恢复后
revision 增量。Root seed 的 assign_work 不在被测 crash 窗口内；旧/新 generation
仍针对 Parent Agent 的 direct-child action。

## 验证证据

- 原始 `approval-fencing-before` 与 takeover `before` 基线各曾实际到达
  `/commands`，并以 `UnsupportedOrigin:CreateChildWorkspace` 403 失败。
- 最终 `agent-loop-ah10-direct-child-assign-work-receipt-binding.functional.test.ts`
  全文件：12/12 PASS，单文件定向运行 644.67s。覆盖 committed、corrupt sibling、
  binding-before、approval committed/fencing-before、legacy P32 upgrade/unbound、
  retired、grant revoked、non-root parent、attention before/after。
- 最终 `agent-loop-ah10-direct-child-assign-work-takeover.functional.test.ts`
  `before` 与 `after` 分案定向：各 1/1 PASS。
- 三个变更测试/辅助文件的 Biome check：PASS。
- `pnpm exec tsc -p tsconfig.test.json --noEmit`：PASS。
- `git diff --check`：PASS；目标两测试文件中不再调用外部
  `CreateChildWorkspace` 或外部 `AssignWork`。

## 诊断边界与未声称事项

早期 non-root seed 实验曾让 RootConversation 用 `targetWorkspaceRef` 给已形成的
non-root child 创建 Parent Work。它返回
`action/canonical-rejected: Direct-child AssignWork is missing trusted target,
source-action, or authorization evidence`，随后出现
`ControlApprovalStore` unique-constraint daemon failure。该 cross-target Root
Conversation 路径已从最终 seed 移除；异常仅作诊断记录，未修改或声称修复该路径。
最终 non-root Parent Work 使用已接受的公开 Formation `initialWork` 路径。

没有运行完整 `pnpm test:functional`、完整 `pnpm check` 或其他功能文件；本结果只
证明上述两测试文件的迁移及保留的定向资格，不宣称 AH10 阶段关闭。
