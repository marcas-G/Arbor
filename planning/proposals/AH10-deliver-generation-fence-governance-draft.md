# AH10 Deliver 跨 generation fence 与 replay — 固定治理提案

状态：**DRAFT / 等待人工治理接受**

建议接受标识：`ACCEPT_DELIVER_GENERATION_FENCE_AND_REPLAY`

实现授权：**未授予**

基线：已审候选 `6fcbc17e27b694f201792aedd6c2ec368508b542`

## 提案决定

采用**新增的治理映射：Deliver AgentAction → `DeliverMessage` CommandGateway route**。这是对 P7 `02` §8 “构造 SendMessage command”的执行边界补充，不声称当前冻结合同已经指定 Gateway。新 CommandType 只提交现有 Deliverable 引用对应的 Message handover，不创建/更改 Deliverable entity；P7 的 Deliver message、MessageSent、Inbox 和 Dependency separation 语义保持。当前 `deliverHandler` 调用 `submitDeliver`，后者直接运行 SendMessage handler、手动补 MessageSent 的 Deliver 字段，再由外围 SQLite transaction 提交；它没有 CommandGateway receipt/fence。

选择此路线是因为它沿用 P1 已冻结的 `LogicalActionId`、generation-scoped `CommandId`、Command receipt、Gateway fence 和 effect/receipt 同事务边界；P7 已冻结 Deliver message、Deliver 专属 MessageSent 字段、Inbox summary 与 MessageSent consumer 的 ChildDelivered wake 语义。使用独立 `DeliverMessage` command/decoder 保留普通 SendMessage v1 request/result 与 receipt 路由不变。独立 Runtime ledger 会复制 Command receipt 和 takeover 规则。允许旧 generation 晚到写入则与 DID 的 Worker 写入 fencing 保证冲突。

## 冻结依据与失败证据

- P1 `07` §1–§3：`LogicalActionId` 跨 owner generation 稳定；每代 CommandId 不同；先查旧 receipt；仅旧 `FencingRejected` 可在 action 仍 Pending、ControlBasis 新鲜且无未决 effect 时重试；旧 Committed 必须收敛，domain rejection 不因 generation 改变而重试。
- P2 `03` §1–§3 与 DID §6.3/§9.7：过期或被替代的 Worker 不得提交持久写入；authoritative fence 必须与 canonical 写入、Command resolution 和 Domain Event 在同一事务中。P9 `07` §1 又要求执行写入先取得 current lease。
- P7 `02` §1、§4–§8：Deliver 是 Message handover，不是创建/修改 Deliverable；MessageSent 对 Deliver 有 `deliverableId`；Inbox summary 必须引用 Deliverable；directive 说明构造 SendMessage command，使用预分配 MessageId、CommandId 和既有 SendMessageAuthority。P7 没有冻结 Gateway 注册/接管映射；本提案明确推荐新增 AgentAction.Deliver→`DeliverMessage` route。ChildDelivered 由唯一 MessageSent event consumer 读取后发出，不是与 Message 一起写入的 wake row。
- P9 `07` §2：`ActionsInProgress` 恢复不得重跑 Provider；按 LogicalAction 收敛或执行下一项 Pending action。P17 的 ResponseJob/Attempt 只管理 HumanMessage 回复，不拥有 Workspace 间 Deliver 的 Message、Inbox 或 wake。

当前实现证据见 `planning/results/AH10-deliver-generation-fence.review.md`。隔离测试 `tests/functional/pending/ah10-deliver-stale-generation-replay.functional.test.ts` 建立真实 SQLite generation 0 → generation 1 lease，再以旧 gen0 `ExecutionOrigin` 调真实 handler。第一项预期失败：旧调用成功新增 Message、MessageSent、Inbox 各一条。第二项重入以 Message 主键冲突失败；事务回滚后每项仍各一条。该唯一键失败不是 replay 成功，也没有证明 WorkflowSignalConsumer 实际调度 wake。

## 被提议的精确合同

### 身份与事实所有权

