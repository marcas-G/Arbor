# Session / Context Runtime 收敛 — Owning Contract 人工落字包

## 状态

**READY FOR MANUAL GOVERNANCE APPLICATION / 不授权 Agent 直接修改 `docs/design/**`。**

日期：2026-10-01。

本文件把已接受的 SCRC-1…SCRC-12 转写为可直接应用到 owning design 的精确
变更包。它仍位于 `planning/`，不是冻结设计源，也不授权代码或 migration。

固定输入：

- 提案：`session-context-runtime-convergence-decision-draft.md`
- 提案 SHA-256：
  `200D9EE0F252915F1816C57FC5FEE470E77D7FB924A95A7474E03DF68BFAFD05`
- 人工裁决：`session-context-runtime-convergence-governance-decision.md`
- Design Gap：`SCRC-DG-01-session-context-runtime-convergence.md`

## 1. 建议版本与应用顺序

建议由人工治理按以下顺序落字：

1. `docs/design/02-system-design.md`：v1.3 → **v1.4**；
2. `docs/design/03-detailed-implementation-design.md`：v1.21 → **v1.22**；
3. `docs/design/implementation/P2/02-port-contracts.md`；
4. `docs/design/implementation/P2/04-sqlite-schema.md`；
5. `docs/design/implementation/P2/06-recovery-skeleton.md`；
6. `docs/design/implementation/P3/01-provider-contracts.md`；
7. `docs/design/implementation/P3/02-model-context-contracts.md`；
8. `docs/design/implementation/P3/03-agent-loop-driver.md`；
9. `docs/design/implementation/P3/04-sqlite-schema.md`；
10. `docs/design/implementation/P3/08-agent-loop-step-handoff.md`；
11. `docs/design/implementation/P4/02-tool-runtime-pipeline.md`；
12. `docs/design/implementation/P9/04-provider-tool-hardening.md`；
13. `docs/design/implementation/P9/07-agent-loop-step-recovery.md`；
14. `docs/design/implementation/P12/08-runtime-safety-completion.md`；
15. `docs/design/implementation/P12/12-providers-tools.md`。

人工 landing commit 应在本文件、治理裁决和 SCRC-DG-01 中记录。完成跨文档审阅
前，不得把 Design Gap 标为 `RESOLVED`。

## 2. System Design v1.4 精确变更

### SD-1 — 文档头与治理历史

建议头部改为：

```markdown
**Version:** 1.4
**Status:** FROZEN — Session / Context Runtime convergence governance patch
**Supersedes:** v1.3
**Date:** 2026-10-01
```

在既有 governance changes 后增加：

```markdown
**Governance changes (v1.3 → v1.4):**

- SCRC-1/2/12: Session is an append-only durable cognitive/execution timeline;
  the active model window is a lossy projection. Canonical control state remains
  outside Session and is freshly snapshotted/reinjected.
- SCRC-3/4: model/provider interaction preserves typed Message, ToolCall,
  ToolResult, ContextUpdate, AttachmentRef and CompactionCheckpoint semantics;
  every ToolResult is paired to a stable callRef.
- SCRC-5/6: Inbox delivery becomes a one-time durable promotion into Session;
  Steer and Queue have distinct safe-boundary delivery semantics.
- SCRC-7: every sampling step captures one consistent AgentStepContext for
  context/tool visibility/provenance; effect admission still fresh-checks
  canonical control and authority.
- SCRC-8/9/10: compaction is an explicit in-loop Provider operation with Summary
  and binding-bound ProviderNative implementations, same-step resume, and
  provider-aware budget/overflow evidence.
- SCRC-11: permission remains a Runtime authority fact and is never recovered
  from transcript, summary, checkpoint or model text.
```

### SD-2 — 替换 §3.6 Session

建议替换为：

