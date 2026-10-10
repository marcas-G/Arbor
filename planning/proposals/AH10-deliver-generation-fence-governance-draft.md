# AH10 Deliver 跨 generation fence 与 replay — 固定治理提案

状态：**DRAFT / 等待人工治理接受**

建议接受标识：`ACCEPT_DELIVER_GENERATION_FENCE_AND_REPLAY`

实现授权：**未授予**

基线：已审候选 `6fcbc17e27b694f201792aedd6c2ec368508b542`

## 提案决定

采用**现有 SendMessage CommandGateway + P1 receipt-first takeover** 路线。`Deliver` 仍是 P7 定义的 `Message(kind=Deliver)` handover；不新增 Deliverable CommandType，也不引入 Runtime 专属 receipt ledger。生产实现应按 P7 `02` §8 所写，将 handover 作为已有 `SendMessage` command 执行，但当前 `deliverHandler` 绕过了 Gateway。治理落字只需把 P1 的 generation-scoped action 接管合同明确适用于 Deliver→SendMessage 路由，并明确其结果、既有 handover 的兼容恢复与资格边界。

选择此路线是因为它沿用 P1 已冻结的 `LogicalActionId`、generation-scoped `CommandId`、Command receipt、Gateway fence 和 effect/receipt 同事务边界；P7 已冻结 SendMessage(kind=Deliver)、MessageSent、Inbox admission 与 ChildDelivered wake 的共同提交语义。独立 Runtime ledger 会复制 Command receipt 和 takeover 规则。允许旧 generation 晚到写入则与 P2/DID 的 Worker 写入 fencing 保证冲突。

## 冻结依据与失败证据

- P1 `07` §1–§3：`LogicalActionId` 跨 owner generation 稳定；每代 CommandId 不同；先查旧 receipt；仅旧 `FencingRejected` 可在 action 仍 Pending、ControlBasis 新鲜且无未决 effect 时重试；旧 Committed 必须收敛，domain rejection 不因 generation 改变而重试。
- P2 `03` §1–§3 与 DID §6.3/§9.7：过期或被替代的 Worker 不得提交持久写入；authoritative fence 必须与 canonical 写入、Command resolution 和 Domain Event 在同一事务中。P9 `07` §1 又要求执行写入先取得 current lease。
- P7 `02` §1、§4–§8：Deliver 是 Message handover，不是新的 Deliverable command；成功边界是 `SendMessage(kind=Deliver)` 的 Message、MessageSent、Inbox admission 与 ChildDelivered wake 同事务；directive 使用预分配 MessageId、CommandId 和既有 SendMessageAuthority。
- P9 `07` §2：`ActionsInProgress` 恢复不得重跑 Provider；按 LogicalAction 收敛或执行下一项 Pending action。P17 的 ResponseJob/Attempt 只管理 HumanMessage 回复，不拥有 Workspace 间 Deliver 的 Message、Inbox 或 wake。

当前实现证据见 `planning/results/AH10-deliver-generation-fence.review.md`。隔离测试 `tests/functional/pending/ah10-deliver-stale-generation-replay.functional.test.ts` 建立真实 SQLite generation 0 → generation 1 lease，再以旧 gen0 `ExecutionOrigin` 调真实 handler。第一项预期失败：旧调用成功新增 Message、MessageSent、Inbox 各一条。第二项重入以 Message 主键冲突失败；事务回滚后每项仍各一条。该唯一键失败不是 replay 成功，也没有证明 WorkflowSignalConsumer 实际调度 wake。

## 被提议的精确合同

### 身份与事实所有权

1. Deliver 的 stable `LogicalActionId` 按 P1 既有公式绑定同一 Execution、ProviderTurn、callRef、route/action kind；generation 变化不改变它。
2. `MessageId` 是一次 handover 的稳定身份，跨 generation 不变；沿用当前 pinned occurrence 派生值（ProviderTurnId + outputPosition），不得从 generation 派生。不同 handover 不得复用它。
3. `CommandId` 是该 SendMessage Application 请求的 generation-scoped 身份。gen0 保留当前 occurrence 派生的历史 ID；gen1+ 使用 P1 generation-scoped 确定性算法。同一 generation 的普通操作重试复用同一 CommandId 和不可变 fingerprint。
4. Command receipt 属于 CommandGateway / CommandStore，不属于 Message 或 Action ledger。它以 SendMessage schema/strict decoder 回放，并返回原 Committed `messageId` 与结果；不为 Deliver 新增 receipt 表、CommandType 或 receipt schema。
5. Message、MessageSent、Inbox admission、ChildDelivered wake source 与 Committed Command receipt 必须在一个 Gateway 事务中提交。任何 FencingRejected 或事务回滚分支不得留下其中任一项。
6. AgentLoop Action/Step 仍拥有唯一 Action disposition 与 Observation。Receipt Committed 后、Observation 提交前崩溃时，gen1 重用原 receipt、生成同一个 Deliver Observation、将同一 LogicalAction 标为 Applied 并追加一次 Observation；Command receipt 本身不等于 Observation。

