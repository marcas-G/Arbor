# MAC-DG-01 — 系统复杂度超过已闭合的用户价值链

## 状态

**RESOLVED — Problem & Goals v1.3 / Scenarios v1.3 / System Design v1.9 / DID v1.31 / MAC contracts**

## 触发证据

完整架构审计确认：核心 Workspace/Work/Execution 模型成立，但当前实现同时存在：

- Root Conversation 不能启动普通 Work；
- Parent Agent 无模型可用的结果接受动作；
- Dependency 可声明但正式 Deliverable 生产/交付未进入 Agent control surface；
- Workspace Memory/Knowledge 没有 production implementation；
- Formation approval 与异步应用没有 fulfillment closure；
- Specialist 被提升为领域概念但没有可用 executable tool surface；
- executable/control exact-intent approval 重复；
- 多个恢复 consumer 使用 unknown error / log-and-continue；
- active runtime 承担过多 legacy compatibility；
- 51-table runtime 与多个千行模块已经形成较高维护成本。

Evidence:
`planning/results/system-architecture-occam-audit.result.md`。

## 为什么是顶层 Design Gap

这些问题不能通过继续增加单个 tool、状态或 UI 表单独立解决。它们共同说明：产品概念、
Workspace cognition、Agent Runtime 与 durable workflow 的边界需要重新冻结。局部补丁会
继续扩大重复状态机和不可达能力。

## 推荐方向

采用 `planning/proposals/minimal-architecture-convergence-decision-draft.md`：

1. 冻结最小外部词汇；
2. Plan 下沉为 Workspace-local cognition；
3. Specialist 下沉为可选 `spawn_agent` Runtime action；
4. 模型表面统一为 ActionCall，内部再路由 executable/control/subagent；
5. 合并 exact-intent approval infrastructure；
6. 先完成 single-Workspace golden path；
7. 再完成 child Workspace formation/Parent Acceptance；
8. Dependency/Deliverable 和 subagent parallelism 后置；
9. 历史兼容移出 active runtime；
10. Effect error channel 在 consumer/recovery 边界重新类型化。

## 受影响工作

- `RGI-DG-01`：暂停，重新纳入最小黄金路径；
- `SDO-DG-01`：暂停“完善 Specialist”，改为决定 runtime subagent 是否/何时启用；
- System Design / DID / P2 / P3 / P6 / P7 / P8 / P12 / P17；
- Domain、Agent Runtime、Model Context、Application consumer、SQLite migration、Web。