1. Deliver 的 stable `LogicalActionId` 按 P1 既有公式绑定同一 Execution、ProviderTurn、callRef、route/action kind；generation 变化不改变它。
2. `MessageId` 是一次 handover 的稳定身份，跨 generation 不变；沿用当前 pinned occurrence 派生值（ProviderTurnId + outputPosition），不得从 generation 派生。不同 handover 不得复用它。
3. `CommandId` 是 `DeliverMessage` Application 请求的 generation-scoped 身份。gen0 保留当前 `deliver-command` + occurrence 派生的历史 ID；gen1+ 按 P1 从同一 LogicalActionId 和 generation 派生不同 CommandId。同一代普通操作重试复用同一 CommandId 和不可变 fingerprint。MessageId 不随 CommandId 改变。
4. 增加 registered handler `CommandType=DeliverMessage`、`schemaVersion="1"`，普通 `SendMessage` handler、v1 request/result decoder 和历史 receipts 均不变。strict DeliverMessage payload 固定为 `{messageId, senderWorkspaceId, deliverableId, bodyRef, correlationId?, causationId?}`；recipient 与 urgency 由 Runtime/handler-derived，不在 model payload。handler 在 Gateway 事务中验证 sender 拥有 Deliverable source Work、recipient 等于 sender direct parent、same Project、recipient Active、bodyRef 1..4096，并以既有 `SendMessageAuthority` 绑定 sender。它不得仅调用当前 generic `makeSendMessageHandler`；该 handler没有 Deliverable owner 检查，也不产生 P7 Deliver 的完整事件/Inbox 事实。
5. DeliverMessage v1 request/result decoder 严格校验 ID、closed fields、bounded summary、authority route 和 Committed result `{messageId, deliverableId, senderWorkspaceId, recipientWorkspaceId, admitted:true}`。不新增 External-origin command route。当前外部 SendMessage wire codec已有独立严格 Deliver discriminant（含必需 `deliverableId`），保留它；wire version 与 DeliverMessage receipt `schemaVersion` 是不同版本轴，wire decoder不替代内部 DeliverMessage handler ownership 验证。
6. 新 `DeliverMessage` receipt 的 schemaVersion 永远为 1；同 CommandType 不做 payload 语义复用。当前旧直写 Deliver 从未写 Command receipt；gen0 的 `deliver-command` id 仅供 lookup/历史 ID兼容，不得合成旧 receipt。gen1 prior lookup：有 `DeliverMessage/1` receipt 按 P1 规则处理；无 receipt 时走下一节的 canonical exact-proof；其他 CommandType、schemaVersion、identity 或 result shape 均不得被当成 Deliver receipt，必须走 P9 failure fact。
7. Gateway 同一个 `BEGIN IMMEDIATE`/`TransactionScope` 中提交 Deliverable ownership validation 所依赖的稳定事实检查、Message、带 Deliver 专属字段的 `MessageSent`、Inbox upsert 和 Committed receipt。Inbox 使用 `kind="Message"`、`messageEntryKey(messageId)`，summary 固定 `Deliver <deliverableId> from <senderWorkspaceId>`。MessageSent 是唯一 durable wake source；之后唯一 WorkflowSignalConsumer 读取此事件，从 canonical Message 重建 ChildDelivered `WakeReason` 并调用 wake sink。禁止新增/写入 wake row，Command receipt 不携带第二份可调度 wake。
8. AgentLoop Action/Step 仍拥有唯一 Action disposition 与 Observation。Receipt Committed 后、Observation 提交前崩溃时，gen1 重用原 receipt、生成同一个 Deliver Observation、将同一 LogicalAction 标为 Applied 并追加一次 Observation；Command receipt 本身不等于 Observation。

### 旧代拒绝与新代接管

1. 每次 Gateway mutation 都在 effect/receipt/Event 同一事务内核对 lease holder、incarnation、generation、未过期和 Execution 未 settled。外置 lease 预检只能快速失败，不能替代事务内 fence。
2. gen0 lease 已被 gen1 替代后，gen0 的 SendMessage command 必须提交 `TerminalRejected(FencingRejected)`，且无 Message、MessageSent、Inbox 或 Command receipt Committed effect；MessageSent consumer 不会收到 wake source；旧 Worker 停止该 Execution-origin write。
3. gen1 在提交新 Command 前按 P1 查所有较早 generation 的精确 SendMessage receipt：
   - 旧 Committed：严格校验 receipt envelope/result，重用其 MessageId/结果，不发新 Command、不新增 handover。
   - 旧 `TerminalRejected(FencingRejected)`：只有 LogicalAction 仍 Pending、当前 freshness/authority 仍通过、且无 unresolved effect，才以 gen1 CommandId 和相同稳定 MessageId 重试。
   - 旧 domain-semantic rejection 或 `ExecutionStopping`：遵循既有 Command/AgentAction error algebra，不因 takeover 重试。
   - 旧 operational failure：按既有不可变请求规则使用原 CommandId 重试；不得换 CommandId 规避 fingerprint。
   - receipt 缺失：仅在符合 P1 eligibility 时执行 gen1 command。
