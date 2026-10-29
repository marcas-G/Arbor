# F23 AH10 Generation / SendMessage Public Seed Result

日期：2026-10-10
隔离树：`C:\Users\ThinkPad\.codex\worktrees\f23-recovery-command-id\Arbor`
测试基线：`1a1324ec6ea0536a116924e236382a550c4979f4`

## 范围与 seed 路径

仅修改以下两个功能测试文件及测试专用 `public-client.ts` helper；没有修改生产
代码、`docs/design/**`、共享 `production-fixture.ts` 或其他测试。

- `agent-loop-ah10-generation-takeover.functional.test.ts`
- `agent-loop-ah10-send-message-takeover.functional.test.ts`

Root 当前 Work 的正向 seed 现在经 Root `SubmitHumanMessage` → `assign_work` →
精确 CAPA Governance Inbox 项 → `ResolveControlApproval(Approve)`。Root Work Episode
先进入显式 Manual wait；确认同一 WorkId/Open/no active execution 后，kill 普通
daemon、启动 AH10 probe daemon，再用公开 `SteerWork` 恢复同一 Work。Root admission
与 seed wait 的 Provider 回合不计为被测 Action Provider call，且不落入探针窗口。

跨 Workspace target 使用 Root `propose_workspace` → exact FormationProposal
Inbox revision → `RecordDecision(Approve)`。child 在需要有真实 Work 的场景中携带
经审批的 `initialWork`，不再使用外部 `CreateChildWorkspace`/`AssignWork`。SendMessage
Reply 场景仍先创建 child、执行并消费其 Query，再建立 Root Reply Work；Reply 的
generation takeover 与 Gateway commit 前/后 crash 顺序不变。DecisionRequest 仍在
单一 Provider 决策中依次产生 SendMessage 与 Wait，并保留父 Inbox/workflow 断言。

## 定向验证

所有既有场景均按目标用例定向运行，合计 16/16 PASS：

- Generation takeover：9/9（Deliverable fence before/after；pending Deliverable；
  pending DeclareDependency；DeclareDependency fence before/after；AcceptResult
  fence before/after；committed AcceptResult）。
- SendMessage takeover：7/7（Query before/after；Reply before/after/committed；
  DecisionRequest before/after）。
- 最初 generation takeover 外部 Root `/commands AssignWork` seed 的单案 RED 已
  重现 `403 UnsupportedOrigin:AssignWork`；修改后对应 before 分支通过。
- 三个变更测试/辅助文件的 Biome check：PASS。
- `pnpm exec tsc -p tsconfig.test.json --noEmit`：PASS。
- `git diff --check`：PASS；两目标测试文件不再含外部 `CreateChildWorkspace` 或
  外部 `AssignWork` setup。

所有被测旧/新 generation、same ProviderTurn/LogicalActionId/callRef、fencing
receipt、Work/Dependency/Message/Inbox/Correlation/Observation 唯一性与 Reply/
DecisionRequest 顺序断言均保留。观察记录按目标 execution 或 Action identity
限定，避免 Root CAPA/seed Work observations 混入被测 Action 的计数。

未运行完整 `pnpm test:functional`、完整 `pnpm check` 或其他功能文件。本结果只
覆盖以上两个文件及所列定向用例，不声明 AH10 整体关闭。
