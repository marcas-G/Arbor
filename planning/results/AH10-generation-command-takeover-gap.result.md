# AH10 跨租约代 Command 接管 — 未闭合缺陷证据

日期：2026-10-05

状态：**PARTIAL / 两类控制动作的定向反例和一个真实双 daemon 跨代资格已通过；其他控制动作及 crash-side qualification 仍未完成。**

冻结合同：`docs/design/implementation/P1/07-agent-loop-step-command-identity.md`
§1–§3 和 `docs/design/implementation/P9/07-agent-loop-step-recovery.md` AH10。
同一 LogicalAction 跨 owner generation 时，旧代的
`TerminalRejected(FencingRejected)` 只终止旧 CommandId；新代必须先查旧回执，
只有没有已提交效果且动作仍 Pending、ControlBasis 新鲜、无未决外部效果时，
才可用新一代 CommandId 提交。

两个反例现已落在正式核心测试
`apps/single-workspace/test/ah10-generation-command-takeover.test.ts`。
执行命令：

```text
pnpm exec vitest run apps/single-workspace/test/ah10-generation-command-takeover.test.ts
```

最初结果 **2 failed / 0 passed**，失败均命中合同：

1. gen0 的 `AssignWork` 留下 `FencingRejected` 回执后，gen1 的同一 pinned
   action 复用了同一个 CommandId，网关按 receipt-first 返回旧拒绝，无法提交。
2. gen0 命令已经 `Committed`、但动作 disposition 尚未持久化时，若只改为
   generation-scoped CommandId，gen1 会再次提交，造成第二次 canonical effect。
   测试要求先收敛已提交回执，不得发第二个 gateway 请求。

原实现 `control-actions.ts` 用 `providerTurnId:outputPosition` 派生命令 ID，
没有 generation；`gateway.ts` 先查相同 ID 回执再查 fence。仅更换跨代
CommandId 会使第一例转绿、第二例转红，故未采纳半修复。当前 `AssignWork`
在新代发命令前读取旧代持久回执：旧代已 Committed 且结果匹配时直接收敛；
旧代 FencingRejected 时才使用新代 ID。gen0 保留原有 ID 兼容既有回执。

定向测试 2/2、`pnpm typecheck`、相关控制动作测试 19 passed + 2 skipped
均 PASS。AH10 的退出仍需要：其他 canonical 控制动作的跨代 receipt-first
收敛、两侧真实进程 kill/restart、旧代写拒绝、新代最多一次 canonical effect
与 Provider 不重跑的证据。不得把这份单 handler 测试称为 AH10 通过。

## 2026-10-07 补充：第二个 canonical handler

为验证接管不是 AssignWork 特例，AH10 专属测试新增 `ProduceDeliverable`
覆盖：gen0 `FencingRejected` 后 gen1 使用不同 CommandId；gen0 已有匹配的
Committed receipt 时 gen1 在再次执行前完成收敛；gen0 的普通 domain rejection
不允许作为接管资格。实现只扩展到该 handler：新代按 generation 派生
CommandId，通过事务查询旧代 receipt，并校验 receipt 的 CommandId、ProjectId
及 Committed 结果中的 DeliverableId、来源 Work/revision、类型和 artifact roles；
FencingRejected 才继续到新代命令。Receipt 查询与事务能力是 handler 的必需
依赖；生产 composition 提供真实端口，原有仅测其他控制动作的测试提供明确空查询。

额外的既有直接 handler 调用点
`apps/single-workspace/test/mac-p3-dependency-delivery.test.ts` 显式提供事务与空回执查询，
确保原有 `System` 控制路径仍在正确事务能力下运行。

定向证据：

```text
pnpm exec vitest run apps/single-workspace/test/ah10-generation-command-takeover.test.ts apps/single-workspace/test/verification-control-actions.test.ts apps/single-workspace/test/mac-p3-dependency-delivery.test.ts
3 test files passed; 16 tests passed
pnpm exec tsc -b apps/single-workspace/tsconfig.json --pretty false
passed
```

在这次单 handler 补充完成时，整体仍为 **PARTIAL**：当时尚未取得真实 daemon
跨代证据，且单 handler 测试本身不能证明旧 owner 写拒绝或 Provider 不重跑。
后续进程证据见下节。

