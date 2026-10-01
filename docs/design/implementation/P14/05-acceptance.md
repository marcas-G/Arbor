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

## 2A. DID v1.20 successor seams（implementation authorized by v1.21）

| # | Seam | 合同锚 | 机械 evidence |
|---|---|---|---|
| S11 | settled Provider result handoff | P3 `08` §5；P9 `07` | crash 后同 ProviderTurn 请求计数不增加；sourced ModelOutput 恰好一条 |
| S12 | AgentLoopStep → conversation convergence | `02` §4.4；P9 `07` AH12/AH13 | proposal/settlement/writeback 两侧 kill；最终 Assistant turn 恰好一条 |
| S13 | branch-specific message disposition（P17 superseded） | `02` §4.2/§4.4；P17 `03` | Completed=Answered；Interrupted=Cancelled/pause；Failed=classified retry/attention；OutcomeUnknown=Attention |
| S14 | legacy adoption | P9 `07` §3/AH14 | DOGFOOD 等价 fixture 收敛；证据不足 fixture durable Attention、零请求 |

## 3. Exit criteria

| # | Criterion | Evidence |
|---|---|---|
| EC-1 | `pnpm check` 全绿（迁移 0014 并入基线） | root check exit 0 |
| EC-2 | S1–S10 全部机械 evidenced | `tests/p14-*.test.ts` + web tests + 架构扫描 |
| EC-3 | 回归零红（除 TR-A/B/C 所列 supersession 外） | 五项行为资产 + Web v1 suites（exposure-matrix 断言更新为 8 项属 TR-B 预期变更） |
| EC-4 | exposure matrix 更新（+SubmitHumanMessage = 8 项）机械锁定 | catalog 测试更新 |
| EC-5 | 无 open P14 Design Gap | gap gate |

S11–S14 belong to the v1.20 successor implementation gate and are not claimed
by the historical P14 completion record.

## 2B. DID v1.24 / P17 successor seams

P17 `07-acceptance.md` C1–C20 supersede P14 retry/runtime acceptance. In
particular, phase closure requires zero Provider bytes for blocked context,
durable retry eligibility/backoff, explicit status projection, exact turn
profiles, migration 0021 and removal of legacy retry/write paths. Historical
P14 completion remains evidence for submit/root/transcript placement only.

## 4. 完成定义

```text
P14 COMPLETE = EC-1..EC-5 全 PASS
FORMALLY CLOSED = result record + 状态同步 + clean tree
```

## 5. Must Not Decide

- 不决定 direct-child conversation（未来单独治理）；
- 不决定 streaming 引入条件；
- 不决定 chat 优先级/preemption。