```markdown
## 3.6 Session

每个 Responsibility-bound Agent 默认拥有一个长期 Primary Session，跨多个 Work
持续存在。Primary Session 是 Workspace 对未来 Execution 的默认认知入口；已经
admission 的 Execution 使用固定 Session binding，不随 Primary Session replacement
漂移。

Session 拥有 append-only durable Timeline，用于保存认知与执行连续性：Human/
Steer/Inbox input、Assistant output、typed ToolCall/ToolResult、ControlResult、
ContextUpdate、AttachmentRef 与 CompactionCheckpoint。Timeline 是审计/恢复事实；
Provider Context 只是从当前 ContextEpoch、checkpoint、recent frontier 和 canonical
control snapshot 构造出的 active projection。

Session 负责：局部认知连续性、交互历史、tool-call correlation、input promotion
结果、Cache affinity、ContextEpoch 和 continuation checkpoint。

Session 不是领域真相，也不保存 Responsibility、Current Work、Permission、
Dependency、Verification 或 Resource Ownership 的权威副本。这些事实在每个 sampling
step 从 canonical state fresh capture；Compaction 后重新注入。

Session Timeline 可重放但不要求原样全部进入模型；active model window 可以有损压缩，
durable Timeline、完整 Tool Result 与 Artifact 仍保留。
```

### SD-3 — 替换 §5.4–§5.6 的核心段落

建议规范文本：

```markdown
## 5.4 Long-lived Primary Session

Work 完成后 Session 不销毁。Session lifetime 接近 Workspace/Agent lifetime；模型实际
看到的是 durable Session Timeline、canonical state、Knowledge 与当前输入的动态投影。

Session Timeline != Provider Context != Canonical State

## 5.5 Context Construction

每个 sampling step 先捕获一个一致的 AgentStepContext，固定 execution/session/epoch、
canonical control refs/revisions、model binding、effective tool catalog、instruction
sources、input frontier 与 budget basis。Context Projector 再从该快照和 active Session
frontier 生成 provider-neutral typed input items、tool definitions 与 manifest。

硬控制事实确定性注入；软历史按需检索。ToolCall/ToolResult 必须保留 callRef；被截断
的 ToolResult 必须保留 ArtifactRef 与 truncation/epistemic status。

Effect admission 不信任旧快照作为授权缓存：真正执行 Tool/Control Action 时仍 fresh
re-read ControlBasis、authority、ResourceBoundary 与 exact resources。

## 5.6 Context Compaction

Compaction 只替换 active model representation，不删除 durable Timeline，也不承担保存
领域真相。普通 context pressure 是 Agent Loop 内部控制动作：显式启动 Compaction
Provider operation，耐久提交 checkpoint + next ContextEpoch，fresh reinject canonical
control，然后继续同一个 pending logical step。

Compaction 支持 Arbor Summary 与 ProviderNative 两类实现。Provider-native opaque
checkpoint 必须绑定完整 model/deployment/protocol binding；不兼容时从 durable
Timeline 走 portable Summary/recent-frontier rebuild。

Pinned/Protected fixed control 本身在允许的 model policy 下仍无法装入窗口时，才形成
ContextUnsatisfiable。普通可压缩历史压力不得停止 Work/Execution 或要求用户手动重试。
```

### SD-4 — 替换 §7.4/§7.5 的 Inbox 消费边界

建议规范文本：

```markdown
## 7.4 Inbox

Inbox 表示尚未被目标 Workspace 的 durable Session/确定性 Runtime 接管的重要输入，
不是永久历史库，也不是每轮 Provider Context 的直接来源。

一个需要 Agent 认知的 InboxEntry 在 safe boundary 通过稳定 source key 幂等提升为
Session Input；Session append 与 Inbox consumed 原子收敛。consumed 只表示 Session
已经耐久接管并可重放，不表示模型已正确理解、业务已完成或 canonical state 已改变。

## 7.5 Input Admission / Promotion / Consumption

Admission 验证并持久化来源；deterministic promotion 提交可直接推导的 canonical
后果；cognitive delivery 把需要判断的输入一次性提升到 Session Timeline。

Steer 在当前 Agent Loop 下一个 safe sampling boundary 提升；Queue 在当前 drain
结束后 FIFO 提升，并且一次提升一条后重新判断 continuation。普通消息到达不抢占，
Critical Steer/Stop 继续遵循 quiescence 规则。

Receive != Deterministic Promote != Session Delivery != Business Completion
```

