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
同提交完整 `pnpm test:functional` 公开进程 42/42、浏览器 2/2 PASS。

验证控制动作另有两条独立隔离红测：`record_verification_evidence`
同 CommandId 重试时 `recordedAt` 变化导致指纹冲突；已提交的
`conclude_verification` 无法从 Verification 行读回 P8 冻结的逐
criterion 快照。两者的时间来源与历史行处置见
`planning/results/verification-evidence-replay-and-snapshot-governance.review.md`；
不能仅因绿色功能批次通过就推定 AH10/P8 闭合。

## 2026-10-07 进程杀停增量：旧拒绝提交后与新命令提交后

`tests/functional/process/agent-loop-ah10-generation-takeover.functional.test.ts`
现有双 daemon 用例在旧 gen0 `FencingRejected` receipt 真实落盘后立即
杀旧进程，再放行 gen1。同一 LogicalActionId/ProviderTurn/callRef 保持，
最终一条旧拒绝、一条新提交、一个 Deliverable、Provider 请求一次。

新增第二案通过只在测试子进程装配的
`AH10AfterControlHandlerReturnBeforeObservationCommit` probe，在
ProduceDeliverable canonical Command/Deliverable 已提交，而 AgentLoop
Action 仍 Pending、Observation 为零时杀进程。待真实 30 秒 lease
到期，gen1 同库接管并收敛旧 Committed receipt；CommandId 不变，
Action 最终 Applied、Observation 和 Deliverable 各一，Provider 未重跑。
主 Agent 独立复跑两案 2/2 PASS；子 Agent 的两案定向亦 PASS。
`pnpm architecture` 155/155、`pnpm lint` 与 `pnpm typecheck` PASS；
本次增量尚未运行完整 `pnpm check` 或全部功能批次。
提交 `9d4ce1e` 上 F20 干净检出安装、构建及公开黑盒 1/1 PASS。

仍缺旧 FencingRejected receipt **事务提交前**精确杀停，以及其他控制
动作的两侧进程资格。该前态需另审 Gateway 事务内 test-only 注入边界；
本批没有改 Gateway 核心事务，也不据此关闭 AH10。

## 2026-10-07 进程杀停增量：旧围栏回执提交前

在同一 AH10 双 daemon 测试中新增提交前分支。仅由测试子进程显式装配
`CommandGatewayQualificationProbe`，在旧代 `FencingRejected` 行与 attempt
写入**当前事务内**、`TransactionPort.transact` 尚未提交时暂停。独立只读
SQLite 连接看不到该回执；杀旧进程后事务回滚，新代从同一 DB 接管并
唯一提交一个 Deliverable。不会通过直接 SQL 写入或短 TTL 伪造状态。

该分支缺 probe 时先按预期红在精确边界；接入后主 Agent 单独复跑 1/1，
再与提交后杀旧进程、已提交新命令但 Action Pending 时杀进程两案合跑
3/3 PASS。三案均保持同一 ProviderTurn/LogicalAction，Provider 只请求
一次；提交前分支最终**没有**旧拒绝回执，只有新代 Committed 回执。

`pnpm typecheck`、`pnpm lint`、Gateway/worker 26 项测试和架构 155 项
PASS。仍未在本增量运行完整 `pnpm check` / `pnpm test:functional`。
其他控制动作的对应进程矩阵和已公开的治理红测仍独立开放，AH10 不关闭。
提交 `f98fddb` 上 F20 干净检出安装、构建及公开黑盒 1/1 PASS。
后续 `f6ae77f` 上完整 `pnpm check` PASS：架构 155、核心 1705 + 3
skipped、Web 216；构建、lint 和类型检查均通过。本提交仍未重跑
完整 `pnpm test:functional`，不能把 AH10 3/3 与 F20 1/1 定向结果
扩展为全功能批次。

## 2026-10-07 进程资格增量：DeclareDependency

