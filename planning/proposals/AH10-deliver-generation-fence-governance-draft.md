# Deliver 跨代写权限与回放 — 治理决策稿

状态：**DRAFT / 等待人工治理接受**
范围：`P1 07` logical action takeover × `P7 02` Deliver primitive
实施：**未授权**
建议接受标识：`ACCEPT_DELIVER_GENERATION_FENCE_AND_REPLAY`

## 已复现的边界

P1 `07` 将跨代 Agent 语义动作定义为稳定 `LogicalActionId`，每代 Command 使用
不同 `CommandId`，并要求 receipt-first：旧 `FencingRejected` 才允许当前代重试；旧
`Committed` 收敛既有事实；非 fencing 终态拒绝不得因换代而抹除。

P7 `02` §1 同时规定 Deliver 是 Message handover，不是 canonical mutation
envelope；§8 又要求构造带 caller-preallocated `messageId` / `commandId` 和
`SendMessageAuthority` 的 SendMessage command。P7 `02` §5 明确 Inbox 按
`messageEntryKey(messageId)` upsert，未定义同一 MessageId 的已提交交付如何回放。

当前 `deliverHandler` 在 `apps/single-workspace/src/control-actions.ts` 从
`providerTurnId:outputPosition` 生成固定 commandId/messageId，然后调用
`submitDeliver`。`submitDeliver` 直接以 `External` context 执行 SendMessage handler；
不经 CommandGateway，不读取 `fencingGeneration` 或 receipt。

隔离测试
`tests/functional/pending/ah10-deliver-stale-generation-replay.functional.test.ts`
实际建立 SQLite LeaseService generation 0 → release → generation 1 / `worker:new`，
再用旧 generation 0 输入调真实 Deliver handler。预期不落 Message、MessageSent 或
Inbox；实际 handler 成功，三类持久记录各写入一份。随后同一调用身份/MessageId 重入：
第二次调用以 Message 主键冲突失败，事务回滚，三类持久事实仍各一份。MessageSent
由 `WorkflowSignalConsumer` 读取并导出 `ChildDelivered` wake；本测试未运行消费者，故
只证明存在一条 durable wake-source event，不声称测过消费者的实际 wake 调度。

## 需治理裁定的互斥路线

1. **Deliver 采用 P1 Gateway takeover。** 明确 P7 §1 的“非 canonical mutation
   envelope”不排除经 CommandGateway 提交 Message；按 generation 派生命令 ID，receipt-first
   校验旧 Committed 的 Message/Event/Inbox canonical 事实，旧 FencingRejected 仅在无已提交
   effect 时允许新代重试。同 MessageId 成功重放需读取并验证既有 handover，而不是再次
   `INSERT`。此路线需解释 P7 §8 已要求的 SendMessageAuthority 和 CommandGateway 的精确关系。
2. **保留非 Gateway Deliver，增加独立 fencing/receipt 边界。** 保持 Message handover
   的 P7 分类，但定义 Runtime 持久 admission/receipt API：验证当前 generation，绑定
   LogicalActionId、MessageId、CommandId 与提交结果，并使 Message、MessageSent、Inbox、
   wake-source effect 可被同一事实安全收敛。需由治理确定其所属契约/存储边界，不能在
   action handler 中临时拼装。
3. **明确允许旧代 Deliver 越过 takeover。** 若选择通信 effect 可在原 lease 失效后完成，
   必须定义它与新代同一 LogicalAction 的先后/冲突规则、事实唯一性及 wake 行为。该路线
   接受 stale owner 能影响 Parent Inbox 的语义后果；不能把它描述成 P1 fencing 已满足。

以上只是决策选项，不是推荐实现或已接受的新语义。治理应明确：何者有权 fence Deliver、
提交边界在哪、相同 MessageId/content 如何 replay、不同 payload 如何冲突、MessageSent
到 ChildDelivered wake 如何去重。接受前不得自行把 Deliver 改成 Gateway command。

## 接受后的退出门

1. 人工接受并按既有委托落地完全一致的已接受文档包，保存接受 token、提案哈希、
   版本与落地一致性审阅；仅一致性审阅 PASS 后，另行授权实现。
2. 在旧代仍有效、旧代 FencingRejected、旧代已 Committed、非 fencing 终态拒绝、缺少/冲突
   canonical Message 等情况下逐项验证 receipt/ownership 路径。
3. 两侧真实进程 kill/restart：Deliver intent/命令前后、Message/Event/Inbox commit 前后、
   wake 消费前后；若治理选择旧代必须被 fence，证明旧 generation 不追加新 handover；
   若治理明确允许旧代晚到通信，证明它与新代同一 LogicalAction 的顺序、冲突和收敛规则。
4. 同一 MessageId 恢复必须至多一条 Message、MessageSent、Inbox admission 和
   ChildDelivered wake source；精确匹配才能收敛，冲突必须失败关闭。
5. 将 handler/SQLite 证据与真实进程资格分开记录；后者通过前 AH10 保持 PARTIAL。