### SD-5 — Runtime 组件边界增补

建议在 §13 增补：

- Agent Runtime：拥有 safe-boundary input drain、AgentStepContext capture、同一步
  Compaction orchestration 与 typed ToolCall/Result continuation；
- Communication Runtime：拥有 Inbox admission/routing；与 Application/Session
  persistence 共同完成 source-key promotion；
- Provider Runtime：拥有 Inference/Summary/ProviderNative operation lowering、usage/
  overflow evidence 和 opaque checkpoint binding；
- Persistence Runtime：保存完整 Session Timeline；Projection/Context Projector 不删除
  或反向修改 Timeline。

### SD-6 — 系统不变量追加 61–68

建议追加：

```markdown
61. Durable Session Timeline 与 active model window 分离；Compaction/截断只改变后者。
62. 每个模型 ToolResult 必须稳定关联一个 ToolCall；不得产生无 callRef 的新结果。
63. 同一 InboxEntry 最多一次提升为目标 Session Input；promotion 与 consumed 原子收敛。
64. Steer 与 Queue 使用不同 safe-boundary 语义；普通未消费 Inbox 不得每轮重复注入。
65. NeedsCompaction 不直接 settle Execution；完成 checkpoint 后继续同一 pending logical step。
66. Provider-native checkpoint 只在兼容 ResolvedModelBinding 下使用；不兼容时 portable rebuild。
67. Permission/Authority 不从 Session、summary、checkpoint、Tool text 或模型声明恢复。
68. Provider overflow recovery 有界；任何已产生 durable assistant/tool effect 的 logical
    step 不得通过全步 replay 恢复。
```

## 3. DID v1.22 精确变更

### DID-1 — 文档头与治理历史

建议头部：

```markdown
**Version:** 1.22
**Status:** TOP-LEVEL ARCHITECTURE FROZEN — SCRC owning contracts landed;
implementation NOT AUTHORIZED
**Supersedes:** v1.21
**Date:** 2026-10-01
```

新增 `Governance changes (v1.21 → v1.22)`，逐项记录 SCRC-1…SCRC-12；明确
不授权 migration、生产数据转换或 implementation，并固定上述治理提案 SHA。

### DID-2 — §1.7 Session ADT

在既有 `Checkpoint + Recent Frontier` 后冻结：

```text
SessionItem =
  UserMessage(source, contentRef, trust)
| AssistantMessage(providerTurnId, contentRef, finishReason)
| ToolCall(providerTurnId, callRef, toolRef, argumentsRef)
| ToolResult(callRef, invocationId?, status, observationRef,
             modelOutputRef, artifactRefs[])
| ControlResult(callRef, actionKind, disposition,
                canonicalRefs[], observationRef)
| ContextUpdate(sourceRef, revision, Full | Replace | Revoke, contentRef)
| CompactionCheckpoint(fromEpoch, toEpoch, Summary | ProviderNative,
                       summaryRef?, opaqueItemRef?, bindingFingerprint?,
                       retainedFrontier)
| AttachmentRef(ref, mediaType, trust, disclosure)
```

规则：

- ADT 是 provider-neutral session/runtime contract，不是 Domain Aggregate；
- `sourceRef + item type` 幂等，same source/different hash 是 invariant conflict；
- streaming delta 仍是 transient；completed typed items 才进入 Timeline；
- Canonical State 不复制为 Session authority；`ContextUpdate` 是 model projection
  supersession 记录。

### DID-3 — §3.7 Runtime Supporting Records

新增：

```text
AgentStepContext = immutable per-sampling snapshot carried by ModelContextManifest
InputPromotionRecord = source-key delivery result, represented by sourced SessionItem
```

`AgentStepContext` 不是新的 Aggregate/table；Manifest 持久化其 refs/revisions/
fingerprint。Tool execution 仍 fresh re-check，不从 snapshot 恢复权限。

### DID-4 — §7.2/§7.3 Port 与 Application Service

不新增物理 package。冻结以下操作：

