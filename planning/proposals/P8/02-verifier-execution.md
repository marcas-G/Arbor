# P8 — 02 Verifier Execution (PROPOSAL)

**Authority:** DID v1.10 §11 P8, §10.4.1 (verification-runtime deps = domain/ports/application), §12.10 (verification + application 双边界), §8.4 (P9 Verification Program), §8.4A; v1.7 G5; SD v1.3 §9.2/§9.3/§13.10; 不变量 25/44; P2 `01` §5, P6 `01` §3 (spawn 模板), P3 `05`/`07`, P6 `05` (D4 版本模型)。
**Status:** DESIGN CLOSURE DRAFT。

## 1. Spawn（generic admission 之上的 P8 语义）

```text
StartVerification payload 携带 caller-preallocated verifierExecutionId
  （v1.7 G5 "all IDs are caller-preallocated" 冻结语；crash-recovery 关键——见下）
  → commit
  → VerificationRuntime spawn：AdmitExecution { _tag: "ExecutionBound",
        executionId: 上述预分配 id,
        workspaceId: 目标 Work 所属 Workspace（B-8/GQ7 待治理确认）,
        parentExecutionId: 无（Verifier 不挂 Producer Execution——隔离从 binding 开始）,
        mission: verification digest, sessionId: caller-preallocated }
  → 经 CommandGateway（application 通道；不 import execution-runtime——§10.4.1）
  → verificationExecutionIds 回填（RecordVerificationEvidence 的 authority 绑定源）
```

**Crash 恢复（round-1 修订，消 spawn 窗口）**：spawn 与回填是 StartVerification 之后的幂等步骤——replay 路径按 (workId, workRevision) 查 Open Verification：`verificationExecutionIds` 未回填且该 executionId 无 durable Execution → 重新 spawn（同 executionId，AdmitExecution 幂等）；已回填 → no-op。不存在"commit 后永久无 Verifier"窗口。

- **归属裁决（B-8）**：Verifier ExecutionBound execution 的 owning workspace = 目标 Work 所属 Workspace（工具/沙箱边界在该 Workspace 资源面内运行，L5 物理隔离见 §2）；binding 不挂 parentExecutionId（与 P6 specialist 的差异：Verifier 与 Producer Execution 无因果链——Producer/Verifier 分离从结构开始）。
- WorkerDispatch `workerKind: "Verifier"`（P0/P2 预留）驱动；P6 specialist spawn 为实现模板。
- 无并发上限（v1.7 G5；多 criterion 并行 Verifier 允许，`verificationExecutionIds` 数组承载）。

## 2. Producer/Verifier 隔离的三层强制落点（不变量 25，§6.2 L2+L4+L5）

| 层 | 落点 |
|---|---|
| L2 | Verifier 的 canonical 提交面仅两命令（Record/Conclude）+ 只读观察；无任何 Work/Dependency/Deliverable mutation 命令的 verifier authority 变体 |
| L4 | Verifier Execution 的 tool 调用走 InvokeTool（P4 管线）；其 verification 任务上下文禁止携带 Producer Session 内容（Context 编译来自 mission + artifacts + read-only observations） |
| L5 | Sandbox 资源面：Verifier 工具写权限限制在临时验证 Artifact 区（blob 写 + 专用前缀）；不得写 Producer 正式 Artifact/资源（P4 SandboxPort 的路径策略收紧点，`04` §4） |

- "Verifier judges; Producer fixes; Parent accepts."（SD §9.3）——FAIL 结论回流 Producer（`03` §3），修复永远是 Producer 认知。

## 3. Verifier 回流

- Verifier Execution settle → 结论路径只有 ConcludeVerification（命令）；settlement 本身不直接写 Verification 聚合（与 P6 specialist-settlement 的 Inbox 模式不同——Verifier 的产物是**结论命令**而非观察；settle-without-conclude 属 Verifier 执行失败 → Verification 保持 Open + Attention 记录（L6），不自动 Unknown——"没有发现问题不能自动等价于 PASS"（S1 步骤 9）也不自动 UNKNOWN）。
- 长时未结论：不设 P8 定时器（durable timer 归 P2/P12）；契约只冻结"Open Verification 不阻塞其他任何链路"。
- **Verifier 长调查的连续性（round-1 补）**：Verifier Execution 可用 P2 通用 `Yield(waitSpec)` 暂停恢复（ExecutionScoped Session admission 时固定 + P5 slice-continuity 同机制免费支撑跨执行调查）；Yield 不结论、不产生 verdict 语义。孤儿 Open Verification（settle-without-conclude 后无人再驱动）→ Attention 记录；再驱动经显式 re-Start（新 identity）消化（GQ8 可选裁决）。

## 4. Verification Program family（DID §8.4 P9）v1 + 版本模型

- 正文骨架必备条款（P8 契约冻结，§13 表授权）：调查计划制定、证据优先（工具观察 > 文档 > 假设）、criterion 级如实三值（禁"没发现问题=PASS"）、边界案例与反例构造职责、UNKNOWN 的证据不足表述义务、禁止修改 Producer 结果的自我指令。
- 版本模型：直接套用 P6 `05` D4 双层（contractRevision 治理门 / textVersion+hash+eval 强制重跑）；Manifest 引用 hash（P3 模式）。
- eval 集（每 Program 至少）：E1 结构遵从（载荷落冻结 ADT）、E2 判据召回（criterion 全覆盖/如实三值）、E3 禁止条款（越权修改/自动 PASS）、E4 版本回归——Fake Provider deterministic。

## 5. Must Not Decide

- No AdmitExecution 语义修改（P2）；No agent-runtime/execution-runtime 依赖（§10.4.1）。
- No Producer Session 复制进 Verifier Context；No verifier 对 Producer 正式结果的写通道。
- No sub-execution 嵌套实现（留缝，B-9）；No 定时器/超时语义（P2/P12）。