新增 `DeclareDependency` 真实双 daemon 跨代接管用例：gen0 先在
`AH7AfterActionIntentCommit` 暂停，并在续租边界保持暂停；测试只读观察
真实 30 秒 lease 到期后启动同库 gen1。gen1 停在同一 pinned ActionIntent，
再放行旧 owner，使旧代经 CommandGateway 实际写入并提交
`TerminalRejected(FencingRejected)` receipt。确认 receipt 落盘后立即杀旧
daemon，再放行 gen1。最终验证 gen0/gen1 CommandId 不同，LogicalActionId、
ProviderTurnId、callRef 相同；只有一条 Committed DeclareDependency，唯一
Dependency 行绑定同一 consumer Work、AnyProducer 和精确期望 Deliverable，
revision 0 / Unsatisfied；AgentLoop Action Applied、Observation 唯一，Provider
请求一次。测试不直接 SQL 写 lease/receipt，不修改共享 fixture。

先新增测试后以真实双进程定向运行：DeclareDependency 用例 1/1 PASS，
37.62s（同文件其余 3 案按 `-t` 跳过）。`pnpm exec tsc -p
tsconfig.test.json --noEmit --pretty false` 与专属测试 Biome 检查 PASS。
主 Agent 在同一工作树独立复跑该定向用例 1/1 PASS（36.81s），
并复核唯一 Dependency、Observation、旧拒绝/新提交 CommandId 和单次 Provider
请求断言。
本增量只补 handler 已有接管实现的进程资格，不闭合其他动作的 AH10 矩阵，
AH10 整体仍为 PARTIAL。随后完整 `pnpm check` PASS：lint、类型检查、
架构 155、核心 1705 + 3 skipped、Web 216；未运行完整
`pnpm test:functional`，不得把定向进程 1/1 扩展为全部功能批次。

## 2026-10-07 进程资格增量：DeclareDependency receipt 提交两侧

将 DeclareDependency 进程用例参数化覆盖 receipt 事务提交前/后杀停，复用
现有测试子进程 `AH10BeforeFencedReceiptCommit` Gateway probe，不改 Gateway
或共享 fixture。提交前分支在 fence rejection 已写入当前未提交事务时停住；
独立只读 SQLite 连接确认 FencingRejected receipt 不可见，杀 gen0 后再次
确认 receipt 行不存在（事务回滚），gen1 仍可唯一提交 Dependency。提交后
分支先观察到真实旧 receipt，再杀 gen0，由 gen1 receipt-first 接管。两案均
保持 30 秒生产 TTL、不直接写 lease/receipt；最终依赖行唯一、Unsatisfied /
revision 0、Action Applied、Observation 唯一且 Provider 请求一次。提交后
分支有一条旧 FencingRejected 和一条新 Committed Command；提交前分支只有
新代 Committed Command。

验证：

```text
pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-loop-ah10-generation-takeover.functional.test.ts -t "takes over DeclareDependency"
2 passed; 3 skipped; 73.06s
pnpm exec tsc -p tsconfig.test.json --noEmit --pretty false
passed
pnpm --filter @arbor/single-workspace build
passed
pnpm exec biome check tests/functional/process/agent-loop-ah10-generation-takeover.functional.test.ts
passed
```

该进程证据仅覆盖 DeclareDependency，不扩展为 AH10 整体闭合；AH10 仍为
PARTIAL。主 Agent 在同一工作树独立复跑两侧 2/2 PASS（72.87s）。本次
参数化增量未重跑完整 `pnpm check` / `pnpm test:functional`；上一提交
`29b9ce2` 的完整 `pnpm check` 不能冒称为本增量的全量结果。

随后在已提交的 `afe8a20` 上运行完整 `pnpm test:functional`，构建通过，
真实进程/公开 API 测试 21 文件、48/48 PASS，Playwright 浏览器 2/2 PASS；
其中 AH10 本文件五个场景全部通过，F20 从该提交干净检出、安装、构建和
公开黑盒启动通过。该结果证明本增量没有破坏现有功能批次，不解决
AH10 尚未覆盖的其他控制动作、已演化状态组合或开放治理缺口。

## 2026-10-07 AcceptResult 进程资格增量：list_workspaces 后接管

初始红测假设 Parent Work Context 直接含 `rref_...`，但 WorkEpisode 只收到
`Child result ready for Work … revision …` 信号。按 F18 正式流程，Provider
先调用 `list_workspaces`，再从真实工具结果取得 opaque `resultRef` 并调用
`accept_result`；没有从 SQL 计算或伪造引用。测试专属 AH10 子进程在
ActionIntent 持久后只读查询该 LogicalActionId 的 `action_kind`，仅对显式
`ARBOR_AH10_GATE_ACTION_KIND=accept_result` 等待 gate，避免误停在前一步
列表调用。没有改 Agent Runtime、Gateway、生产代码或共享 fixture。