```ts
interface SessionRepository {
  appendItemIdempotent(input, source, fence): Effect<SessionSequence, ...>;
  listActiveFrontier(sessionId, epoch): Effect<ReadonlyArray<SessionItem>, ...>;
  commitCompaction(input, fence): Effect<CommittedCheckpoint, ...>;
}

interface InputPromotionService {
  promoteInbox(input: {
    workspaceId; entryKey; targetSessionId; delivery: "Steer" | "Queue";
  }, fence): Effect<SessionSequence, PromotionError, ...>;
}
```

`InputPromotionService` 属 Application/Runtime orchestration，不是 infrastructure
Port；它在一个 `TransactionPort` scope 内执行 sourced Session append + Inbox
`markConsumed`。重复调用返回既有 sequence；same source/different content 失败。

### DID-5 — §7.5 ProviderPort / Portable request

将 `PortableModelRequest.messages` supersede 为：

```ts
type PortableInputItem =
  | PortableMessage
  | PortableToolCall
  | PortableToolResult
  | PortableContextUpdate
  | PortableCompactionCheckpoint
  | PortableAttachmentRef;

interface PortableModelRequest {
  modelRef: string;
  operationKind: "Inference" | "CompactionSummary" | "CompactionNative";
  instructions: ReadonlyArray<PortableInstruction>;
  inputItems: ReadonlyArray<PortableInputItem>;
  toolDefinitions: ReadonlyArray<PortableToolDefinition>;
  outputContractRef: string;
  budget: { maxOutputTokens: number };
  cacheHints: ReadonlyArray<CacheHint>;
}
```

Adapter 必须无损保存 tool-call correlation。不能支持的 Item/operation 返回 typed
capability incompatibility；不得静默文本化。`CompactionNative` 可复用现有
`CanonicalProviderEvent.ContinuationState(stateRef)` 保存 opaque result reference，
不要求扩展 CanonicalProviderEvent ADT。

### DID-6 — §7.6 Tool Runtime correlation

补充：

- decoded executable/control invocation 必须携带 provider-neutral `callRef`；
- ToolRuntime/Control policy 的结果由 Agent Runtime 写成 sourced ToolResult/
  ControlResult；
- bounded output 与完整 Result/Artifact 分离；
- ToolInvocation settlement 已存在、Session Result 未写时按 invocation/resultRef
  幂等补写；
- dangling ToolCall 必须恢复为真实结算或明确 Interrupted/OutcomeUnknown，禁止伪造
  success 或无配对文本。

### DID-7 — §8.2 Model Turn Pipeline

建议替换管线为：

```text
Execution + pending safe-boundary input
↓
durable Input Promotion
↓
capture AgentStepContext once
├── canonical control refs/revisions
├── session/epoch/input frontier
├── effective tool catalog
├── model/deployment binding fingerprint
└── budget evidence basis
↓
Instruction Resolution
↓
Context Projector(Session Timeline + checkpoint + canonical snapshot)
↓
Budget Planner
├── Ready
├── NeedsCompaction(CompactionRequest)
└── ContextUnsatisfiable (typed E; fixed mandatory context only)
↓
Model-family / Provider-family Compiler
↓
PortableInputItem[] + ToolDefinition[] + Manifest
↓
ProviderPort
```

### DID-8 — §8.8/§8.10 Context/Budget

冻结两类输入：

- `Retained Canonical Context`：当前权威 source snapshot/delta，不由 Compaction
  summary 决定；
- `Session Active Frontier`：最新 completed checkpoint + recent typed items。

预算证据优先级：

```text
Provider reported usage
> provider/model tokenizer or estimator
> adapter structured-request estimator
> chars/4 conservative fallback
```

BudgetDecision/Manifest 必须记录各层使用的 evidence kind、estimated/observed tokens、
threshold、reserve 和 model context limit。粗估算可以触发提前压缩，但不能把普通
可压缩压力判为 `ContextUnsatisfiable`。

### DID-9 — 替换 §8.13 Compaction

冻结：

```text
prepareTurn → NeedsCompaction(request)
→ persist Compaction ProviderTurn + Manifest
→ choose Summary | ProviderNative from capability/binding
→ execute + validate result
→ atomic Session checkpoint append + epoch advance
→ fresh canonical control reconstruction
→ retry same (logicalStepNo, repairAttempt), without replaying completed effects
```

