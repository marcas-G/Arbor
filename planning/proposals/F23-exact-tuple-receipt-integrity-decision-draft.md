# F23 Exact-Tuple Receipt Integrity — Governance Decision Draft

状态：**DRAFT / 等待人工治理审议**
关联：**FT-DG-03 / exact-tuple receipt-integrity boundary**
实施：**未授权**（本文件只为固定治理候选及隔离 RED 提供证据）
建议接受标识：`DECIDE_F23_EXACT_TUPLE_RECEIPT_INTEGRITY`

## 决策范围

F23 已接受合同与 P1 tuple-first landing 要求：Gateway 在现有 `BEGIN IMMEDIATE`
事务中读取 raw resolution/tuple，先比较
`(semanticRequestFingerprint, Handler.schemaVersion,
fingerprintAlgorithmVersion)`；任一不同即走现有
`TerminalRejected(IdempotencyConflict)`，不解释或披露 result/error JSON，行不变。
只有 exact tuple 才能进入本稿建议固定的结果/拒绝解码。

本稿建议将 exact-tuple 解码定义为按已注册 `commandType` 与该 Handler 的
`schemaVersion` 选择的严格 runtime decoder：

1. `Committed` 必须先 JSON 解析，再满足该当前命令/版本完整结果 DTO 的运行时结构。
2. `TerminalRejected` 必须先 JSON 解析，再满足完整 `CommandRejection` 联合成员及字段。
3. 当前 registry 未知命令、缺少 decoder、未知 schema version、非法 JSON、错误
   resolution / 空字段或错误 DTO 形状均 fail closed。
4. 精确 tuple 的语法或形状错误作为非命令持久化完整性故障返回既有
   `PersistenceCorruption<"CommandStore">`（固定安全 reason，不包含原始 JSON、错误文本或
   行内容），外部走已存在的非重试 `persistence/corruption` Problem；Gateway 不得把它
   变成 `TerminalRejected`、`CommandRejection`、`AuthorityDenied` 或 retryable attempt。
5. Agent Runtime 的调用点把它作为 operational failure 处理，不能成为模型可修正的
   `AgentActionRejected`。解码失败不调用 handler、不写/修复 receipt、不写 canonical
   state、Event、CommandAttempt 或 Observation；原行字节保持不变。

这些是建议人工裁决的实现合同，不是当前能力声明。Tuple-first 已接受并落地的比较顺序
不变；本稿不改 codec、Resolver、Authority、fingerprint、wire-v1、DDL、migration、旧
ID 安全非重放或历史行。Schema/algorithm 不同仍先得到 IdempotencyConflict，不因坏 JSON
跳去 exact-tuple decoder。历史 schema 没有当前注册的匹配 decoder 时也 fail closed；不得
猜测旧结构、降级成当前 decoder、改写或修复旧行。P1 `07` AH10 direct-child
AssignWork receipt-first recovery 仍需 its exact binding / authority evidence；本稿不以
新 decoder 取代这些证明。

## 已有能力与需治理的边界

`packages/application/src/command-receipt.ts` 目前对原文执行
`JSON.parse(...) as R` / `as CommandRejection`，没有 schema/shape validation。语法坏会抛出
未类型化异常，合法 JSON 错结构会通过类型断言。`packages/application/src/gateway.ts`
已有 tuple-first 分支，exact match 才调用该 decoder；mismatch 不触碰 decoder。
`packages/ports/src/errors.ts` 已有 `PersistenceCorruption` 与
`CommandStoreError`，`apps/single-workspace/src/transport/errors.ts` 已将该错误映射为
非重试 `persistence/corruption` Problem。以上映射不表示 decoder 已调用该 typed failure。

