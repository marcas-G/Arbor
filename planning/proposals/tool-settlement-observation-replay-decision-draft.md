# Tool settlement 与 AgentLoop Observation 的可重放交接 — 治理决策稿

状态：**DRAFT / 等待人工治理接受**

缺口：`AH7-DG-01`

实施：**尚未授权**

建议接受标识：`ACCEPT_TOOL_SETTLEMENT_OBSERVATION_REPLAY`

## 建议决定

P4 每个 terminal ToolInvocation settlement 必须在**同一语义事务**中持久化模型
可见的 bounded Observation（text/truncated）、其格式版本与内容哈希，或指向同一
内容的不可变 content-addressed 引用。`Success`、`ExpectedFailure`、
`Interrupted`、`RuntimeFailure` 与 `OutcomeUnknown` 均需有可判定的回放合同；
已知的 terminal outcome 不因观察文本缺失被改写成 OutcomeUnknown。

AgentLoop 在同一调用重入时，先用 exact `executionId + invocationId`、工具身份、
参数、资源区域与 approval 身份验证 P4 记录，再从该结算证据重建原
CanonicalToolObservation。随后按稳定 `(providerTurnId, callRef, resultRef)` 源键
幂等写入 Session ToolResult、Action disposition 和 cursor。已结算调用禁止再次
执行外部 effect。大的原始结果仍可由 Artifact 承载；bounded Observation 与
Artifact 是不同语义，不得用当前文件/服务状态推断历史文本。

历史记录若没有足以重建原观察的证据，Runtime 应给出类型化
`ToolObservationReplayEvidenceMissing`（名称待 owning DID 最终确定）并持久化
Attention/受控中断；不得合成成功或把已知 settlement 伪装成未知外部效果。
若历史 AgentLoop 已有 exact sourced ToolResult，可以先以该权威记录收敛，不能
仅凭 Session 自由文本猜测结果。

## 验收

- 让 pending `ExpectedFailure` 重入用例通过，且 executor/settlement 写入次数均为零。
- 真实进程在 P4 `ExpectedFailure` settlement 提交后、AgentLoop Observation 提交前
  kill/restart，Session 恰一条原观察、Action/cursor 恰一次收口。
- 对每个 terminal tag 测相同重入身份与证据缺失分支；不同 identity/ref/hash
  失败关闭，不能读取别的 Execution 的结果。
- 验证 Success + Artifact 的现有回放不回归，并覆盖 Artifact 丢失、无效引用、
  旧版记录，以及 `pnpm check`/完整 `pnpm test:functional`。

若接受，仅在拥有语义的 `docs/design/02-system-design.md`、
`docs/design/03-detailed-implementation-design.md`、P3 `08`、P4 `01/06/07`、
P9 `07` 落字并保留提案哈希、版本与一致性审阅；接受前不实施新字段。
