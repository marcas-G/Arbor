# P8 — 06 Acceptance Outline (DRAFT for contract review)

**Authority:** DID v1.11 (G2/G4/G5/G6); S1 步骤 9–11, S3 步骤 11–12; DID v1.10 §11 P8; P6/P7 验收风格先例。
**Status:** DRAFT (first draft for contract review)。

全部 deterministic（Fake Provider / 直接命令提交）。

- **Story A — Completion 链闭环**：Producer CompletionClaim（P5 路径 settle）→ Consumer A 自动 StartVerification（deterministic CommandId、重放幂等）→ Verifier spawn（ExecutionBound、无 parentExecution、workerKind Verifier）→ Record Evidence ×2 → Conclude(Pass)（criterion 聚合纯函数验证）→ Parent AcceptWorkOutcome → Consumer B 自动 CompleteWork → `WorkCompleted` + currentWorkId 原子清除；Work 全程 revision 不变、绑定链 (workId, revision, verificationId) 断言。
- **Story B — FAIL 返工不换人**：Conclude(Fail) → VerificationReturned wake → Producer Workspace reevaluate（断言 wake 与 reason）；旧 Agent 语境保留（无新 Work/无换人）；Verifier 对 Producer 正式结果零写（L5：写尝试被拒的沙箱断言）。
- **Story C — UNKNOWN 一等**：criterion 证据不足 → 聚合 Unknown；wake 仍 VerificationReturned；不产生 FAIL 语义/不触发返工分支断言；无自动 PASS。
- **Story D — revision 失效**：Verification PASS 后 RefineWork → 旧 Verification/Acceptance 保留但不适用；AcceptWorkOutcome（旧 revision）→ 拒绝；新 revision 重新链路。
- **Story E — mission/P7 集成**：占位 mission → Start 拒绝（typed）；RefineWork 补 mission → 通过；targetDeliverables 绑定 P7 不可变 deliverable（sourceWorkRevision 一致性校验、不一致拒绝）；可执行 mission → environmentRevision 必填断言。
- **Story F — Program 版本纪律**：P9 Verification Program + P14 Query/Inspection Program（v1.11 G6 已裁归 P8）v1 头字段/hash/eval 门/篡改负例（P6 D4 模式复制）；P14 read-only 契约负例（查询结果改 canonical 状态→违禁）。
- **Story G — owner snapshot（v1.11 G4）**：StartVerification 记录 owner snapshot；目标 Workspace retire 后 Verifier 不被自动 abort（自然结论）；无法继续 → Unknown(Orphaned) 治理结论 → re-Start 新 identity 用当前 owner。
- **补断言（round-2）**：Story A 中 Conclude(Pass) 也释放通道 1（VerificationChanged wake 断言）；同 revision 第二次 StartVerification → `VerificationAlreadyOpen` typed 拒绝；孤儿流：Unknown(Orphaned) 事件载荷含 conclusionReason、re-Start 新 verificationId。
- **机械断言**：五命令事件序列与拒绝集=契约；verdict immutable；verifier-only 两命令的 authority 越权拒绝；consumer 不绕过 handler（fingerprint 因果链）；P5/P6/P7 回归护栏全绿。
