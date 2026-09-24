# P14 — 05 Acceptance（十 seams + 完成定义）

**Baseline:** DID v1.16 G-A–G-F · DID v1.17 TR-WPU-D placement/read-model successor · contracts `00`–`04`

## 1. End-to-end acceptance story

操作者在 Root Workspace 对话 tab 输入消息 → SubmitHumanMessage Committed
→ composer 清空、无本地假消息 → WS invalidation → transcript refetch 出现
Human turn（messageId+bounded body）→ server trigger 依 FIFO claim →
Coordination execution 运行（可多 ProviderTurn）→ Settle(QueryCompleted) →
invalidation → transcript 出现 Assistant turn（executionId+bounded body）
→ 追加第二条消息：若 main 忙则"已入列"派生态，settle 后串行回复 →
注入 crash（claim/settle 两点）恢复后无重复回复 → child workspace 打开
"对话记录" tab：只读、无 composer → 全程 UI 无 AdmitExecution 直连、无
streaming。

## 2. 十 seams → 机械验收矩阵

| # | Seam（用户指定） | 合同锚 | 机械 evidence |
|---|---|---|---|
| S1 | HumanMessage durability / idempotency | `01` §4/§2 | 命令事务内 durable 断言；同 commandId 重放同 receipt；fingerprint 冲突拒绝 |
| S2 | Root-only authority exact binding | `01` §1 | resolver：human+root 恒 Granted；target≠root → AuthorityDenied（含 child 直发负向） |
| S3 | HumanInput 与 SteerWork 不混义 | `01` §3/§2 | SubmitHumanMessage 不产生 WorkSteered/HumanInterventionApplied；kind=HumanConversation≠HumanInput；web 端 SendMessage 仍禁 |
| S4 | Coordination 与 Work execution 不混义 | `02` §1 | conversation execution 无 workId 绑定；Work execution 路径回归全绿 |
| S5 | one-active-main 排队 | `02` §3 | 有 active main 时零 admission；FIFO；settle 后依序 claim |
| S6 | crash 后 exact-once logical response | `02` §2/§4 | crash@claim 回滚重试；crash@settle 不重回复；transcript executionId upsert 幂等 |
| S7 | transcript correlation | `03` §1 | Assistant↔executionId、Human↔messageId 1:1；bounded 截断 |
| S8 | no direct external AdmitExecution from Web | `04` §3 | web 源码扫描 AdmitExecution 零出现 |
| S9 | no provider streaming in v1 | `03` §3/`04` §3 | 无新推送通道（架构扫描 EventSource/SSE 零出现）；turn body 仅来自 /views；无本地 optimistic turn（测试断言 refetch 前无新节点） |
| S10 | Child Workspace zero composer | `04` §2/§3 | child conversation tab 只读负向测试；路由参数仅 root 生效 |

## 3. Exit criteria

| # | Criterion | Evidence |
|---|---|---|
| EC-1 | `pnpm check` 全绿（迁移 0014 并入基线） | root check exit 0 |
| EC-2 | S1–S10 全部机械 evidenced | `tests/p14-*.test.ts` + web tests + 架构扫描 |
| EC-3 | 回归零红（除 TR-A/B/C 所列 supersession 外） | 五项行为资产 + Web v1 suites（exposure-matrix 断言更新为 8 项属 TR-B 预期变更） |
| EC-4 | exposure matrix 更新（+SubmitHumanMessage = 8 项）机械锁定 | catalog 测试更新 |
| EC-5 | 无 open P14 Design Gap | gap gate |

## 4. 完成定义

```text
P14 COMPLETE = EC-1..EC-5 全 PASS
FORMALLY CLOSED = result record + 状态同步 + clean tree
```

## 5. Must Not Decide

- 不决定 direct-child conversation（未来单独治理）；
- 不决定 streaming 引入条件；
- 不决定 chat 优先级/preemption。