4. 新旧 CommandId 最多一个 Committed；在 Committed 前任一 kill 均回滚该事务，在 Committed 后 takeover 必须 receipt-first。Message、MessageSent、Inbox admission 对同一 MessageId 最多各一条；wake 由唯一 MessageSent consumer 投递一次或幂等重放，不存在独立 wake source row。

### 既存直接写入的兼容边界

当前旧实现可以在 Action 仍 Pending 时已直接提交 handover，却没有 Command receipt。该事实不能伪造为 Committed receipt。对这种既存状态，提案要求 P9 恢复先做只读 exact-proof：稳定 MessageId 对应唯一 Message 与唯一 MessageSent，且 sender、direct-parent recipient、Deliverable、bounded summary/body ref 与 pinned Action 输入一致；MessageSent 与 Message 是 P7 同事务事实，因此 Inbox 曾在提交时 admission 即使之后已消费也不要求当前仍有 Inbox row。精确匹配时只收敛原 LogicalAction/Observation，不提交新 Command 或再次 admission；缺失、重复或冲突时 fail closed 并产生 durable Action Required，不修复事实、不发新 handover、不请求 Provider。

legacy exact-proof 规则固定如下：

- 若该稳定 MessageId 下 Message、MessageSent、Inbox key 全部不存在，属于未执行；满足 P1 takeover 条件后可提交当前代 Gateway command。
- 若唯一 Message 与唯一 MessageSent 完全匹配 pinned action（kind、MessageId、sender、direct-parent recipient、deliverableId、bodyRef、correlationId、causationId），且不存在矛盾的 Inbox row，则视作旧同事务 effect 已完成；Inbox 当前缺行允许（可能已消费）。不补写 receipt、不重做 Inbox admission，仅收敛 Action Observation。
- 若 Message/Event 仅存在其一、重复、字段不匹配、或有 Inbox row 却无完整 Message/Event proof，则不发 Gateway command、不请求 Provider、不改任何现存事实。由下列 P9/P10 fact 阻断恢复。

### Legacy evidence 不足的 P9 fact 与 P10 Attention

定义一个且仅一个 Deliver 恢复失败源：`DeliverReplayEscalated` event + P9-owned `deliver_replay_attention_facts` row。该源仅用于上述 pre-Gateway legacy proof 缺失/矛盾及 Deliver route 的 prior committed receipt 不能严格解码/绑定的情况；不扩展为通用 CommandStore Attention。

P9 fact 字段固定为 `{attentionFactId, eventId, projectId, executionId, targetWorkspaceId, logicalActionId, messageId, failureCode, firstDetectedAt}`。`failureCode` 是 closed enum：`LegacyMessageMissingEvent | LegacyEventMissingMessage | LegacyMessageBindingMismatch | LegacyInboxConflict | PriorReceiptDecodeMismatch | PriorReceiptResultMismatch`；不得写 body、summary、raw JSON、parser/database error 或 authority material。`targetWorkspaceId` 固定为执行 Deliver 的 Workspace (`executions.workspace_id`)；`projectId` 取其 Execution。Fact identity/dedup 精确为 `att_` + lowercase SHA-256 hex of UTF-8 `JSON.stringify({version:1,executionId,logicalActionId,messageId})`；DB 同时设 `(execution_id,logical_action_id,message_id)` unique。首次 failureCode/时间不可覆写；同 tuple 重复返回原 fact，任何目标/Project/identity 冲突为 invariant failure。