`CompactionRequest` 至少包含：executionId、sessionId、currentEpoch、reason、pending
logical-step identity、input frontier、binding fingerprint、implementation preference。

`CompactionResult`：

```text
SummaryCheckpoint(summaryRef, retainedFrontier, newEpoch)
| NativeCheckpoint(opaqueItemRef, bindingFingerprint,
                   retainedFrontier, newEpoch)
```

规则：

- started 未 completed 时旧 epoch 仍有效；checkpoint + epoch advance 原子；
- Summary rolling update 保留 objective/requirements/decisions/progress/blockers/
  next move/relevant refs；recent frontier 有独立 token 上限；
- ProviderNative opaque item 不可跨不兼容 binding；
- Provider context overflow 且尚无 durable assistant/tool effect 时允许一次 compact +
  same-step physical retry；第二次 overflow terminal；
- Compaction failure 可以使当前 Execution typed fail/Attention，但
  `NeedsCompaction` 本身不是 settlement；
- Compaction 不消费权限，不更改 Work/Verification/Acceptance。

### DID-10 — §8.19 Manifest 增补

Manifest 新增：

```text
logicalStepNo / repairAttempt
operationKind
inputFrontier { firstSequence, lastSequence, checkpointSequence? }
typedInputItemRefs[] + callRefs[]
AgentStepContext fingerprint
ResolvedModelBinding fingerprint
budgetEvidence { kind, estimatedTokens, observedTokens?, reserves, threshold }
compaction { implementation?, fromEpoch?, retainedFrontier? }
```

Tool invocation 使用 trusted Manifest association；model payload 仍不携带 authority/
revision/manifest claim。

### DID-11 — §9.8 Session persistence

保留 `session_entries` 表作为物理 append-only carrier，但把 payload 冻结为上述
`SessionItem` versioned envelope。建议下一 migration **0019**（当前 production
baseline 已有 0018）执行 additive/rebuild evolution；不得复用 0018。

最小列语义：

```text
session_id + sequence                 primary identity
item_type + schema_version            typed envelope discriminator
payload_json                          versioned payload
source_kind + source_ref + content_hash  all-null legacy or all-present sourced shape
context_epoch                         item admitted under which epoch
created_at
```

`UNIQUE(session_id, item_type, source_kind, source_ref)` 只约束 sourced items。旧
Input/ModelOutput/Observation/CheckpointReference/ContextUpdate rows作为 legacy
evidence 保留，不从 payload text 猜 callRef，也不自动升级为新 ToolResult。迁移必须
显式分类：可证明来源的绑定 source；无法证明的保留 Legacy item，仅允许审计/portable
summary，不进入 strict tool-call replay。

### DID-12 — §9.10 Provider Turn

`provider_turns` 增加/冻结 `operation_kind`：

```text
Inference | CompactionSummary | CompactionNative
```

三类均先持久 intent + Manifest，再调用 Provider。Native opaque item 存 Blob/Artifact
或等价耐久 carrier，ProviderTurn 只保存 ref + binding fingerprint；secret/raw credential
不得进入该 item。

### DID-13 — §10 包边界

不新增 package/dependency edge：

- `model-context`：`ContextProjector`、budget evidence、PortableInputItem compilation；
- `agent-runtime`：safe input drain、StepContext orchestration、typed continuation、
  Compaction Coordinator；
- `application`：InputPromotionService transaction；
- `provider-runtime`：operation lowering、native capability、usage/overflow evidence；
- `tool-runtime`：真实 invocation/settlement；不写 Session；
- persistence adapter：Session/Inbox/checkpoint atomic operations。

保持：`model-context !-> agent-runtime/tool-runtime`、runtime 只依赖 ports、composition
只在 app boundary。

### DID-14 — Appendix B

建议更新：

```text
Application
└── InputPromotionService(SessionRepository + InboxProjectionStore + TransactionPort)

ModelContext
├── ContextProjector
├── BudgetEvidenceResolver
└── PortableInputItem compiler

AgentRuntime
├── SafeBoundaryInputDrain
├── AgentStepContext capture
├── CompactionCoordinator
└── existing AgentLoopStep orchestration

ProviderRuntime
├── Inference / CompactionSummary / CompactionNative lowering
└── usage / overflow / binding evidence
```