## 2026-10-07 补充：真实双 daemon generation takeover

新增独立进程资格
`tests/functional/process/agent-loop-ah10-generation-takeover.functional.test.ts`。
它启动两个独立 production daemon，共用同一临时 SQLite 数据库和同一个
Provider 服务，HTTP 端口不同。测试只读检查 lease/command/deliverable/action
状态，不直接 SQL 写入 receipt 或 lease。

资格顺序由 probe 事件和只读 lease expiry 观测控制，保持生产 30 秒 TTL：
generation 0 在持久 ActionIntent 后暂停，并在首次 renew 前暂停续租；测试等
lease 实际过期后启动第二 daemon。generation 1 获得 lease 且停在同一个 pinned
ActionIntent 后，释放旧 owner，使真实 CommandGateway 写入 TerminalRejected
FencingRejected receipt；随后释放新 owner。最终断言确认：两个 generation 使用
不同 CommandId；旧 owner 的 canonical Deliverable effect 被拒绝；新 owner 读旧
receipt 后只提交一个 Deliverable；同一 ProviderTurn/callRef 的 Provider 请求
计数为 1。

测试专用续租 probe 仅由 `ah10-process-child.mjs` 显式装配；普通 production
entrypoint 不提供该 probe。第二 daemon 由 production fixture API 启动在独立
HTTP 端口，并由 fixture.stop 清理；gate 文件位于该 fixture 的临时目录。

定向证据：

```text
pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-loop-ah10-generation-takeover.functional.test.ts
1 test passed; duration 36.04s
pnpm exec tsc -p tsconfig.test.json --noEmit --pretty false
passed
```

主 Agent 又从当前工作树复跑上述真实进程用例两次（均 1/1 PASS），并增强了
Provider 总请求数、Work 总数及旧成功回执的完整结果绑定断言；相关 5 个
定向测试文件合计 19/19 PASS，`pnpm typecheck` PASS。

同一工作树的一次完整 `pnpm check` PASS：架构 155、核心 1687 + 3 skipped、
Web 216；构建、lint、类型检查均通过。该批次不包含隔离的治理红测。

提交 `4720f65` 上完整 `pnpm test:functional` PASS：公开进程 42/42、
浏览器 2/2，包含 F20 从该提交干净检出安装/构建/公开黑盒启动，以及本 AH10
双 daemon 接管测试。该结果不包括 pending 的 AH7/FT/AH14 治理红测，
也不把 AH10 的剩余控制动作和提交两侧杀进程矩阵推定为通过。

整体仍为 **PARTIAL**：目前真实进程资格覆盖 ProduceDeliverable 单一 canonical
控制动作，尚无其余 canonical handler 的进程级覆盖，也没有该边界两侧的
kill/restart 注入矩阵；不据此宣布 AH10 关闭。

## 2026-10-07 第二批：Dependency 与 Parent Result Acceptance

`apps/single-workspace/test/ah10-generation-command-takeover.test.ts`
新增 `DeclareDependency` 和 `AcceptResult` 的 gen0 FencingRejected→gen1
新 CommandId、旧 Committed receipt→零新命令、旧非 fencing 终态拒绝→不得
跨代重试，以及旧 Committed 缺准确 canonical Dependency/Acceptance 行时
失败关闭。两个 handler 保留 gen0 历史 ID 编码；新代读取旧回执并核对
CommandId/ProjectId、pinned 动作与实际持久行。已提交 Dependency 即使后来
被交付满足，恢复时的模型观察仍使用原命令结果 `Unsatisfied`，不把当前
状态伪装成原结果。

首轮定向红测有 5 个合同断言失败；修复与测试夹具校正后，主 Agent 复跑
`ah10-generation-command-takeover`、`mac-p2-parent-accept-result`、
`mac-p3-dependency-delivery` 三个文件共 15/15 PASS，`pnpm typecheck` PASS。

**AH10 仍为 PARTIAL**：这两类新增的是 handler 级证据，不是双 daemon
进程资格；其余 canonical 控制动作、跨代提交前/后 kill/restart、旧成功
回执和已演化 canonical 状态的更多组合仍需逐项证明。

## 2026-10-07 第三批：SendMessage