### 旧代拒绝与新代接管

1. 每次 Gateway mutation 都在 effect/receipt/Event 同一事务内核对 lease holder、incarnation、generation、未过期和 Execution 未 settled。外置 lease 预检只能快速失败，不能替代事务内 fence。
2. gen0 lease 已被 gen1 替代后，gen0 的 SendMessage command 必须提交 `TerminalRejected(FencingRejected)`，且无 Message、MessageSent、Inbox 或 wake effect；旧 Worker 停止该 Execution-origin write。
3. gen1 在提交新 Command 前按 P1 查所有较早 generation 的精确 SendMessage receipt：
   - 旧 Committed：严格校验 receipt envelope/result，重用其 MessageId/结果，不发新 Command、不新增 handover。
   - 旧 `TerminalRejected(FencingRejected)`：只有 LogicalAction 仍 Pending、当前 freshness/authority 仍通过、且无 unresolved effect，才以 gen1 CommandId 和相同稳定 MessageId 重试。
   - 旧 domain-semantic rejection 或 `ExecutionStopping`：遵循既有 Command/AgentAction error algebra，不因 takeover 重试。
   - 旧 operational failure：按既有不可变请求规则使用原 CommandId 重试；不得换 CommandId 规避 fingerprint。
   - receipt 缺失：仅在符合 P1 eligibility 时执行 gen1 command。
4. 新旧 CommandId 最多一个 Committed；在 Committed 前任一 kill 均回滚该事务，在 Committed 后 takeover 必须 receipt-first。Message/Event/Inbox/wake source 对同一 MessageId 最多各一条。

### 既存直接写入的兼容边界

当前旧实现可以在 Action 仍 Pending 时已直接提交 handover，却没有 Command receipt。该事实不能伪造为 Committed receipt。对这种既存状态，提案要求 P9 恢复先做只读 exact-proof：稳定 MessageId 对应唯一 Message 与唯一 MessageSent，且 sender、direct-parent recipient、Deliverable、bounded summary/body ref 与 pinned Action 输入一致；MessageSent 与 Message 是 P7 同事务事实，因此 Inbox 曾在提交时 admission 即使之后已消费也不要求当前仍有 Inbox row。精确匹配时只收敛原 LogicalAction/Observation，不提交新 Command 或再次 admission；缺失、重复或冲突时 fail closed 并产生 durable Action Required，不修复事实、不发新 handover、不请求 Provider。

这个 legacy 分支仅处理升级前已存在的未收敛 Action，不放宽新写规则。P9/P10 的 failure fact、dedup identity、Parent Workspace 投影、重启/rebuild 语义需由治理 landing 包定义；未落字前不得实现该分支，也不得把 pending test 从隔离目录提升为默认资格。

## 互斥路线比较

| 路线 | 对现有合同的适配 | 新概念/重复机制 | Crash replay | 提案结论 |
|---|---|---|---|---|
| A. 复用 SendMessage CommandGateway | P7 已规定 SendMessage(kind=Deliver)；补明 Deliver action 到 SendMessage route，套用 P1 receipt/fence | 最少；复用 CommandId、CommandStore、Gateway 和 P1 decoder；需给旧直接写入留 P9/P10 精确失败 disposition | effect + receipt 同事务；receipt-first 可覆盖 rejection/commit/action-observation 窗口 | **推荐** |
| B. Runtime 同事务 lease fence + 新 receipt | 保留 Deliver 不进 Gateway，但需明确 fence port/事务拥有者及 P9 replay 接口 | 新增 Runtime effect receipt/ledger、与 CommandStore 平行的 takeover/error algebra；同事务边界需跨当前 handler/Message/Event/Inbox | 可实现，但必须再设计一套稳定 receipt、冲突验证、崩溃收敛 | 不推荐，重复既有机制 |
| C. 允许旧代迟到通信 | 与 P2/DID 的 stale Worker 不得写入保证冲突 | 表面改动少，实则需重开 P2/P7/P9，定义 gen0/gen1 同一 MessageId 的先后、冲突、wake 与用户观察语义 | 无法用 P1 fencing/receipt 保证单一 owner；重复或晚到事实需另立规则 | 不接受为 v1 方案；若治理选择，必须重开 P2 所有者合同 |