## 4. Phase-owned contract landing

### P2-1 — `P2/02-port-contracts.md`

新增 `SessionRepository.appendItemIdempotent`、`listActiveFrontier`、
`commitCompaction` 的 A/E/R；明确 `InputPromotionService` 在同一 transaction 中调用
Session append + Inbox consume。`commitCompaction` 验证 current epoch CAS 和完整
lease-holder triple。

### P2-2 — `P2/04-sqlite-schema.md`

新增“SCRC v1.22 successor”小节，只冻结 migration 0019 的要求，不在未授权状态下
声称已实现。旧 row migration 禁止从 text 猜 callRef。checkpoint + epoch advance 的
物理原子性和 sourced-item unique index 必须入合同。

### P2-3 — `P2/06-recovery-skeleton.md`

恢复顺序增补：

```text
reconcile in-flight ToolInvocation
→ close missing sourced ToolResult if proven
→ reconcile incomplete Inbox promotion
→ keep last completed ContextEpoch active
→ discard/continue incomplete compaction attempt according to ProviderTurn evidence
→ resume pending AgentLoopStep
```

### P3-1 — `P3/01-provider-contracts.md`

`PortableModelRequest.messages` 被 `inputItems` supersede；新增 `operationKind`。保持
CanonicalProviderEvent ADT 不扩展，Native checkpoint 通过现有 ContinuationState ref
表达。ModelCapability 增加 supported input item kinds、native compaction capability、
token-estimation capability 和 binding fingerprint。

### P3-2 — `P3/02-model-context-contracts.md`

明确 supersede 以下现行条款：

```text
“Durable Tool Observations enter as role: tool messages”
→ typed ToolResult/ControlResult with callRef.

“Unconsumed Workspace Inbox entries ... enter as provider messages;
 context assembly never marks consumed”
→ source-key Session promotion atomically marks consumed; projector only reads
  promoted Session Items.
```

`prepareTurn()` 仍返回 `NeedsCompaction(CompactionRequest)`；实现不得只返回 reason。
新增 StepContext、ContextProjector、budget evidence 和 Summary/Native result ADT。

### P3-3 — `P3/03-agent-loop-driver.md`

替换“recent durable Observations assembled as DataOnly tool messages”为“typed sourced
ToolResult/ControlResult projected with callRef”。冻结：NeedCompaction 必须运行
Compaction Coordinator；同一 AgentLoopStep 在成功 compact 后重新 prepare，不创建
新的 semantic logical step/repair attempt，也不重跑 action ledger 中已解决动作。

### P3-4 — `P3/04-sqlite-schema.md`

记录 migration 0019 为未来授权项；更新 P3 SessionItem payload、ProviderTurn
operation kind、Manifest fields 与 native opaque ref/binding。不得修改已执行的 0003/
0017/0018 migration 内容。

### P3-5 — `P3/08-agent-loop-step-handoff.md`

新增 `Compacting` 不作为持久 step state的裁决：Compaction 是独立 ProviderTurn +
Session epoch transition，pending AgentLoopStep identity 保持不变。恢复通过该 step 的
pending identity + latest completed epoch 重建；若确需记录关联，使用 compaction
ProviderTurn/Manifest ref，不扩展业务 lifecycle。

### P4-1 — `P4/02-tool-runtime-pipeline.md`

ToolRuntime 返回完整 CanonicalToolObservation/settlement；Agent Runtime 负责把它按
callRef/source ref 写入 Session。ToolRuntime 不直接写 Session，不从 Session 恢复
authority。OutcomeUnknown 生成 typed ToolResult 并继续受 unresolved-side-effect gate
阻塞。

### P9-1 — Provider/Tool recovery

P9 `04`/`07` 增加：

- Tool settled → missing Session ToolResult 的本地补写；
- dangling ToolCall 与 unresolved invocation gate；
- incomplete/complete compaction crash matrix；
- Provider overflow 仅在无 durable output/effect 时一次恢复；
- native binding mismatch 走 portable rebuild，禁止 opaque replay。