当前命令 result 是 TypeScript 接口，不是 runtime schema；`CommandRejection` 是
`DomainError` + Application-owned variants 的联合。可复用 Domain `ID_SCHEMAS` 及适当的
小型 Domain value schemas 作为字段子 schema；不能用 Domain Event schemas 代替命令结果。
本树未见覆盖当前 26 个注册命令 result 的 runtime decoder，也未见完整拒绝联合的
runtime validator。

### 当前 26 个可达命令及结果 decoder 缺口

当前所有下列 Handler schemaVersion 均为 `"1"`。每行给出的源码接口是现有静态结果合同；
每项 decoder 状态均为 **缺失**。这张清单只涵盖 DID §4.1B 的 26 个当前 registered
commands；P11 的 factory-only CreateWorktree/RetireWorktree 及其他 factory-only 命令不在
本资格范围。结果不能因其字段与某个 Event 相似而复用 Event schema。

| Command | 静态结果 DTO / 当前字段 | 现有源码 owner（结果接口） | Runtime result decoder |
|---|---|---|---|
| `CreateProject` | `CreateProjectResult`: projectId, rootWorkspaceId, primarySessionId | `packages/application/src/commands/create-project.ts` | 缺失 |
| `CreateChildWorkspace` | `CreateChildWorkspaceResult`: workspaceId, projectId, parentWorkspaceId, primarySessionId | `packages/application/src/commands/create-child-workspace.ts` | 缺失 |
| `AssignWork` | `AssignWorkResult`: workId, workspaceId, lifecycle=`Open`, revision | `packages/application/src/commands/assign-work.ts` | 缺失 |
| `RenameProject` | `RenameProjectResult`: revision, name | `packages/application/src/commands/project-management.ts` | 缺失 |
| `CloseProject` | `CloseProjectResult`: revision, lifecycle=`Closed` | `packages/application/src/commands/project-management.ts` | 缺失 |
| `SelectCurrentWork` | `SelectCurrentWorkResult`: workspaceId, workId, revision | `packages/application/src/commands/select-current-work.ts` | 缺失 |
| `AdmitExecution` | `AdmitExecutionResult`: executionId, workspaceId, sessionId, bindingKind=`WorkspaceMain\|ExecutionBound` | `packages/execution-runtime/src/commands/admit-execution.ts` | 缺失 |
| `StopExecution` | `StopExecutionResult`: executionId, stopRequestedAt | `packages/execution-runtime/src/commands/stop-execution.ts` | 缺失 |
| `SettleExecution` | `SettleExecutionResult`: executionId, `ExecutionSettlement` | `packages/execution-runtime/src/commands/settle-execution.ts` | 缺失 |
| `SendMessage` | `SendMessageResult`: messageId, admitted=`true`, promotion `{closesCorrelation:string|null,triggersReevaluation:boolean}` | `packages/application/src/commands/send-message.ts` | 缺失 |
| `DeclareDependency` | `DeclareDependencyResult`: dependencyId, consumerWorkId, state=`Unsatisfied`, revision | `packages/application/src/commands/declare-dependency.ts` | 缺失 |
| `ProduceDeliverable` | `ProduceDeliverableResult`: deliverableId, sourceWorkId, sourceWorkRevision, kind, artifactRoles[] | `packages/application/src/commands/produce-deliverable.ts` | 缺失 |
| `SatisfyDependency` | `SatisfyDependencyResult`: dependencyId, state=`Satisfied`, dependencyRevision, deliverableId, satisfiedAtDependencyRevision, wakeSignals[] | `packages/application/src/commands/satisfy-dependency.ts` | 缺失 |
| `RecordDecision` | `RecordDecisionResult`: proposalId, proposalRevision, decision=`Approve\|Reject\|Modify`, proposal state | `packages/application/src/commands/record-decision.ts` | 缺失 |
| `ResolveControlApproval` | `ResolveControlApprovalResult`: approvalId, executionId, state=`Approved\|Rejected`, revision | `packages/application/src/commands/resolve-control-approval.ts` | 缺失 |
| `SteerWork` | `SteerWorkResult`: workId, workspaceId, lifecycle=`Open`, fromRevision, toRevision, severity=`Normal\|Critical` | `packages/application/src/commands/steer-work.ts` | 缺失 |
| `AcceptWorkOutcome` | `AcceptWorkOutcomeResult`: acceptanceId, workId, targetWorkRevision, verificationId | `packages/application/src/commands/accept-complete.ts` | 缺失 |
| `CompleteWork` | `CompleteWorkResult`: workId, workspaceId, lifecycle=`Completed`, revision, clearedCurrentWork | `packages/application/src/commands/accept-complete.ts` | 缺失 |
| `StartVerification` | `StartVerificationResult`: verificationId, workId, targetWorkRevision, ownerWorkspaceId, state=`Open`, verifierExecutionId | `packages/application/src/commands/start-verification.ts` | 缺失 |
| `RecordVerificationEvidence` | `RecordVerificationEvidenceResult`: verificationId, evidenceId, state=`Recorded` | `packages/application/src/commands/conclude-verification.ts` | 缺失 |
| `ConcludeVerification` | `ConcludeVerificationResult`: verificationId, state=`Concluded`, verdict, summaryRef, conclusionReason, wakeSignals[], channel1Release | `packages/application/src/commands/conclude-verification.ts` | 缺失；见下方语义缺口 |
| `GrantPermission` | `GrantPermissionResult`: permissionGrantId, PermissionGrantLifecycle state | `packages/application/src/commands/grant-permission.ts` | 缺失 |
| `RevokePermission` | `RevokePermissionResult`: permissionGrantId, PermissionGrantLifecycle state | `packages/application/src/commands/revoke-permission.ts` | 缺失 |
| `SubmitHumanMessage` | `SubmitHumanMessageResult`: messageId, HumanMessageRecord state | `packages/application/src/commands/submit-human-message.ts` | 缺失 |
| `ResumeConversationResponse` | `ConversationResponseCommandResult`: messageId, state=`Queued\|Cancelled`, revision | `packages/application/src/commands/conversation-response.ts` | 缺失；共享接口 |
| `CancelConversationResponse` | 同上 DTO：messageId, state=`Queued\|Cancelled`, revision | `packages/application/src/commands/conversation-response.ts` | 缺失；共享接口 |