同库公开进程先形成 Child Verification PASS、Work Open，再创建 Parent Work。
旧 gen0 在 AcceptResult intent 与续租暂停期间等待真实 lease 到期；gen1
获得 lease、停在同一 AcceptResult intent。放行旧命令，确认旧
`FencingRejected` receipt 落盘后杀旧 daemon；gen1 receipt-first 用新
CommandId 唯一提交 AcceptWorkOutcome。唯一 Acceptance 行的 Work/revision/
Verification 身份与回执精确一致，completion consumer 将 Child Work 完成；
两代 ProviderTurn/LogicalActionId/callRef 相同，该 ProviderTurn 仅一次成功
Attempt，AcceptResult 决策与绑定其 ledger source ref 的 Observation 各一次。

测试构造期间的红灯分别来自 Child criterionId 与现有脚本不匹配、先于
ActionResult gate 放行就断言 Work 完成，以及将合法的列表 Observation
误计为 AcceptResult 的重复 Observation；均按真实合同修正。

```text
AcceptResult 定向：1/1 PASS（42.43s）；主 Agent 独立复跑 1/1 PASS（42.38s）
AH10 专属真实进程文件联跑：6/6 PASS（230.81s）
```

该证据只补旧拒绝回执提交后 AcceptResult 的跨代接管，不覆盖其提交前
边界、其他控制动作或更多已演化状态组合，AH10 仍为 PARTIAL。随后完整
`pnpm check` PASS：架构 155、核心 1705 + 3 skipped、Web 216；本增量
随后在已提交 `2320d24` 上完整 `pnpm test:functional` PASS：真实进程/
公开 API 21 文件、49/49，Playwright 浏览器 2/2，含 AH10 专属六场景
与 F20 干净检出。绿色功能批次不覆盖 AH10 其余控制动作/治理缺口。

## 2026-10-07 AcceptResult 旧拒绝回执提交前崩溃资格

AcceptResult 真实双 daemon 场景现在参数化覆盖旧 gen0
`FencingRejected` receipt 提交前与提交后两种中断点。提交前分支复用
AH10 子进程现有的 Gateway 事务内 test-only probe：gen1 已持有 generation 1
lease 并停在同一 AcceptResult ActionIntent 后，放行 gen0；Gateway probe 在
旧拒绝 receipt 尚未提交时暂停。独立只读 SQLite 连接确认该 receipt 不可见，
杀掉旧 daemon 后再次读取仍不可见，证明未提交事务随进程退出回滚。

gen1 随后 receipt-first 使用新 CommandId，唯一提交与 Child PASS 结果绑定的
Acceptance；Child Work 唯一转为 Completed。两分支均断言同一 ProviderTurn、
LogicalActionId 和 callRef，只有一条成功 ProviderAttempt，唯一 Acceptance，
AcceptResult 调用一次，且该动作 Observation 只有一条。没有修改生产代码、
共享 fixture 或 Gateway 实现。

```text
pnpm build                                      PASS
pnpm --filter @arbor/web build                 PASS
pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-loop-ah10-generation-takeover.functional.test.ts -t AcceptResult
  2 passed, 5 skipped (92.28s)
pnpm exec biome check tests/functional/process/agent-loop-ah10-generation-takeover.functional.test.ts
  PASS
pnpm typecheck
  BLOCKED by concurrent SendMessage test edits: TS18048 oldAction/oldLeasePause/newLease/newAction
  possibly undefined in tests/functional/process/agent-loop-ah10-send-message-takeover.functional.test.ts
```

该增量补齐 AcceptResult 的旧拒绝回执提交前回滚边界；AH10 仍因其他控制动作
和治理缺口保持 PARTIAL。

### 集成复核（2026-10-07）

两个相关功能文件联跑最终 8/8 PASS（AH10 主文件 7 场景，SendMessage Query
1 场景；301.41s）。完整 `pnpm check` PASS：Biome 943 files，TypeScript build
与 test typecheck PASS，architecture 30 files/155 tests，core 315 files/1708
passed + 3 skipped，Web typecheck/build PASS，Web 31 files/216 tests PASS。
门禁曾改写 `planning/results/P12.restore-drill.json` 的演练 timestamp/hash/RTO；
已按门禁前保存的原字段恢复，因此该既有结果文件不属于本批变更。AH10 仍 PARTIAL。

