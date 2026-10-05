# Reconcilable 工具的现实证明与 shell 分级 — 治理决策稿

状态：**DRAFT / 等待人工治理接受**

缺口：`AH7-DG-02`

实施：**尚未授权**

建议接受标识：`ACCEPT_RECONCILABLE_TOOL_REALITY_PROOF`

## 建议决定

`Reconcilable` 不再仅由工具名声明，而必须具备可执行的 per-invocation
reconciliation 合同：外部效应的稳定身份、可读取的现实证据，以及
`NotOccurred | Occurred(result evidence) | StillUnknown` 三种带来源的结果。
P4 在任何 replay 前先执行 reconcile；`Occurred` 可用证据持久化原调用结果，
`NotOccurred` 才按原调用的权限/资源/策略决定是否重试，`StillUnknown` 保留
ReconciliationPending/Attention 或 OutcomeUnknown，绝不盲重放。

通用 shell v1 没有单一可证明的外部效应身份，因此默认按 `NonIdempotent`
处理。仅治理过的受限命令模式或提供独立 idempotency/reconciliation adapter 的
命令可声明 `Reconcilable`；模型提交的任意 shell 文本不得自称可核对。
这不改变 `read` 的 ReadOnly 或 `patch` 的 Idempotent 语义。

持久 P4 intent 需保存选择时的 side-effect/reconciliation profile 版本。恢复
沿原版本执行，不因代码升级静默扩大可 replay 集。历史
`Reconcilable shell` 无法证明核对能力的记录按未知效果失败关闭，不重放命令。

## 验收

- 真实进程在 shell effect 后、settlement 前崩溃：若无可核对 profile，
  不重放，保留 ReconciliationPending/OutcomeUnknown，并给出可见 Attention。
- 对有核对 profile 的受限测试工具分别注入 NotOccurred、Occurred、StillUnknown；
  检查现实证据先于任何 replay，最终 settlement/action/Observation 幂等且一致。
- 保留现有 AH7 两侧安全停止用例；新增跨重启、旧 profile 与权限撤销场景。
- `pnpm check` 和完整 `pnpm test:functional` 通过，且不把 F16/AH7 ReadOnly
  用例当成 reconciliation 证据。

若接受，只在 owning `docs/design/02-system-design.md`、
`docs/design/03-detailed-implementation-design.md` 与 P4 `01/02/06`、P9 `07`
落地确切合同、迁移和治理记录。接受前不修改 `docs/design/**`。