### 必须先裁决的结果序列化细节

`ConcludeVerificationResult.conclusionReason` 的 TypeScript 类型是必需属性
`ConclusionReason | undefined`，但 JSON 序列化会省略 `undefined` 属性。因此持久 JSON
形状并非该接口的普通必需字段形状。治理/实现必须选择并记录：持久 DTO 将其定义为
optional/absent，或 decoder 在解码后显式重建 `undefined`。不能直接以 TS interface
推定持久形状。

严格 shape 还需要明确当前 schema 对额外字段的处理和对象完整性；本候选建议 schema v1
只接受所拥有的字段（无额外字段）以便确定性 fail closed。若某个结果 DTO 的历史 writer
曾合法生成不同 JSON 结构，则先形成专门兼容性证据和治理决策，不能猜测兼容规则或放宽
全部结果。当前没有证据显示存在其他不能确定的核心字段语义；以上
`ConcludeVerificationResult` 的 absent/undefined 差异必须在任何“26/26 decoder closed”
声明前明确处理。

## CommandRejection runtime union

`packages/application/src/rejection.ts` 定义当前拒绝类型。严格 decoder 必须穷尽并校验
每个变体的字段，而不仅是 `_tag`：

- Domain union，owner `packages/domain/src/errors.ts`：`IdempotencyConflict(commandId)`、
  `AuthorityDenied(reason)`、`RevisionConflict(expected,actual)`、`InvalidProjectName(reason)`、
  `WorkNotOpen(workId)`、`TerminalLifecycleMutation(entity,lifecycle)`、
  `RetirePreconditionFailed(workspaceId,reason)`、`ActiveExecutionConflict(workspaceId)`、
  `VerificationAcceptanceMismatch(workId)`、`DependencyNotSatisfiable(dependencyId)`、
  `PermissionRevoked(permissionGrantId)`、`WorkPlanInvalid(reason)`。