`d5dca49` 推送至 `origin/codex/functional-tests` 后，F20 干净检出定向
1/1 PASS（44.37s）。随后完整 `pnpm test:functional` 在同一提交 PASS：
功能 Vitest 22 files/51 tests（1427.87s），Playwright 2/2（22.9s）。该批次
包含新 AcceptResult 提交前/后和 SendMessage Query 场景，但不能关闭 AH10 其他
控制动作或待治理缺口。

## 2026-10-08：DeclareDependency 与 AcceptResult Committed receipt / Pending Action 恢复

主 AH10 process 文件新增两项真实 daemon 恢复资格，旧的 FencingRejected
提交前/后用例未改。两项都在 `AH10AfterControlHandlerReturnBeforeObservationCommit`
测试 gate 上硬杀 gen0：canonical Command receipt 与领域效果/Event 已提交，
但目标 Agent Action 仍 Pending 且其 Observation 未落盘。杀进程后等待持久
gen0 lease 的真实 30 秒 TTL 到期，再启动 gen1 恢复相同 Execution。

DeclareDependency 使用公开 Project/AssignWork setup 和 Provider 控制调用。
gate 前只读 SQLite 证明唯一 Committed DeclareDependency receipt、唯一
DependencyDeclared event 和同一 Dependency 已持久，同时目标 Action 为 Pending、
Observation 数为 0。gen1 保留 ProviderTurnId/LogicalActionId/callRef，读取并
重用原 Command receipt（CommandId 不变），最终唯一 Dependency/Event，Action
Applied 且对应 Observation 恰一条；原 ProviderTurn 只有一个成功 Attempt。

AcceptResult 使用公开 child Workspace/Work setup，等待独立 Verification PASS，
再公开创建 Parent Work。Parent 先调用 `list_workspaces`，从真实工具返回的
直接子 Workspace ready 结果取得 opaque `resultRef`，随后再调用 AcceptResult。
共享 test helper 的 control-return gate 会先见到该前置 list action，因此测试
只在该 ListWorkspaces Observation 已持久后，验证精确的 fixture-local 绝对
release-marker 路径和文件存在，再移除该临时 marker；随后 AcceptResult 的
handler-return 才进入待杀 gate。没有数据库写入或合成 `resultRef`。

AcceptResult gate 前只读核对唯一原 Committed receipt、Acceptance 行及唯一
WorkOutcomeAccepted event；目标 Action 仍 Pending 且其 observation ref 为 null，
Child Work 仍 Open。gen0 lease 尚有效时杀旧 daemon，再等 TTL 到期。gen1 恢复
同一 ProviderTurn/LogicalActionId/callRef 并复用相同 CommandId；最终 Acceptance
和 WorkOutcomeAccepted 仍唯一，AcceptResult Action Applied、其 Observation 恰一条，
workflow completion 将 child Work 唯一推进为 Completed，原 ProviderTurn 只有一个
成功 Attempt，Provider 未再次发出 AcceptResult。

```text
pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-loop-ah10-generation-takeover.functional.test.ts -t "recovers a committed DeclareDependency"
1 passed (35.73s)

pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-loop-ah10-generation-takeover.functional.test.ts -t "recovers a committed AcceptResult"
1 passed (40.46s)

pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-loop-ah10-generation-takeover.functional.test.ts
1 file / 9 tests passed (338.45s)

pnpm exec tsc -p tsconfig.test.json --noEmit --pretty false
passed

pnpm exec biome check tests/functional/process/agent-loop-ah10-generation-takeover.functional.test.ts
passed
```

本主文件增量未改共享 process helper 或 `docs/design/**`。同批还包括
`SelectCurrentWork` 已提交回执恢复的窄 pinned-replay 实现与守卫负测，详见
`planning/results/AH10-select-current-work-takeover.result.md`。以下是本次独立
集成复核结果；这不是完整 `pnpm test:functional`，也不关闭 AH10 其余控制动作
与状态边界。

```text
pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-loop-ah10-generation-takeover.functional.test.ts
1 file / 9 tests PASS (336.69s)

pnpm check
PASS: Biome 947 files; architecture 155; core 316 files / 1711 passed + 3 skipped;
Web 31 files / 216 passed; TypeScript, Web typecheck and build passed.
```
