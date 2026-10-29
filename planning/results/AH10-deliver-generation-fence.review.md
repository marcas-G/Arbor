# Deliver 跨代写权限与回放 — 治理审阅

日期：2026-10-07
对象：`planning/proposals/AH10-deliver-generation-fence-governance-draft.md`
提案 SHA-256：
`BCA6ABE6EE337C487A398573F7C6CAA66F9A642E95F40ECE8C20FD58BB5E8396`

结论：**证据足以提交人工治理决策；未接受，未授权实现。**

## SQLite/handler 证据

Pending 测试使用 `LeaseService` 实际建立 generation 0 的旧 owner，释放旧租约后取得
generation 1 的新 owner；随后把旧 generation 0 的 `ExecutionOrigin` 交给真实
`deliverHandler`，其 `submitDeliver` 经 SQLite `TransactionPort`、MessageStore、Inbox
和 DomainEventJournal 落库。

定向命令：

```text
pnpm exec vitest run --config vitest.pending-functional.config.ts tests/functional/pending/ah10-deliver-stale-generation-replay.functional.test.ts
```

结果为 1 failure / 1 pass：

- **红灯**：新 lease 已是 generation 1 / `worker:new` 时，旧 generation 0 handler 返回
  Success，实际新增 Message=1、MessageSent=1、Inbox=1，而预期应在写入前拒绝。该调用链
  未读取 generation，故越过 lease takeover。
- **绿灯**：已提交同一个 deterministic MessageId 后重入，Message 主键冲突让调用失败；
  SQLite 事务回滚后 Message、MessageSent、Inbox 仍各一条。不能把这个唯一键失败说成
  幂等 replay 成功，也没有观察到重复 canonical effect。

MessageSent 会由 `WorkflowSignalConsumer` 根据持久 Message 查找并产生 ChildDelivered
wake。红测查询了该 wake 的持久来源 event，但没有调用 consumer 或统计 scheduler
reevaluate；因此 wake 结论来自冻结消费者合同/实现路径，尚无本测的真实 wake 调度证据。

## 合同与治理边界

P7 `02` §1 将 Deliver 归为 Message handover 而非 canonical mutation envelope；§8 要求
caller-preallocated commandId/messageId 和 SendMessageAuthority。当前实现使用固定
occurrence-derived IDs，直接以 External context 执行 SendMessage handler，不经
CommandGateway；P1 `07` 的 generation-scoped Command / receipt-first takeover 不能在此
路径上直接成立。P7 `02` §5 只冻结 Inbox upsert，不给 MessageId 已提交后的完整回放结果
语义。该矛盾需要人工确定 fencing/receipt 所有权，不应由测试或局部 handler 变更替治理
裁决。

提案列出 Gateway takeover、独立 Runtime fence/receipt、或显式接受旧代晚到通信的互斥
路线。本审阅不选择路线，不修改 `docs/design/**`，不授权产品源码或迁移。接受落字后，
应先完成落地一致性审阅，再单独授权实现；真实进程双侧 crash、canonical facts、wake
去重资格通过前 AH10 保持 PARTIAL。