- Application union，owner `packages/application/src/rejection.ts`：`FencingRejected`、
  `ExecutionStopping`、`WorkspaceNotFound(workspaceId)`、`ExecutionNotFound(executionId)`、
  `WorkNotFound(workId)`、`FormationProposalNotFound(proposalId)`、`ResourceExhausted(reason)`、
  `DependencyNotFound(dependencyId)`、`DeliverableNotFound(deliverableId)`、
  `VerificationAlreadyOpen(workId)`、`InvalidVerificationMission(reason)`、
  `VerificationNotFound(verificationId)`、`AcceptanceAlreadyExists(workId)`、
  `WorktreeNotFound(worktreeId)`、`WorktreeAlreadyExists(worktreeId)`、
  `WorkspaceNotActive(workspaceId,lifecycle=Retired)`、`WorktreeAlreadyRetired(worktreeId)`、
  `ActiveClaimsExist(worktreeId,claimIds[])`。

这些被 TypeScript 联合类型确认，但当前无运行时联合 validator。字段 ID 可复用对应
`ID_SCHEMAS`；`RevisionConflict` 应验证有限合法 revision 值。不得把腐坏联合转成任何
一个看似语义拒绝的成员。

## Error / Attention boundary

已存在 `PersistenceCorruption<"CommandStore">`、transport
`problemFromCommandFailure` 的非重试 `persistence/corruption` Problem，以及
`AgentActionOperationalFailure` 路径。落地实现应复用并验证这些路径，不把 parse/schema
细节放入 `reason`，不调用 `recordRetryableAttempt`。

**P10 持久 Attention 保留为独立 OPEN。** `docs/design/implementation/P10/02-attention-readmodel.md`
当前列出 Runtime Safety Envelope、Recovery escalation、AssignWork binding failure 等
事实源，没有通用 CommandStore receipt corruption source。`PersistenceCorruption` →安全
Problem / Agent operational failure 的建议，不等于 P10 durable Attention。不得新增
P10 `AttentionSource`、伪用 AssignWork recovery fact 或把普通错误投影为运行时安全停止。若
治理要求每个 exact-tuple receipt corruption 必须成为持久 Action Required/Attention，须
另由 P10/系统治理定义 source、dedup identity、target、durability 与 no-repair 行为后再实现。

## 隔离 RED 资格与实施后 GREEN 矩阵

新测试仅留在 `tests/functional/pending/`，由 pending 专用配置运行，不进入当前
`pnpm test:functional` 默认绿套件。污染行是通过 `commands` DDL/raw SQL 注入的历史/损坏
fixture，绝不是正常 writer 产物。现有 tuple-ordering 测试已覆盖坏 JSON + tuple mismatch；
本次新增 exact tuple 语法合法但 shape 不合法，覆盖更窄的缺口。