Fact 和 `DeliverReplayEscalated` v1 event 在同一 P9 `TransactionScope` 原子提交。Event payload 精确 `{attentionFactId,executionId,targetWorkspaceId,logicalActionId,messageId,failureCode}`；`aggregate_ref=targetWorkspaceId`、`correlation_ref=logicalActionId`、`caused_by_command_id` 仅在存在 prior Command receipt 时绑定该确切 CommandId，legacy 无 receipt 时省略；`occurred_at=firstDetectedAt`，actor=`system:recovery`。Fact event commit 前 crash 无 event/fact；commit 后 crash 由相同 tuple 读回，不追加第二 event。若该事务失败，恢复依旧 fail closed 且不得生成 Action Observation。

P9 failure commit 后返回既有 `AgentActionRecoveryBlocked` 语义：不标 Applied/Rejected，不造 Observation，不 settle 一个没有 durable proposal 的 `ActionsInProgress` Step，不发新 Command/Message/Event/Inbox，不重调 Provider；释放当前 owner lease。后续每次恢复先按同一 tuple 读 fact，继续 `RecoveryBlocked`，不自动清除/重试。该 Action Required 表示需人工治理介入；v1 没有 dismiss/repair command，fact 是 append-only。

P10 row 固定 `source=DeliverReplayFailure`、`severity=ActionRequired`、`targetWorkspaceId=fact.targetWorkspaceId`、`dedupKey=attentionFactId`，detail 固定为 “A Deliver handover could not be reconciled with its exact Message and MessageSent facts; execution recovery is paused.”，附 typed `failureCode`；不展示 MessageId/body/summary 或其他 opaque refs。子树统计按 `attentionFactId` 去重，不向上复制上下文。P10 apply consumer 在同一事务 upsert Attention row 并前进自己的 event offset；P10 只写 read model，不改 P9 source fact、Command receipt 或 canonical Message。Project-scoped rebuild 从 P9 fact rows 重建同一 projection，checkpoint 不复用/重置 P1 offset；restart/replay 仍得到一行。Attention 无自动清除。

该 failure fact 及 projection 是新语义，落地所有者只能是 P9 `07` 和 P10 `02`/`07`；在人工接受、owner revisions 与独立一致性审阅之前不实现，也不把 pending test 提升到默认资格。

## 互斥路线比较

| 路线 | 对现有合同的适配 | 新概念/重复机制 | Crash replay | 提案结论 |
|---|---|---|---|---|
| A. 新增 Deliver→DeliverMessage CommandGateway governance mapping | P7 §8 已规定构造 SendMessage command，但未冻结 Gateway 注册/执行 route；治理新增只交付既有 Deliverable 的 Message command并套用 P1 receipt/fence | 复用 CommandId、CommandStore、Gateway；新增 DeliverMessage schema v1 handler/request/result decoder 及 P9/P10 legacy failure source；普通 SendMessage v1不变 | Deliver effect + receipt 同事务；receipt-first覆盖 rejection/commit/action-observation；MessageSent consumer 唯一发 wake | **推荐** |
| B. Runtime 同事务 lease fence + 新 receipt | 保留 Deliver 不进 Gateway，但需明确 fence port/事务拥有者及 P9 replay 接口 | 新增 Runtime effect receipt/ledger、与 CommandStore 平行的 takeover/error algebra；同事务边界需跨当前 handler/Message/Event/Inbox | 可实现，但必须再设计一套稳定 receipt、冲突验证、崩溃收敛 | 不推荐，重复既有机制 |
| C. 允许旧代迟到通信 | 与 P2/DID 的 stale Worker 不得写入保证冲突 | 表面改动少，实则需重开 P2/P7/P9，定义 gen0/gen1 同一 MessageId 的先后、冲突、wake 与用户观察语义 | 无法用 P1 fencing/receipt 保证单一 owner；重复或晚到事实需另立规则 | 不接受为 v1 方案；若治理选择，必须重开 P2 所有者合同 |

## 固定 landing 包与审核边界

仅在人工接受上述唯一推荐合同后，建议按下列唯一语义包修改所有者文档；此提案本身不授权实施：