### P12-1 — Runtime safety / provider qualification

P12 `08` 增加 compaction-loop/overflow-loop safety observation，不能把正常一次
Compaction计为 no-progress defect；重复无收益压缩必须被 envelope 中止。P12 `12`
增加 Provider capability qualification：typed tool pairing、native compaction、binding
portability、usage/token estimator 和 second-overflow terminal。

## 5. Supersession Register

人工治理必须把以下表落入 DID 或 P3 index，避免旧文本继续被当成当前合同：

| Former source | v1.22 disposition |
|---|---|
| P3 `02` §1: Observation → `role: tool` text | Superseded；新路径是 typed ToolResult/ControlResult + callRef。Legacy rows 仅为历史证据。 |
| P3 `02` §1: every-turn unconsumed Inbox injection without consumption | Superseded；新路径是 source-key atomic Session promotion。 |
| P3 `03` §2: recent Observation assembled as DataOnly tool messages | Superseded representation；DataOnly trust 仍成立。 |
| P3 `02` §5 / current request budget: char-based complete request estimate | Retained only as lowest-priority fallback；不得单独决定 ContextUnsatisfiable/Execution stop。 |
| Current driver: `NeedsCompaction → CompactionRequired` settlement | Implementation deviation；contradicts existing control-result contract and is removed only after implementation authorization. |
| Current driver: `contextEpoch = 0` | Implementation placeholder；must bind actual Session epoch after authorized migration/runtime work. |
| `PortableMessage { role, text }` as universal carrier | Superseded as universal form；retained only as `PortableInputItem.Message` compatibility type. |
| Existing P16 CanonicalProviderEvent closed ADT | Remains closed；native compaction uses existing ContinuationState ref plus operation metadata. |
| Existing ToolAuthorityResolver / ControlBasisResolver | Remains authoritative at effect boundary；not replaced by StepContext. |

## 6. 一致性审阅清单

人工落字后必须逐项得到 `PASS`：

1. SD Session/Inbox/Compaction 与 DID ADT/ports/DDL 无冲突；
2. P3 `01` 与 ports `PortableModelRequest` 字段完全一致；
3. P3 `02` 不再保留 every-turn Inbox injection 或 plain tool message 的规范语句；
4. P3 `03` 的 loop 不把 NeedsCompaction 转成 settlement；
5. P2/P3 的 Session repository/DDL/source uniqueness/epoch CAS 一致；
6. AgentLoopStep identity 在 Compaction 前后保持一致，不重复 Provider inference/tool；
7. Summary 和 Native checkpoint 的 portable/nonportable 边界明确；
8. Native path 不要求扩展 CanonicalProviderEvent；
9. Permission/Grant/ResourceBoundary 不写入 summary 作为 authority；
10. Information Trust Plane 对 Tool/Inbox/Artifact 默认 DataOnly 的规则保持；
11. migration 0019 只向前演进，不重写 0003/0017/0018；
12. package DAG 没有新增非法 edge；
13. P9 覆盖 append/consume、tool settle/result、checkpoint/epoch 的两侧 kill；
14. P12 覆盖 overflow second failure 与 repeated-compaction no-progress；
15. `ContextUnsatisfiable` 只剩 fixed mandatory context 的不可满足路径；
16. 旧 Context assembly completion evidence 被显式标为旧合同完成，不冒充 SCRC
    实施证据。

## 7. Design Gap 关闭条件

人工治理应用本包后：

1. 在 `SCRC-DG-01` 写入 SD v1.4、DID v1.22 和所有 phase-contract landing commit；
2. 附上独立一致性 review（Blocking = 0）；
3. 将 Gap 更新为 `RESOLVED`；
4. 单独创建 S1–S8 implementation phase/task；
5. 单独签发 implementation authorization；
6. 再由 Coding Agent 按 TDD 开始代码和 migration 0019。

在此之前，当前状态保持：

```text
Direction accepted
Owning design not landed
SCRC-DG-01 OPEN
Implementation NOT AUTHORIZED
```
