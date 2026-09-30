# Provider 结果交接 / AgentLoopStep — 设计闭合结果

## 结论

**DESIGN CONTRACT CLOSED / IMPLEMENTATION NOT AUTHORIZED — 2026-09-30。**

人工治理已接受并完成“持久 AgentLoopStep + 可重放 Provider 结果 + 幂等
Session/动作交接”的正式设计落字。`DOGFOOD-DG-01` 不再是未回答的设计问题，
状态更新为 `RESOLVED`。失败数据库仍未恢复；实现与证据是独立后续门。

## 固定输入

| Artifact | SHA-256 / result |
|---|---|
| reviewed proposal | `BDC9AFB28515B2BC6FDBC450EEEB8006ACB1D8A4994DB5AB290A472EA0AB512F` |
| reviewed governance submission | `908610EE54ED33B3AA5448264E8C18A32EFB333B372D18934D97EC1993EB3A08` |
| manual decision | `ACCEPT`；`planning/proposals/provider-result-handoff-governance-decision.md` |

闭合审计重新计算前两项哈希，均与审阅记录一致；被审阅文件未修改。

## 正式设计落点

| Owner | Landed contract |
|---|---|
| DID v1.20 | AHT-1…AHT-8；runtime record、ports、persistence、package boundary、recovery/authorization 状态 |
| P1 / Application | `07-agent-loop-step-command-identity.md`：LogicalAction/Settlement 与 generation-scoped CommandId、receipt-first eligibility |
| P2 | idempotent sourced Session append、fenced AgentLoopStepStore、migration 0017 DDL、Execution recovery seam |
| P3 | `08-agent-loop-step-handoff.md`：完整状态机、Provider success replay、pinned decode、action ledger、successor/proposal |
| P9 | `07-agent-loop-step-recovery.md`：recovery disposition、legacy adoption、AH1–AH14、branch-specific assertions |
| P12 | AgentLoopStep transition fencing、cooperative scheduling、D4 durable-progress integration、stop/reconciliation precedence |
| P14 | AgentLoopStep → Execution settlement → HumanMessage/Transcript final convergence；S11–S14 successor seams |

P2 是审计补出的必要 owner：Session append、lease-holder triple 与 Execution
recovery 都属于 P2；不补 P2 会留下无法执行的跨文档断点。

## 一致性审计

PASS：

1. P3 的 8 个 AgentLoopStep states 与 P2 migration DDL 完全一致。
2. P3 的 6 个 action states 与 P2 migration DDL 完全一致。
3. complete Provider success 优先本地收敛；只有无完整成功证据时才允许
   P9 same-Turn/new-Attempt。
4. `success_evidence_version` 固定完整性校验规则；legacy null 不自动代表成功。
5. sourced Session fields 由 trigger 约束 all-null/all-present，并由 partial unique
   index 去重；same-source/different-hash 明确为 invariant conflict。
6. process-local `AgentAction` 未成为 wire/persistence contract；action ledger 只存
   identity/hash/disposition/result refs。
7. `FencingRejected` 与 `ExecutionStopping` 已分离：前者可在证据允许时由新
   generation 换新 CommandId；后者跨 generation 阻止 normal action。
8. `ReconciliationPending` 在 P3/P9/P12/P14 都阻止普通 next-turn 和
   Completed/Interrupted/Failed。
9. repair / next-turn successor 都使用 persisted complete identity +
   `ensureSuccessor`，不重算决定。
10. migration `0017_agent_loop_step_handoff` 顺接当前实现基线 0016；设计落字未执行
    migration，也未修改保全数据库。
11. package DAG 不增加 edge；新增 store 仍为 `ports` + existing SQLite adapter，
    orchestration 留在 `agent-runtime`。
12. `git diff --check` 对治理落字文件通过；新增/修改文档 code fences 成对。

## 审计中修正的关键问题

- 将原提案最小 owner 集合扩展到 P2，关闭事务所有权遗漏。
- 将旧的“unsettled Turn 一律 retry”改成“完整成功证据先本地收敛”。
- 将旧 generation 的 `FencingRejected` 与持久 stop 状态分离，避免新 owner
  错误绕过 quiescence。
- 为 replay 固定 decoder/evidence version，避免升级后的代码重新解释历史输出。
- 按仓库 Design Gap 规则，把 `DOGFOOD-DG-01` 标为设计层 `RESOLVED`，同时保留
  独立实现门，避免用 OPEN Design Gap 混淆未授权实现。

## 未授权 / 未完成

以下全部保持未完成：

- migration `0017_agent_loop_step_handoff` 的代码与执行；
- AgentLoopStep/Action store、atomic Provider success、Session sourced append 的实现；
- legacy adoption/recovery daemon 实现；
- AH1–AH14 commit 前后 crash injection；
- DOGFOOD-DG-01 等价 fixture 与保全数据库恢复；
- 对现有用户数据的任何写入、重放或推断 settlement。

下一步若要进入实现，必须单独明确授权，并先产出 implementation plan / TDD
矩阵；不得把本结果记录当成实现授权。

## v1.21 后续授权

用户随后接受 `AgentLoopStep` 命名并明确授权执行；见
`planning/proposals/agent-loop-step-implementation-authorization.md`。本文件仍是
设计闭合证据，实现进度与验收必须记录在单独结果中。
