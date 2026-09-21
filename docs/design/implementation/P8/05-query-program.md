# P8 — 05 Query Agent Scope (PROPOSAL, GQ1)

**Authority:** DID v1.11 §11 P8（G6）, §4.2 CompletedResult `QueryCompleted`:1107/1882/3850; §8.4 P14 Query/Inspection Program; PG non-goal:266; SD §12.5:1329。
**Status:** DRAFT (first draft for contract review).

## 1. 缺口重述

DID 无 Query Agent 正文定义；仅存：§11 P8 关键词、PG non-goal（各角色共用同一 Agent Runtime）、`QueryCompleted` settlement 分支、P14 Query/Inspection Program family 名。

## 2. 已裁决（v1.11 G6 / GQ1）：非独立实体 + P14 归 P8

```text
Query Agent ≡ 承担查询/巡检任务的 Execution-bound 执行（agent 角色，非新 runtime/新 entity）
```

- **spawn 面**：复用 P2 generic ExecutionBound admission + P6 spawn 模板（mission = 查询任务）；无独立 QueryAgentId（与"Agent 是 runtime execution role"的 §1.6 概念约定一致）。
- **settlement 面**：`Completed(QueryCompleted)`（P2 冻结分支）承载终态——结果作为 Report/Query Message（P6 通道）或 Inbox 观察回流请求方；无独立 canonical mutation。
- **Program 面**：P14 Query/Inspection Program v1 随 P8 契约一并冻结（§8.4 编号归属 P8 交付——与 P9 Verification Program 同批，D4 双层版本），必备条款：只读纪律、来源引用、结果即 Message 不改 canonical 状态。
- **与 Verification 的关系**：Query 执行可为 Verifier 的证据工具之一（SD §9.2 "tests are evidence tools"同族），但 Query 通道本身独立存在（任何 Workspace 可发起查询执行）。

## 3. 已否决的备选

DEFER P14 到 P10/P12——已否决（P10/P12 只消费不重新定义）；实体化（新 aggregate）与 §1.6 及 PG non-goal 冲突，未进入裁决。

## 4. Must Not Decide

- No 新 entity/ID/命令；No runtime 分叉；No query 结果的 canonical 写通道。