- `docs/design/implementation/P1/07-agent-loop-step-command-identity.md`：新增明确的 Deliver AgentAction → DeliverMessage/1 route；固定 legacy gen0 `deliver-command` ID、gen-scoped successor CommandId、receipt route/schema decoder 与 Action Observation 归属。
- `docs/design/implementation/P7/02-deliver-primitive.md`：将当前 directive 的 SendMessage command 规范映射为 DeliverMessage Gateway 执行；明确 DeliverMessage payload/handler、deliverable ownership、MessageSent deliverableId、Inbox summary、receipt 同事务，以及升级前 direct-write exact-proof/failure boundary。保留“无新 Deliverable 创建/修改命令”和现有 Deliverable/Dependency/Verification 语义。
- `docs/design/implementation/P9/07-agent-loop-step-recovery.md`：固定 DeliverMessage v1 prior receipt 恢复顺序与升级前 direct-write exact-proof；精确定义 `deliver_replay_attention_facts` row/event/failure codes/idempotency、RecoveryBlocked 行为及两侧 crash recovery。
- `docs/design/implementation/P10/02-attention-readmodel.md` 与 `07-acceptance.md`：新增 `DeliverReplayFailure` source 的 ActionRequired severity、Execution Workspace target、attentionFactId dedup、固定安全 summary、consumer row+offset原子性、project rebuild/restart资格。
- P2 `03` fence 机制不放宽；P17 不变。P17 ResponseJob/Attempt 不接管 Deliver，也不增加根会话回复语义。

接受记录需包含接受 token、此提案 SHA-256、被修改 owner 文档的修订与 hash。Landing 后由独立 reviewer 检查跨文档一致性，Blocking=0 后再由人工单独授权实现。若 governor 选择 B 或 C，应先发布新的固定包并重审，不能只改实现路线。

## 最小 RED 与资格矩阵

现有 pending test 已给出模块级 RED；治理接受后保留并扩展：

| 场景 | 最小断言 |
|---|---|
| 旧 gen0 写入时 gen1 已持 lease | gen0 receipt=`FencingRejected`；无 Message/Event/Inbox/Committed receipt；没有 MessageSent event 因此无 wake；gen1 最终一次 Committed |
| FencingRejected 提交前 kill | 独立 SQLite 看不到旧 receipt；kill 后事务回滚；gen1 唯一 Committed |
| FencingRejected 提交后 kill | 保留旧拒绝 receipt；gen1 使用不同 CommandId 收敛并唯一 Committed |
| Committed 后、Action Observation 前 kill | receipt/Message/Event/Inbox 已提交，Action Pending；gen1 不发第二 Command，只 Applied/Observation 一次 |
| Gateway effect transaction 提交前 kill | Message、Event、Inbox、receipt 全不可见；重启后一次提交，MessageSent consumer 唯一读到 committed event |
| legacy direct-write exact proof | 不创建新 Command/Message/Event/Inbox；Action observation 收敛一次 |
| missing/conflicting legacy proof 或错误 prior receipt | 不 Provider 重跑、不写新 handover、不 Observation/Applied；P9 fact+event同事务唯一，P10 ActionRequired row+offset原子且重启/rebuild不重复 |
| downstream wake consumption | 唯一 MessageSent event；真实 consumer 重启/重复消费后 ChildDelivered/InboxEpisode 不重复，不新增 wake row |

模块级先验证 DeliverMessage v1 route/strict payload/handler ownership/MessageSent 与 Inbox字段、v1 receipt decode、旧 receipt 结果绑定、domain rejection 不 takeover、MessageId 冲突失败关闭和 P9 legacy proof/fact dedup；普通 SendMessage v1回归保持原语义。之后使用两个 production daemon、同一 SQLite、生产 30 秒 TTL，覆盖表中双 daemon 边界；不允许测试直接 SQL 插入/修补 lease、receipt、Message 或 Event。每案断言相同 ProviderTurn/LogicalActionId/callRef、每代 CommandId、Provider 仅一次、Message/Event/Inbox唯一、Action/Observation唯一，MessageSent consumer发出唯一可恢复 ChildDelivered wake且无额外wake row。AH10 在上述项通过前保持 PARTIAL。

## 用户影响

当前 defect 是 **多 generation 运行中的 stale owner 可写入 Parent Message/Event/Inbox**，不是历史兼容问题；它不阻断本机单 daemon 的正常预览流程，但妨碍宣称 lease takeover 安全。升级前 action 已直接写 Message、未写 Observation 的 recovery 是单独的历史兼容窗口，不能通过全新数据库的单 daemon 预览覆盖。P17 的单用户 ResponseJob 正常流程不受本提案改动。