| Case | Fixture/入口 | 当前期待的 RED | 实施后 GREEN 必须断言 |
|---|---|---|---|
| Exact Committed shape | 当前 `SubmitHumanMessage` v1，stored result 为合法 JSON `{}`，候选 tuple exact；HTTP `/commands` | 当前会将 `{}` 当 Committed result 返回 | 非重试安全 `persistence/corruption` Problem；不包含行/JSON/sentinel；原 tuple/result bytes 不变，无 receipt 写、attempt、Event、handler/domain write |
| Exact TerminalRejected shape | 同命令 v1，stored terminal error 为合法 JSON `{ "_tag": "AuthorityDenied" }`（缺 required `reason`），候选 tuple exact | 当前会将错误 cast 为 `CommandRejection` 并作为 TerminalRejected 返回 | 同上 typed corruption Problem；不得成为 `AuthorityDenied` 拒绝，原 error bytes 不变，无 attempt/Event/write |
| AH10 prior Committed result | `assignWorkHandler` generation takeover：generation-0 prior receipt 精确 command id / project，合法 JSON 但缺 `lifecycle`/`revision`；generation-1 运行同 pinned action | 当前 receipt-first 路径只检查 prior result 的 `workId` 和 `workspaceId`，可据不完整结果返回 Observation(success) | decoder 失败为 `AgentActionOperationalFailure`；不得 Observation、不得调用新 handler/Command、不得改旧 receipt/产生 event/attempt；保留现有 exact target/binding/Grant/Approval proof requirements |
| Tuple precedence control | 现有 `tests/functional/process/f23-receipt-tuple-ordering.functional.test.ts` | 已由 tuple-first landing 覆盖；不是本次 RED | schema/fingerprint/algorithm 每个 mismatch 即使 JSON shape/syntax 错，仍 IdempotencyConflict，不解码/不披露，不改历史行 |
| Decoder parity | current 26 registered command handler registry | 当前缺 26 runtime result schemas 与 complete rejection validator | 每一 current `(commandType, schemaVersion)` 有 positive valid receipt fixture 与 wrong-shape/missing-field/tag/ID/enum tests；unknown version/registration fails closed |
| Future history | older schema/algorithm tuple | 当前 tuple comparator已覆盖 mismatch | 先 mismatch；只 exact tuple选择该版本 decoder。无该旧版 decoder必须 operational fail-closed，不repair、不fallback至 current DTO |

外部两个 RED 仅断言 public result、Problem 不泄露和 receipt side-effect postconditions；AH10
RED 经现有 `assignWorkHandler` 的公开 runtime action handler 调用，断言不产生 success
Observation；不通过 P1 Gateway 去绕过 Recovery 证明。测试不应断言新增 P10 Attention。

## Owner、顺序和停工条件

- DID v1.34 §4.1B：高层 exact-tuple fail-closed 已冻结；若治理要固定错误语义细节，按
  owner 文档接受精确变更。Tuple mismatch 优先级不得改。
- `docs/design/implementation/P1/01-command-contracts.md`：Receipt result/error 解码键、
  exact shape 与 decoder 不存在时行为。
- `docs/design/implementation/P1/02-port-contracts.md`：维持 raw `StoredCommandResolution`
  与 no-parse Port；corruption mapping/error type 的 Port 边界。
- `docs/design/implementation/P1/03-transaction-model.md`：exact tuple decode 在原事务；
  失败不走 receipt/domain/event/attempt 写入及旧行修复。原有线性化点不变。
- `packages/application/src/command-receipt.ts` 与 `packages/application/src/gateway.ts`：
  之后实现 decoder registry、typed decode failure；不属于本稿的生产修改。
- `apps/single-workspace/src/transport/errors.ts`：沿用既有错误映射并测试非重试/安全输出。
- P10 `docs/design/implementation/P10/02-attention-readmodel.md`：只有用户/治理另行接受
  持久 Attention source 后才扩展；当前保持 OPEN。

若某个当前 handler 的持久结果 contract 不能从它的 accepted owner 与既有写入确定，暂停该
命令 decoder 合资格并申请 Design Gap；不得把 Event payload schema当结果、不得以“解析为
object/存在 `_tag`”替代完整 DTO。特别是 `ConcludeVerification` 的
`conclusionReason`/JSON omission 需先锁定 schema v1 持久语义。

本稿为 **DRAFT**，不是接受记录，不更新 `ACCEPT_EXTERNAL_COMMAND_RUNTIME_CODEC` 的
accepted SHA，不修改 `docs/design/**`，不授权或宣称实施完成。用户 standing 授权仅允许在
本候选独立复审 Blocking=0 后再直接落设计/实施；本提交仅承载候选、隔离 RED 与结果说明。