## 固定 landing 包与审核边界

仅在人工接受上述唯一推荐合同后，建议按下列唯一语义包修改所有者文档；此提案本身不授权实施：

- `docs/design/implementation/P1/07-agent-loop-step-command-identity.md`：将 Deliver AgentAction 列入 trusted route table，CommandType=`SendMessage`；固定 MessageId、CommandId、receipt-first、result decoder 与 Action Observation 的归属。
- `docs/design/implementation/P7/02-deliver-primitive.md`：澄清 §8 已有 SendMessage command 必须经 CommandGateway；提交 receipt/Message/Event/Inbox/wake 的同事务，以及旧直接写入 exact-proof 的边界。保留“无新 Deliverable Command”和现有 Deliverable/Dependency/Verification 语义。
- `docs/design/implementation/P9/07-agent-loop-step-recovery.md`：固定 Deliver prior receipt 恢复顺序与升级前 direct-write exact-proof；定义不完整/冲突证据的唯一 durable Action Required fact 和 crash dedup。
- `docs/design/implementation/P10/02-attention-readmodel.md` 与对应 acceptance 文档：仅当 P9 fact 使用新 Attention source 时，定义 Parent target、severity、稳定 identity、rebuild/restart。
- P2 `03` fence 机制不放宽；P17 不变。P17 ResponseJob/Attempt 不接管 Deliver，也不增加根会话回复语义。

接受记录需包含接受 token、此提案 SHA-256、被修改 owner 文档的修订与 hash。Landing 后由独立 reviewer 检查跨文档一致性，Blocking=0 后再由人工单独授权实现。若 governor 选择 B 或 C，应先发布新的固定包并重审，不能只改实现路线。

## 最小 RED 与资格矩阵

现有 pending test 已给出模块级 RED；治理接受后保留并扩展：

| 场景 | 最小断言 |
|---|---|
| 旧 gen0 写入时 gen1 已持 lease | gen0 receipt=`FencingRejected`；无 Message/Event/Inbox/wake；gen1 最终一次 Committed |
| FencingRejected 提交前 kill | 独立 SQLite 看不到旧 receipt；kill 后事务回滚；gen1 唯一 Committed |
| FencingRejected 提交后 kill | 保留旧拒绝 receipt；gen1 使用不同 CommandId 收敛并唯一 Committed |
| Committed 后、Action Observation 前 kill | receipt/Message/Event/Inbox/wake 已提交，Action Pending；gen1 不发第二 Command，只 Applied/Observation 一次 |
| Gateway effect transaction 提交前 kill | Message、Event、Inbox、wake source、receipt 全不可见；重启后一次提交 |
| legacy direct-write exact proof | 不创建新 Command/Message/Event/Inbox；Action observation 收敛一次 |
| missing/conflicting legacy proof 或错误 prior receipt | 不 Provider 重跑、不写新 handover、不 Observation/Applied；P9/P10 durable Action Required 唯一且可重启/rebuild |
| downstream wake consumption | 唯一 MessageSent wake source；真实 consumer 重启/重复消费后 ChildDelivered/InboxEpisode 不重复 |

模块级先验证 route/ID、strict receipt decode、旧 receipt 结果绑定、domain rejection 不 takeover、MessageId 冲突失败关闭和 P9 legacy proof。之后使用两个 production daemon、同一 SQLite、生产 30 秒 TTL，覆盖表中双 daemon 边界；不允许测试直接 SQL 插入/修补 lease、receipt、Message 或 Event。每案断言相同 ProviderTurn/LogicalActionId/callRef、每代 CommandId、Provider 仅一次、Message/Event/Inbox/wake source 唯一、Action/Observation 唯一、恢复无第二 canonical effect。AH10 在上述项通过前保持 PARTIAL。

## 用户影响

当前 defect 是 **多 generation 运行中的 stale owner 可写入 Parent Message/Event/Inbox**，不是历史兼容问题；它不阻断本机单 daemon 的正常预览流程，但妨碍宣称 lease takeover 安全。升级前 action 已直接写 Message、未写 Observation 的 recovery 是单独的历史兼容窗口，不能通过全新数据库的单 daemon 预览覆盖。P17 的单用户 ResponseJob 正常流程不受本提案改动。
