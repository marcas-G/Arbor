# Session / Context Runtime 收敛 — 治理裁决记录

## 裁决

**ACCEPTED — 2026-10-01。**

人工治理通过口令
`ACCEPT_SESSION_CONTEXT_RUNTIME_CONVERGENCE` 接受 SCRC-1…SCRC-12，确认
Arbor 的 Session / Context Runtime 应收敛为：

```text
Durable Session Timeline
+ Fresh Canonical Control Snapshot
+ Typed Tool Call/Result
+ Safe Input Promotion
+ Explicit In-loop Compaction
+ Provider-aware Budget Evidence
```

## 固定裁决对象

- 提案：`session-context-runtime-convergence-decision-draft.md`
- 提案 Git commit：`f9e7b99`
- 提案 SHA-256：
  `200D9EE0F252915F1816C57FC5FEE470E77D7FB924A95A7474E03DF68BFAFD05`
- 关联 Design Gap：
  `planning/gaps/SCRC-DG-01-session-context-runtime-convergence.md`

本裁决固定上述提案的精确字节版本。提案后续如有任何语义修改，必须形成新的
修订对象和新的人工裁决；不得把修改后的文件追溯解释为本次已接受内容。

本次为人工治理直接裁决，没有把独立审阅结论冒充接受依据。后续 owning-contract
landing 仍需执行跨文档一致性审计；发现新的并发反例、恢复失败或 Provider
portability 冲突时，必须重新提出 Design Gap。

## 已接受的语义

1. Session Timeline 是认知/执行连续性的 append-only 耐久主干；模型窗口只是其
   projection，不是 canonical truth。
2. Responsibility、Current Work、ResourceBoundary、Permission ceiling、Dependency
   与 Project rules 继续来自 canonical repositories，并通过有版本的 StepContext
   snapshot/delta 投影给模型。
3. Provider 请求采用结构化 `PortableInputItem`；普通 Message、ToolCall、ToolResult、
   ContextUpdate、CompactionCheckpoint 和 AttachmentRef 不再被压成统一文本。
4. ToolCall / ToolResult 必须通过稳定 `callRef` 配对，并保存状态、ObservationRef、
   bounded output 与完整 ArtifactRef。
5. Inbox 通过 source-key 幂等的 Session promotion 完成交接；Session append 与
   Inbox consumed 原子收敛。同一 InboxEntry 不得在每轮 Provider 调用中重复出现。
6. Steer 在当前 Agent Loop 的下一个安全采样边界提升；Queue 在当前 drain 结束后
   FIFO 提升，二者不得混为“所有未消费消息”。
7. 每个 sampling step 一次性捕获一致的 `AgentStepContext`；Tool/Control effect
   admission 仍 fresh re-read ControlBasis 与 authority。
8. `NeedsCompaction` 是 Agent Loop 内部控制动作，不 settle Execution、不改变 Work
   lifecycle；压缩完成后重建同一 pending logical step。
9. Compaction 支持 Arbor Summary 与 ProviderNative 两种实现；Provider-native
   opaque checkpoint 绑定完整 ResolvedModelBinding fingerprint，不兼容时从耐久
   Timeline 回退重建。
10. Context budget 使用真实 Provider usage、model/provider estimator、adapter
    estimator、`chars / 4` fallback 的分层证据；overflow-triggered compact/retry
    最多一次。
11. Permission 不从 Prompt、summary 或 Session text 恢复。继续采用父级分发、
    ResourceBoundary、Grant/policy 与 exact resource 的交集；不采纳独立子 Agent
    自带非父级子集权限的语义。
12. Compaction 和 progressive disclosure 只改变 active model representation；完整
    Timeline、Tool result、Artifact 和恢复证据继续耐久保存。

## 与冻结 DID 的关系

本裁决确认以下既有方向继续有效，不作 supersession：

- `SessionEntry = append-only local sequence`；
- `ContextEpoch = monotonic local ordinal`；
- `Checkpoint preserves cognition; Canonical State restores control`；
- Compaction 是显式、可审计的 Provider 操作；
- `NeedsCompaction` 是 success/control ADT；
- 不可压缩的 Mandatory/Pinned/Protected 固定内容超窗时，
  `ContextUnsatisfiable` 是 typed E；
- Tool 权限由 Runtime effect boundary 强制执行。

需要 owning documents 补足的，是结构化 Session Item、Inbox promotion、
call/result pairing、StepContext/Projector、Compaction resume、native checkpoint
portability 和多级 budget evidence 的机械合同。

## 当前实施门禁

本裁决授权**人工治理**将 accepted semantics 写入拥有语义的
`docs/design/**` 与相应 implementation contracts，并记录 resolving revision。

本裁决本身**不授权**：

- Coding/Planning Agent 修改 `docs/design/**`；
- 修改 `PortableMessage`、Session DDL、Provider wire contract 或迁移；
- 将现有 Session Observation 自动迁移成 ToolResult；
- 消费或重写现存 Inbox；
- 启用 Summary/ProviderNative Compaction；
- 删除 `CompactionRequired` 路径；
- 把 `SCRC-DG-01` 标记为 RESOLVED；
- 宣称 S1–S8 任一实施阶段完成。

只有在 owning design landing、跨文档一致性审计和 Design Gap resolving revision
完成后，才可另行形成 phase/task/TDD 计划并取得实现授权。

## Owning-contract 落字清单

人工治理至少需要落字：

1. System Design：Session Timeline、Canonical Control State、Active Model Window 与
   Tool Authority boundary 的系统不变量；
2. DID Model Context：`PortableInputItem`、`AgentStepContext`、ContextProjector、
   budget evidence 与 adapter capability；
3. DID Session：SessionItem ADT、source-key uniqueness、epoch/checkpoint、projection
   frontier；
4. DID Agent Runtime：Steer/Queue safe boundary、Inbox promotion、NeedsCompaction
   same-step resume；
5. DID Tool Runtime：callRef pairing、ToolResult/ControlResult、ObservationRef/
   ArtifactRef；
6. DID Provider Runtime：Summary/ProviderNative compaction、binding fingerprint、
   provider overflow retry；
7. P9/P12 implementation contracts：promotion、tool settlement、checkpoint 的 crash
   windows、reconciliation 与 bounded retry；
8. 对现有 Context assembly phase results 建立 supersession/compatibility 记录，不能
   静默把旧完成证据解释成新合同已实现。

## 下一状态

```text
SCRC direction: ACCEPTED
Owning design landing: PENDING MANUAL GOVERNANCE
SCRC-DG-01: OPEN
Implementation: NOT AUTHORIZED
```
