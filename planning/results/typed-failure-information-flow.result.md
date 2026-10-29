# 类型化失败信息流结果

**状态：COMPLETE — WAVES 1–5 CLOSED**

## 已完成

- 控制参数解码失败成为可供模型使用的 `ControlResult(Failed)`；
- 模型可以在下一 ProviderTurn 修正参数并继续同一 Execution；
- `AgentActionError { cause: unknown }` 已从 Agent action contract 移除；
- 新 contract 明确区分 `AgentActionRejected` 与
  `AgentActionOperationalFailure`；
- semantic rejection 的 safe code/message/correction 会进入 Session；
- operational native cause 不进入 Session；
- action ledger 持久化 ModelCorrectable / ModelUsable disposition。

## 机械证据

- `tests/p3-driver.test.ts`：无效控制参数回流后第二轮修正并完成；
- `tests/p3-driver.test.ts`：semantic action rejection 回流而不终止；
- `tests/p3-driver.test.ts`：operational handler failure 仍 fail-closed 并持久化
  terminal ControlResult；
- `apps/single-workspace/test/i0-send-message-durable.test.ts`：根 Workspace
  无父级 Report 不产生 Message，失败信息回流后 Agent 改为 durable Wait；
- control / verifier / completion / architecture targeted suites：69/69 PASS；
- TypeScript project + tests：PASS。

## 全量回归

- `pnpm check`：PASS；
- architecture：132/132 PASS；
- core：278 files，1612 PASS / 1 Windows conditional skip；
- Web：31 files，212/212 PASS；
- production Web build：PASS（仅既有 chunk-size warning）。

本结果不把“有 `_tag` 的 unknown cause wrapper”误报为完整 typed error algebra；
native cause 只允许留在 Runtime-private operational failure / adapter diagnostic，
不得进入模型、Problem、Attention summary 或 verifier evidence payload。

## Wave 2 — ToolRuntime

- 原 `ToolRuntimeError { cause: unknown }` 已移除；
- operational stage 明确区分 WorkspaceLookup、EnvironmentResolution、
  AuthorityResolution、ApprovalLookup、IntentJournal、ApprovalConsumption、
  ResourceAdmission、SandboxOpen、Executor、SettlementJournal；
- SandboxClose 使用独立 `ToolRuntimeCleanupFailure`；
- `effectDisposition` 区分 `NotStarted` 与 `OutcomeUncertain`；
- 不确定外部效果通过 `OutcomeUnknown` 进入 reconciliation，不再降级成普通
  Interrupted；
- Sandbox cleanup 不再 `orDie`；
- ToolRuntime / P12 / architecture 定向回归：89/89 PASS。

## Wave 3 — ExecutionDriver

- 原 `ExecutionDriverError { cause: unknown }` 已移除；
- operational / ownership-lost / invariant 三类错误不再混用；
- terminal Provider failure、timeout、ContextUnsatisfiable 等预期终态返回 typed
  `ExecutionSettlement`；
- 所有上述终态先 durable 写入 `SettlementProposed`；
- Provider native diagnostic 与 repository native cause 不进入模型上下文；
- 修复 `prepareTurn` 对 ContextUnsatisfiable 的二次包装；
- P3 / P9 / recovery / architecture 定向回归：172/172 PASS。

## Wave 4 — Repository / Application

- per-repository unknown wrapper 已由 PersistenceUnavailable /
  PersistenceConstraintViolation / PersistenceCorruption 取代；
- retryable unavailable 与 semantic constraint 不再混在同一 error tag；
- Application one-open Verification race 读取 safe constraint fact，不读取 SQL cause；
- Command TerminalRejected 与 persistence failure 保持不同通道；
- retryable persistence failure 写入 CommandAttempt 并保留相同 CommandId retry 语义；
- consumer 遇到 retryable persistence failure 不前移 offset、不 dead-letter；
- persistence / gateway / P7 / P8 / P9 / architecture 定向回归：182/182 PASS。

## Wave 5 — Presentation / Attention / Verifier

- Problem DTO safeDetails 全面脱敏并有确定边界；
- persistence/gateway/projection/post-commit failure 拥有稳定 presentation code；
- UI Problem retry disposition 为封闭 union；
- fetch/config/secret IO diagnostics 不再回显 native error 文本；
- negative / interrupted / uncertain ToolResult 可以作为 Verification evidence，
  但 runtime 会核对 durable settlement，伪造或矛盾状态拒绝；
- ContextUnsatisfiable 正确投影为 Conversation `ContextBlocked` Attention；
- presentation / verifier / Web targeted regression：41/41 PASS。