`SendMessage` 新增同一 pinned 调用的跨代 FencingRejected→新 CommandId、
旧 Committed→从持久 Message 事实收敛且不重发、旧非 fencing 拒绝不重发、
缺 Message 行失败关闭，以及 Reply 在原 Query correlation 已关闭后仍可
按精确 Query/Reply 事实收敛。gen0 CommandId、messageId、Query correlationId
保留历史稳定编码。旧成功收敛时核对项目、sender/recipient、消息种类、
content-addressed bodyRef、correlation、urgency 和已有 canonical Message。

该批三个合同红测最初 3/3 失败；修复后主 Agent 独立复跑 AH10 与 I0
SendMessage 两个定向文件 20/20 PASS，`pnpm typecheck` PASS；F18 与
F19 两种依赖交付公开进程场景 3/3 PASS。仍有 `SelectCurrentWork`、
`Deliver`、`RecordVerificationEvidence`、`ConcludeVerification` 使用非
generation-scoped CommandId；正在先审查可复用的内部接管边界，避免
继续逐 handler 复制恢复逻辑。AH10 整体保持 PARTIAL。

## 2026-10-07 共用查询边界

五类 Gateway-backed handler 的“按旧 generation 查 receipt、核对
CommandId/ProjectId、跳过 FencingRejected”已收敛为
`findPriorCommandReceipt`。返回值只区分 None/Committed/其他终态拒绝；
旧 Committed 的 canonical fact 校验和各 handler 原有错误/Observation
代数仍各自负责。没有新增 DDL 或持久字段，gen0 CommandId 保持历史编码；
现有 pinned action 的 `attemptOrdinal` 仍隐含为 0，未擅自发明可写 ordinal。

主 Agent 独立复跑 5 个控制测试文件 32/32 PASS、`pnpm typecheck` PASS；
S1–S4 与 F18/F19 相关公开进程 7/7 PASS。随后完整 `pnpm check`
PASS：架构 155、核心 1701 + 3 skipped、Web 216。完整功能批次尚未对
helper 重排后的 HEAD 重跑；计划以 AH10 双 daemon 和 F20 干净检出
定向复测，并保留这个验证边界。AH10 不关闭。

提交 `32ae550` 后定向复测：AH10 真双 daemon 30s TTL 接管 1/1 PASS；
F20 从该提交干净检出、冻结安装、构建与公开黑盒 1/1 PASS。未在
`32ae550` 重跑完整 42 项进程 + 2 项浏览器批次；最近完整功能批次
仍是更早的 `4720f65`，不能混称为本提交的全量证据。

`Deliver` 另有隔离 SQLite 红测：lease 已到新 generation 时旧 owner
仍能通过 `submitDeliver` 直接写 Message、MessageSent 与 Inbox；同
MessageId 重入虽因唯一键回滚、没有重复事实，却不能收敛为成功交付。
该动作不走 CommandGateway，拟议 AH10-DG-01 先裁决 P1/P7 的 fencing
与 receipt 所有权；见
`planning/results/AH10-deliver-generation-fence.review.md`。

## 2026-10-07 第四批：SelectCurrentWork

`SelectCurrentWork` 的旧 gen0 CommandId 继续从 DecisionId 派生；gen1
只在旧 FencingRejected 时派生新 ID。旧 Committed 回执在 DecisionRequest
仍 Pending 时，先核对候选、revision、Workspace 当前选择与回执结果，
再补交 `DecisionRequest.submit`；若请求已 Submitted 且选择相同，直接
收敛，不重复提交。持久事实冲突失败关闭，旧非 fencing 拒绝不重发。

AH10 专属测试先出现四项合同红灯，修复后主 Agent 复跑 AH10/I0/MAC-P2/
MAC-P3 四文件 26/26 PASS，`pnpm typecheck` PASS。当前尚无
SelectCurrentWork 的公开进程跨代资格；不能把这些 handler 测试外推为
AH10 完整关闭。

同一工作树随后 `pnpm check` PASS：架构 155、核心 1705 + 3 skipped、
Web 216；pending Deliver 红测仍按预期独立失败。完整
`pnpm test:functional` 尚未在此增量提交运行。
提交 `02e42ac` 上 F20 干净检出安装、构建与公开黑盒 1/1 PASS。
