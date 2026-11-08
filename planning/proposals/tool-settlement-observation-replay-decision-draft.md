# Tool settlement 与 AgentLoop Observation 的可重放交接 — 治理决策稿

状态：**DRAFT / 等待人工治理接受**
修订：**5 — 区分 fence 失效与 winner evidence failure**
缺口：`AH7-DG-01`
基线：绿色提交 `f80ee9132774c0c1fb570744d81398fad17da188`
建议接受标识：`ACCEPT_TOOL_SETTLEMENT_OBSERVATION_REPLAY`
实施：**尚未授权**

2026-10-05 的 `AH7-DG-01-governance-readiness.review.md` 审阅的是修订 1，
其 SHA-256 `6FCBE39E781636AE1FAB92302386D0C2960FE215AD417495A58E765EE63766FA`
与修订 1 的 LF 字节一致。本稿取代修订 1，必须按本稿最终 LF SHA-256 独立复审；
旧审阅只作历史记录，不覆盖本稿。

## 决策范围

处理一项已 terminal-settled 的 P4 `ToolInvocation` 在相同 AgentLoop action
恢复时，如何重建第一次返回给 Agent Runtime 的精确
`CanonicalToolObservation`，并用现有 P3 source key 将同一 ToolResult 收口。
主要失败证据是 `ExpectedFailure + resultRef = null` 的 pending RED。
该隔离用例位于
`tests/functional/pending/ah7-settled-expected-failure-reentry.functional.test.ts`；
修订 1 readiness review 记录当前重入返回 `OutcomeUnknown`，同时 executor 与
settlement writer 必须保持未调用。此稿未重跑该用例。

本决策覆盖 P4 持久 settlement 可对应的所有 `CanonicalToolObservation` 标签，
以免恢复逻辑只对 ExpectedFailure 特判：Success、ExpectedFailure、Interrupted、
OutcomeUnknown、RuntimeFailure。`Denied` 没有对应的
`ToolInvocationSettlement` variant，因此不被映射成某一 settlement tag。本决策
只覆盖数据库中现有 settlement-kind 集合的 terminal 行；P4 `02` §3 关于 denial
“仍持久化为 settled invocation”的文字与 P4 `01` 的 settlement ADT/current
runtime 的 pre-intent denial 路径不一致。该 Denied 持久化分歧是**独立 scope**：
本稿不决定 denial 是否形成 invocation row，不能把 Denied 静默塞进 ExpectedFailure
或本次新增字段。该冲突只描述 `f80ee91` 基线尚未合入 AH7-DG-03 的状态，不单独立项
或重复提案。合入 AH7-DG-03 已接受 owner landing 时，需按其 P4 Denied/Interrupted
terminal-row 合同另做一致性检查；不得用它扩大 AH7-DG-01 terminal-settlement 合同。
`OutcomeUnknown` 在应用层仍转为现有
执行结算/重协调路径，不把 refs 当 bounded ToolResult 文本；P3 保留既有
`persistActionSettlement` 的 terminal ToolResult/source 与 Action `ReconciliationPending`
路径。

AH7-DG-03 的已接受 proposal source commit 为
`ce08b55debcadc8d255bf43f6702ca8da592c129`，owner-contract landing 为
`34ed1c597c02d677d87f4fa9435d8339641ea3d6`，landing record 为
`5cab270642f3a738f1da3dcb846ce734d477f8b2`；其当前独立设计/实现分支为
`codex/ah7-approval-settlement-governance@db929654128b8e864d3733b95088f4edda0e4c43`。
这些提交不在 `f80ee9132774c0c1fb570744d81398fad17da188` 的祖先链上（共同基点为
`6fcbc17e27b694f201792aedd6c2ec368508b542`）。本稿不声称解决、复述或替代
AH7-DG-03；接受/landing 时只记录该分支关系，不从本提案推导其合同。

## 建议决定

### 0. Canonical encoding envelope

使用固定 `observation_format_version = "p4-canonical-tool-observation-v1"`，由
P4 专用 encoder 按 schema 字段顺序编码封闭 union；对象键顺序和数组顺序固定，
hash 对 encoder 输出的 UTF-8 原始字节计算。完整 JSON body 上限为 **16,384 UTF-8
bytes**。hash 仍为
`SHA-256(UTF-8(observation_format_version + "\n" + observation_json))`。

本 envelope 的各字段硬上限：

- `BoundedObservation.text`：至多 2,000 JavaScript UTF-16 code units，沿用现有
  `bounded()` 上限；首次返回和结算前即 canonicalize，并将最终的 `truncated`
  一起持久化。不能等重放时才截断。最坏 JSON escaping 为约 12,002 bytes。
- Success `resultRef`：null，或一个通过 `ArtifactId` decoder 的 `art_<uuid-v7>`，
  即 40 ASCII bytes。不得把任意字符串当 Artifact ref。
- RuntimeFailure `cause`：至多 1,024 UTF-8 bytes；超限时在首次 settlement 前将
  settlement 和 observation 的 cause 一起替换为固定闭合 code
  `RuntimeFailureDetailOmitted:ObservationEnvelopeExceeded`，保留
  `RuntimeFailure` tag。
- OutcomeUnknown `reconciliationRefs`：1–8 项，每项至多 128 UTF-8 bytes；超限时
  不截断、不丢 ref、不提交终态 settlement。将当前 invocation 保持 unsettled，
  交给现有 P4/P9 unresolved-side-effect/reconciliation 路径；禁止从该结果继续执行
  当前 Agent action。
- 其余 tag 不携带字符串或数组字段。

固定 16 KiB 上限包含最坏 escaped text/cause、bounded refs 与 union framing；超过
字段限制必须在 P4 **首次 settlement 和首次返回 Agent Runtime 前**按表格下的规则
canonicalize。Canonical text / cause 的闭合替代值都小于 256 bytes；有效 ArtifactId
固定 40 ASCII bytes；有限 reconciliationRefs 按上限编码，因此闭合后的 union 必须
在上限内。大小限制造成的替代值仍保留原 settlement tag；不能因字段太长清除已知
Success/ExpectedFailure/RuntimeFailure 事实或改写为 OutcomeUnknown。

P4 `08` 的当前 `bounded()` (`packages/tool-runtime/src/runtime.ts`) 只限制
model-visible 文本长度，不是 stdout/stderr 原始输出 byte cap。`shellExecutor`
(`packages/tool-runtime/src/tools/shell.ts`) 使用 `spawnSync`，未提供 Arbor-owned
`maxBuffer`；它把 stdout/stderr 放进 observation JSON，`stdoutRef`/`stderrRef` 当前
为空，再由 `bounded()` 限制模型观察。Node runtime 隐含的 `spawnSync` 默认 buffer
上限不是 P4 持久化合同。`BlobStorePort` (`packages/ports/src/tool.ts`) 只提供通用
bytes `put/get/stream`；当前 shell executor 没有把原始 stdout/stderr 写进
BlobStore/Artifact。现有 Success 自动 Artifact 路径 (`packages/tool-runtime/src/runtime.ts`,
`packages/tool-runtime/src/artifact.ts`) 保存的是 `outcome.observation.text`，不是原始
stdout/stderr。本决策只保证完整、有界的 model-visible `CanonicalToolObservation`
可重放，不声称保留 raw shell output；stdout/stderr caps、ref 产生和 Blob/Artifact
路由如需改变，另立 P4 owner 变更。

### 1. P4 持久化完整观察证据

每个新写入的 terminal `ToolInvocation` 必须在同一 Control-DB 事务中持久化：

```text
settled_at + settlement_kind + settlement_json + result_ref
+ observation_format_version + observation_json + observation_sha256
```

`observation_json` 是 P4 生成并返回的完整 `CanonicalToolObservation` 的版本化、
UTF-8 JSON 编码，包含其原始 `BoundedObservation.text` 与 `truncated`，以及
Success 的 Artifact `resultRef`、OutcomeUnknown 的 reconciliation refs、
RuntimeFailure 的 cause 等该 ADT 已有的字段。首次 canonicalize 后编码与返回同一
值；不得在重放时再截断。`observation_format_version` 固定该 ADT decoder 和现有
P4→Agent Runtime 投影语义；改变可见投影语义必须增加版本，旧版本要么由固定
decoder 原样恢复，要么 fail closed。

`observation_sha256` 是
`SHA-256(UTF-8(observation_format_version + "\n" + observation_json))`。读取时先
验证版本、hash、JSON shape 和结算一致性，再构造观察。版本/hash/shape/结算任一
不匹配，不调用 executor、不覆盖或重写 settlement、不读取其他 invocation 的
证据；返回 `ToolObservationReplayEvidenceFailure`，其 `failureCode` 限定为
`Missing | UnsupportedVersion | Malformed | HashMismatch | SettlementMismatch |
IntentMismatch | ResultRefMismatch | UnexpectedResultRef`，不携带原始 JSON 或
parser/cause 文本。

bounded Observation 很小，建议作为 `tool_invocations` 的 inline immutable
evidence 持久化，不另造跨 Blob / Control-DB 原子事务。P4 `BlobStorePort` 在未来
可承载 raw result bytes，但其当前合同既没有上述 observation codec/bound，也没有
shell stdout/stderr 写入路径；本提案不把 Artifact/Blob ref 冒充观察证据。`result_ref` 保留现有
Artifact/raw-result 含义，不复用为 bounded Observation 引用。Artifact 仍按 P4
`07` 保存可选的大结果；Artifact ref/hash 与 `observation_sha256` 是两个不同合同。

写入只允许从未结算行首次 CAS 到 terminal 行；terminal 证据与 settlement 同时
提交且之后不可变。P4 `settle` 接口必须一次接收/绑定二者，不能出现“已结算但
观察后写”的提交窗口。Executor 的外部 effect 不进入这笔事务。

Success 的 auto-Artifact 也只能由该 settlement winner 创建/关联：SQLite 上在同一
`BEGIN IMMEDIATE` transaction 中先读并验证当前 invocation。若已有 terminal row，先
返回该 winner evidence，绝不存储本进程的 Artifact candidate。若仍 unsettled，才由
winner 在该事务内通过现有 `ArtifactService.store` 写 Artifact metadata，再将该
ArtifactId、P4 terminal settlement 与 Observation evidence 一起提交。事务回滚时
P4 `07` 允许只留下不可达 content-addressed blob；它不得留下已提交 Artifact metadata
或 `tool_invocations.result_ref`。非 SQLite adapter 即使出现 `settle` 零行更新，也要
读 winner 并丢弃本地 Artifact candidate，不能提交 candidate 的 Artifact metadata。

首次 settlement 前统一对 `ToolExecutionResult` 做 version-1 canonicalization；该
canonical `CanonicalToolObservation` 是当次返回和数据库记录的同一个值：

- `observation.text` 超过 2,000 UTF-16 code units 时，首次返回前按现有 `bounded()`
  规则截断并置 `truncated=true`；重放只读这一已 canonicalized 值。
- Cause 超过 1,024 UTF-8 bytes 时，用闭合值
  `RuntimeFailureDetailOmitted:ObservationEnvelopeExceeded` 同时替换
  RuntimeFailure settlement/canonical observation 的 cause；保留
  `RuntimeFailure` terminal tag。
- Success 的 resultRef 不是有效 ArtifactId，或 P4 `ArtifactService` 不能按 P4 `07`
  解析为有效 Artifact metadata 时，保留 Success settlement/tag，置两处 resultRef
  为 null，并将模型观察替换为固定文本
  `tool succeeded; artifact reference omitted by replay envelope`，`truncated=true`。
  这保存已知 Success 事实，同时不暴露/悬挂无效引用。必须区分“executor 原始
  resultRef 为 null”和“非 null ref 被验证失败后清空”：后者禁止触发现有
  Success auto-Artifact 分支，避免把 fallback 文本误登记成原工具结果 Artifact。
- OutcomeUnknown 的 ref 超过 8 项、任一 ref 超过 128 UTF-8 bytes，或 canonical JSON
  超过 16,384 bytes 时，不截断 refs、不写 P4 terminal settlement、不继续当前 Agent
  action。返回现有 P4 `ToolRuntimeOperationalFailure`，`effectDisposition` 为
  `OutcomeUncertain`；应用层沿现有路线产生
  `OutcomeUnknown(ReconciliationRequired([invocationId]))`，P4 intent 保持 unsettled，
  由既有 P9 unresolved-side-effect gate / durable Attention 接手。该闭合 typed 结果
  保留“可能有副作用”的事实，不伪造成功或空 refs。
- 任一非 Success executor 结果携带 `ToolExecutionResult.resultRef` 时，P4 不将它写入
  `tool_invocations.result_ref`，不附 Artifact 到 ToolResult；其字段不属于这些
  canonical union variants。若 executor 在外部已建该 Artifact，它保持未引用。P4 `07`
  没有定义 Artifact metadata GC/retention；本稿不新增清理策略，只要求该 ref 不投影或
  关联到 terminal row。既有 terminal row 如在非 Success tag 下带
  非 null `result_ref`，按 `UnexpectedResultRef` fail closed；不得加载、投影或重挂该
  Artifact。

### 1A. Tag / settlement / Artifact 一致性

| Canonical tag | `ToolInvocationSettlement` | 持久化观察字段 | `tool_invocations.result_ref` 与 Artifact | P3 输出 / `truncated` |
|---|---|---|---|---|
| `Success` | `{_tag:"Success"}` | `observation:{text,truncated}`、`resultRef` | row ref 必须与 observation ref 相等；ref 非 null 必须通过 `ArtifactId` decoder 且由 P4 `ArtifactService` 解析为有效 Artifact metadata。P4 `ArtifactService` 按 content hash deduplicate，故有效 Artifact 的 metadata `producedBy` 可以是最初写入该相同内容的 Execution/Invocation；当前 `tool_invocations` row 才绑定此 ref 与本次 invocation。仅当 executor 原始 ref 为 null 时保留现有 P4 行为：有 ArtifactService 则将 bounded text 存成 Artifact 并写回其 id，否则两处均为 null。失败验证后清空的非 null ref 不走 auto-Artifact。终态重放不从 Artifact bytes 重建观察。 | Succeeded；保留精确 text/truncated；Artifact ref 只在有效非 null 时进入 ToolResult。无效/错绑 ref 首次 settlement 前按上文 Success fallback，legacy 行返回 `ResultRefMismatch`。 |
| `ExpectedFailure` | `{_tag:"ExpectedFailure"}` | 原始 bounded `observation:{text,truncated}` | `result_ref` 必须为 null；无 Artifact link。首次写入丢弃 executor 私有 `resultRef`；legacy non-null ref 返回 `UnexpectedResultRef`，不读 Artifact。 | Failed；原 canonical text/truncated，除非首次超长 canonicalization；ToolResult 无 artifactRefs。 |
| `Interrupted` | `{_tag:"Interrupted"}` | 仅 `{_tag:"Interrupted"}` | `result_ref` 必须为 null；不挂 Artifact。legacy non-null ref 返回 `UnexpectedResultRef`。 | P4 canonical tag 没有 BoundedObservation/truncated；既有 Application projection `tool invocation interrupted` 的 P3 version-1 输出固定为 `truncated=false`。 |
| `OutcomeUnknown` | `{_tag:"OutcomeUnknown", reconciliationRefs}` | 同一、同序列 `reconciliationRefs` | `result_ref` 必须为 null；不挂 Artifact。legacy non-null ref 返回 `UnexpectedResultRef`。ref 越限时新写入保持 intent unsettled，legacy 终态按 `Malformed` fail closed。 | P4 不返回 BoundedObservation；Application 使用 `persistActionSettlement`，保留现有 terminal ToolResult/status `OutcomeUnknown`、Action `ReconciliationPending` 和 P3 source/result hash；固定 terminal text `Control action settled the execution (OutcomeUnknown)`，`truncated=false`，`artifactRefs=[]`。 |
| `RuntimeFailure` | `{_tag:"RuntimeFailure", cause}` | 同一 canonical cause | `result_ref` 必须为 null；不挂 Artifact。legacy non-null ref 返回 `UnexpectedResultRef`。oversized cause 在首次写入按闭合 cause 值替换；legacy cause 超限返回 `Malformed`。 | Failed；现有 P3 renderer 将 `tool runtime failure: {cause}` 投影为 bounded text；1,024-byte cause 上限使固定 renderer 的 output 在 2,000 code units 内，`truncated=false`。 |

所有 tag 都要求 row `settlement_kind` 等于对应 settlement `_tag`，且
`settlement_json` 与 `observation_json` 的 tag-specific 字段完全相同。只有 Success
可带 Artifact `result_ref`。Artifact 缺失/损坏在终态提交后不改写已知 settlement 或
Observation；其现有读取失败保持独立 Artifact 结果，不触发 P4 executor replay。

### 1B. 同 ToolInvocation 并发 settle 的赢家收敛

`ToolInvocationStore.settle` 的 terminal update 是 `(executionId, invocationId)` 的
first-writer-wins CAS；settlement、Observation version/body/hash 与 row
`result_ref` 必须属于同一次 CAS/transaction。更新返回零行时，loser 在**同一个
serializing transaction**（当前 SQLite `TransactionPort` 使用 `BEGIN IMMEDIATE`）
重新读取 canonical row；不能沿用 settlement 前快照。若 adapter 必须结束写事务才可
读取，则用新只读事务重读已提交 winner，仍须重新校验全部证据。

Executor 返回 local candidate 后、任何 Artifact materialization 之前，settlement
事务先检查当前 fence 并重读 intent row：若已 terminal，直接校验/返回 winner，不尝试
CAS，也不创建 Artifact；若仍 unsettled，才 canonicalize 并物化 winner 的 Artifact，
然后 CAS settlement+Observation。在可并发的 adapter 中，CAS 零行仍必须按前段同一
winner-read 规则收敛。第一次读取 invocation 的 pre-execution 快照不能代替这次
settlement 边界读取。

任何 terminal-row observation 读取（包括 invoke 的已结算早退路径和 CAS loser 路径）
都必须在任何 P4 `ToolInvocationRecord` row read 之前，于同一个 Control-DB
`TransactionScope` 校验完整当前 Execution lease triple
`(executionId, workerId, workerIncarnationId, fencingGeneration)`，并确认数据库 lease 的
`expires_at > now`。随后单独的 fenced evidence SELECT 才能读取/解码 Observation
bytes/hash/Artifact binding。CAPA approval 自身重入若只需证明 consumed-by invocation
身份，只能使用带相同 fence 校验的 identity-only projection，不得提前 SELECT
observation fields。Execution-origin call 若 fence 缺失、holder/generation 不匹配或已过期，
先返回现有 typed `LeaseFencingRejected`（ownership lost）；不得读取或投影 winner
observation，也不得把 fence 失效当作 replay-evidence failure 写 P9/P10 Attention。
SQLite 用同一 `BEGIN IMMEDIATE` scope 保证 fence/read 不跨 transaction；旧 generation
的失败只唤醒新 owner 从 durable AgentLoopStep/P4 row 重新进入。

Loser 验证：

1. P4 intent tuple 完全相同：Execution/Workspace/tool name+version/
   SideEffectSemantics/arguments/regions/approval；调用方当前 lease fence 仍有效。
2. winner `settlement_kind`、`settlement_json._tag`、`observation_json._tag` 三者
   一致；winner version 可解码，body hash 正确，tag-specific fields 有效，
   `result_ref` 与 winner observation/ref/Artifact binding 一致。
3. P3 的当前 pinned ProviderTurn/action identity 仍是同一
   `(executionId, providerTurnId, actionIndex, callRef, toolName, inputHash)`。

这里的“tag 一致”是 winner 的 settlement 与其自有 canonical observation 一致；不要求
winner tag 等于 loser 尚未持久化的本地 candidate tag。ReadOnly 的并发读取可能看到
不同内容；Idempotent 的同 key replay 也可能产生不同 bounded reporting（例如
patch 首次 `applied=true`，第二次 `false`）。首次成功 CAS 的 winner 是唯一 canonical
结果。满足上述条件时，loser 只返回/投影 winner 的完整 canonical Observation：
不得返回自己的 candidate observation/ref，不覆盖 winner，不再 settle，不创建
candidate Artifact，不因 ExpectedFailure/Success 分支差异把已知 winner 改成
OutcomeUnknown。winner evidence 缺失/不一致/identity conflict 且 fence 有效时，返回
`ToolObservationReplayEvidenceFailure` 并 `RecoveryBlocked`，按既有 P9 fact/event 产生
deduplicated Attention；fence 失效则只返回 `LeaseFencingRejected` 并 ownership-lost，
不检查 winner evidence，也不产生 replay-evidence fact/event。两种结果都不覆盖 winner
或重跑 executor；后续有效 generation 才能检查/收敛 winner。P9 fact/event transaction
还须重验同一 lease triple/expiry；若它在证据检测后过期，本 generation 不提交
Attention fact/event，返回 ownership-lost，由后续有效 generation 重复验证并按确定性
fact identity 至多提交一次。

P4 自身 winner CAS 不宣称 executor 被并发执行一次；未结算 invocation 的四类
`SideEffectSemantics` 与已接受的 AH7-DG-03 effect-admission合同各自保持权威，本稿
只规定 terminal settlement 竞争结果及 loser 的 durable result projection。

P3 observation projection 也在其 SQLite `BEGIN IMMEDIATE` transaction 内先检查当前
lease triple + expiry，然后重读 AgentLoopStep Action 和 source Session row：Pending 才创建 source-keyed ToolResult、
Action disposition 与 cursor；若另一个 projector 已原子提交 Applied/相同 resultRef/
disposition/observationSourceRef 和同 source+contentHash 的 Session item，则返回该
winner projection，不重复 append、不再推进 cursor，并采用 winner 的当前
AgentLoopStep revision。相同 source 但 contentHash、ToolResult/status/truncation、
invocation/action binding 或 cursor evidence 不同，fail closed / RecoveryBlocked，
不以 loser candidate 修复或覆盖。对 OutcomeUnknown，使用现有 terminal
`persistActionSettlement` idempotent source 与 `ReconciliationPending` identity；不同
settlementRef 也必须 fail closed。

若 P3 lease triple/expiry 在上述事务中不有效，先返回 ownership-lost
`LeaseFencingRejected`；不读/投影 winner Session item，不推进 Action/cursor，也不写
Attention。Winner-evidence 不一致只在 P3 caller 的 current fence 有效时形成
RecoveryBlocked/Attention；若该 lease 在 P4 winner read 与 P3 projection 间过期，新
generation 按同一 source 重新读取，恢复仍唯一的 P4/P3 winner。P9 fact/event 的写事务
再次检查当前 lease；generation expiry 发生在该事务之前时不落 Attention，下一有效
generation 才能提交。

### 2. 重入顺序与身份验证

执行重入仍按 P4 `02` 重跑输入校验、资源解析、authority、权限/approval 和
ResourceAdmission。已消费 approval 只可由其原 `ToolInvocationId` 自身重入，
不得二次消费，也不得降低精确匹配条件。

随后验证原 P4 intent：exact `executionId + invocationId`，并匹配已存的
`workspaceId / toolName / toolVersion / SideEffectSemantics / argumentsJson /
resolvedRegions / approvalId`。Executable action 还必须由当前 pinned
ProviderTurn 解码出的同一个 `(AgentLoopStep identity, actionIndex, callRef,
toolName, inputHash)` 驱动；新写 invocation ID 继续使用现有
`executionId + callRef` 派生规则，legacy id 只沿现有精确记录匹配规则采用。
任一冲突 fail closed。

对匹配的已结算行，P4 直接解码并返回上述不可变 `CanonicalToolObservation`；
不得执行工具、创建第二个 intent、再次 settle、读取当前文件/服务状态，或按
当前 Artifact 内容重造历史文本。相同已结算结果对四种
`SideEffectSemantics` 一律不重执行；只有未结算行继续适用既有 P4/P9 规则：
ReadOnly / Idempotent 的安全重入、Reconcilable 先 reconciliation、
NonIdempotent ambiguity 不自动重放。

### 3. P3 ToolResult 与 source/hash 收口

P4 observation-bearing tags 使用恢复出的同一 canonical observation，继续通过现有
`persistActionObservation` 路径，在一个 `TransactionScope` 中提交 typed Session
`ToolResult`、AgentLoopStep Action disposition 与 `nextActionIndex`。重放沿用当前 P3 的
`(providerTurnId, callRef, resultRef)` source 计算、`observationRef`、Session
`contentHash` 和 idempotent append 规则；不得为恢复生成新的 result/source identity。
ToolResult 必须保持相同 status、text、`truncated`、Artifact refs 与 `invocationId`。
不能对已保存的 bounded text 再跑 `bounded()` 推导 truncation，因为原 `truncated` 值
本身是权威证据。

`OutcomeUnknown` 的 P4 canonical result 不含 bounded text；P3 继续沿用现有
`persistActionSettlement` terminal path，在同一事务提交固定 terminal ToolResult、
Action `ReconciliationPending`、AgentLoopStep `SettlementProposed` 和 cursor；使用现有
terminal result/source identity：`resultRef` 绑定现有
`(callRef,status,disposition,outputText)`，`observationRef` 再绑定
`(executionId,providerTurnId,callRef,resultRef)`；Action ledger 的 `callRef` 与当前
Execution-derived `ToolInvocationId` 绑定，不把 P4 reconciliation refs 当作 Session
输出。其 Action 继续受 P9 reconciliation gate 约束。

Success 的 P4 Artifact `resultRef` 继续作为 ToolResult 的 model output/artifact
ref；ExpectedFailure 等无 Artifact 的结果继续由现有 P3 payload 产生其稳定
resultRef。P4 Observation hash 不替代 P3 ToolResult source/content hash。Replay
不从 Artifact bytes 重建 bounded Observation；它只验证 row 内
`CanonicalToolObservation.resultRef` 与 `tool_invocations.result_ref` 一致并原样
返回该 ref。Artifact 的后续读取/损坏由现有 Artifact contract 处理，不能据此将已知
P4 terminal settlement 改成 `OutcomeUnknown` 或重执行工具。

如果该 Action 已是 `Applied` 且 P3 的 Action ledger 与 exact sourced Session
ToolResult 已在原子事务中一致，沿用现有 P3 action-ledger 收口，不再向 P4 要求
二次恢复。不得把同 Session 中无 source、错 invocation、错 callRef 或错 hash 的
自由文本当成观察证据；若 Action 仍 Pending，不能仅凭自由 Session 历史绕过 P4
证据验证。

### 4. 旧记录与 Attention

Migration 对既有 terminal 行采用 additive nullable evidence 字段；不得从
`result_ref = null`、工具当前输出、Artifact 当前内容或 Session 自由文本推算
旧 bounded Observation。可验证的 exact sourced P3 ToolResult 只在对应 Action
ledger 已证明 Applied 时按第 3 节自然收口，不作为 Pending action 的替代证据。

旧 terminal 行缺少观察证据、版本不支持、hash/shape/settlement 冲突时，P4 返回
typed、path-free replay-evidence failure。Agent Runtime 保持当前 Action Pending、
AgentLoopStep `ActionsInProgress`，不写 ToolResult、不推进 cursor、不再执行 P4
effect、不伪造 OutcomeUnknown，也不直接 settle Execution；调用现有
`RecoveryBlocked` handoff，释放当前 lease。

P9 `07` 增加一个**source-specific** durable Attention fact/event，标识
`ToolObservationReplayEvidenceEscalated`；不得借用代表未解决外部副作用的
`ReconciliationEscalated`。Fact 以确定性
`(executionId, invocationId)` 为主 dedup identity，并绑定当前
`logicalActionId / providerTurnId / callRef`；`failureCode` 使用第 1 节的封闭集合；
重复检测只返回已有 fact，payload 冲突为 typed invariant failure。P9 fact 与 event
同事务提交；pre-commit crash
在下次相同阻塞中重试该 tuple，post-commit crash 读取同一 fact。事件只包含
opaque ids、固定 `failureCode` 与目标 Workspace，不含工具参数、观察文本、
Artifact 内容、OS/parser 异常或任意 cause 字符串。

P10 `02/07` 为该 source 增加 `Action Required` 映射，target 为
`executions.workspace_id`，dedup 用 P9 `attentionFactId`，使用固定 path-free
summary；只写 Attention read model，不修改 Work、Permission、Execution 或
P4 settlement。此为一个明确来源，不引入 generic Attention/logging port。
人类后续处理继续走既有治理命令；本机制不自动重试该 action 或擅自改写已知
tool outcome。

### 5. 不变语义

- 不新增 `ToolInvocationSettlement`、`ExecutionSettlement` 或
  `SideEffectSemantics` tag。
- 不改变 CAPA Exact-Intent approval consume 事务/绑定；已消费 approval 仍只绑定
  原 invocation。
- 不改变未结算 invocation 的四类副作用恢复策略，也不把已知 terminal outcome
  改写为 `OutcomeUnknown`。
- 不读取/修改 preserved dogfood database；不改 AgentAction wire/output contract。
- 接受本稿只授权按接受包落地设计合同；**不授权生产实现、迁移或 AH7 phase closure**。

## Owner / landing map（仅接受后）

| Owner | 建议增加的精确条款 |
|---|---|
| System Design §6.5/§6.6、§10、§12.3/事件目录 | 已结算工具 outcome 与原模型观察不可分割；缺失历史观察是特定 recovery Attention source，既不等于未知外部 effect，也不隐含自动重试。 |
| DID §5.3、§6A.7、§7.6、§9.12、§13 | 记录版本化 Observation evidence 与 typed failure；不更改既有结算/approval/副作用 taxonomy；新增 source-specific P9 event。 |
| P3 `08-agent-loop-step-handoff.md` | Tool action exact decode/source 身份、Session ToolResult+Action/cursor 同事务收口、loser projection 的既有 source/hash 幂等收敛、Pending Action 缺观察证据时的 `RecoveryBlocked`。 |
| P4 `01-tool-contracts.md`, `02-tool-runtime-pipeline.md` | canonical observation schema/version/hash、精确 replay 顺序、terminal 行禁止 executor 重入、否认语义/四类 side effect 不变。 |
| P4 `06-invocation-persistence-reconciliation.md` | nullable legacy fields、新写 row 的 settlement+observation 同事务/first-writer immutable、terminal observation read 前 exact lease/expiry fence、winner CAS loser 读并校验 canonical winner、intent match、typed corruption/missing evidence。 |
| P4 `07-blob-artifact.md` | bounded inline observation 与 Artifact/raw result ref 分离；hash/retention/transaction边界。 |
| P9 `07-agent-loop-step-recovery.md` | legacy evidence不足的 fail-closed 判定；P9 specific fact/event tuple/dedup/pre-post-commit恢复。 |
| P10 `02-attention-readmodel.md`, `07-acceptance.md` | source→Action Required→execution workspace→factId dedup 映射和无 canonical mutation 验收。 |
| Application bridge | `apps/single-workspace/src/executable-tool-handler.ts` 与 composition：把 P4 typed replay-evidence failure 变成 P9 source-specific fact 后返回 `AgentActionRecoveryBlocked`；事实提交失败仍阻断本次 action，且不得转成正常 settlement。 |

Owner landing 不应改写 P3/P4/P9 已闭 phase result。接受包必须列出所有 owner 文档的
精确修订、每份 landing hash、proposal hash 与 landing consistency review；任何未在
本稿列明的新语义返回人工治理。

## 最小 implementation qualification（接受且另行授权后）

| Slice | 模块 / seam | 两进程 kill/restart 断言 |
|---|---|---|
| P4 contract/store | `ports/src/tool.ts`; `tool-runtime/src/runtime.ts`; `persistence-sqlite/src/tool-invocations.ts`; P4 additive migration | 从已存在的 terminal ExpectedFailure+Observation evidence 重入：same intent 返回 byte/field-identical canonical observation；executor、approval consume、intent insert、settle write 均为 0。版本/hash/shape/tag/ref/intent 各类 mismatch 都不返回观察。 |
| Settlement atomicity | `ToolRuntimeLive` 的 settle transaction + SQLite child-process probe | effect 已返回后，子进程 A 在 `tool_invocations` terminal settlement/evidence UPDATE 前被 kill：独立连接只见未结算 intent、无半套 evidence；子进程 B 严格按现有 `SideEffectSemantics` 决策（ReadOnly 安全重读、Idempotent same-key、Reconcilable 先 reconcile、NonIdempotent 不盲重放）。另在事务提交后立即 kill：新 daemon 读到完整匹配 settlement+evidence，零 executor/settle 重做。 |
| Same-invocation settlement race | P4 `ToolRuntimeLive` + `ToolInvocationStore`; two independent SQLite connections and OS processes; winner P4 transaction includes deferred auto-Artifact | 在 fresh DB、相同 exact ReadOnly intent / current valid fence 下，两个进程 barrier 后同时 settle 不同本地 candidate。每支均断言零行 loser 不泄漏本地候选：按 1B 读取 winner 的完整 evidence、检查 intent/tag/version/hash/result_ref/Artifact binding，向调用方只返回 winner Observation；不重写 terminal 行、不再 settle、不创建 loser Artifact。Success winner 仅一条 canonical `tool_invocations` row、一个被引用的 Artifact metadata/blob ref；ExpectedFailure winner `result_ref=NULL` 且零 Artifact 行/ref。该矩阵不测试跨 `SideEffectSemantics` effect admission，此仍按既有合同。 |
| Stale-generation loser / current-generation recovery | P4 fenced evidence read + Application recovery bridge + P3 action projection; two OS processes | seed exact terminal winner and lease generation g1; old process g0 attempts same invocation with expired/mismatched fence while g1 owns lease. Before any Observation-field SELECT, g0 must return `LeaseFencingRejected` only: no winner output, Artifact materialization, P3 Session/Action/cursor write, or P9/P10 replay-evidence Attention. Then a new valid generation g2 re-enters the same pinned action and converges exact winner once. Repeat with corrupt/missing winner evidence: stale g0 still yields no Attention; only valid g2 observes the bad evidence, returns RecoveryBlocked and commits one P9 fact/event/P10 row. |
| Agent handoff | `apps/single-workspace/src/executable-tool-handler.ts`; `packages/agent-runtime/src/agent-loop-actions.ts`; Session / AgentLoopStep stores | 真实 ExpectedFailure：A effect 和 P4 terminal+evidence commit 后、P3 Session/Action/cursor commit 前 kill；B 使用同一 Execution/ProviderTurn/action/callRef/invocation，回放精确 status/text/truncated/invocationId，Session ToolResult、Action Applied、cursor 仅一份，Provider 和 executor 各不重复，P4 settlement 只一份。P3 append/action transaction 提交后 kill 的反向点重启只读 Applied 状态，不重复追加。 |
| Loser projection convergence | P3 Session / AgentLoopStep stores + `agent-loop-actions.ts` | 两个 P3 projector 同时消费相同 winner Observation/source/hash 和 exact action binding；一方先提交。另一方在自己的事务内重读 Applied Action 与 Session source/hash，返回同一 projection，不 append 第二条 ToolResult、不再推进 cursor；并列负例：Action/session/source/hash/status/truncation 不一致时 typed RecoveryBlocked/Attention，绝不套用本地 candidate。 |
| Legacy fail-closed + Attention | P4 replay error → Application recovery-block bridge → P9 fact store/event → P10 consumer | 无 observation evidence 的旧 terminal row：A 检测后在 P9 fact/event commit 前 kill，B 重复同 tuple 并生成单一 fact；第二支在 P9 fact/event 已 commit 后 kill，B 读取同 fact。两支均不调用 provider/executor/settle，不写 ToolResult、不推进 Action/cursor；Attention read-model 最终恰一条 Action Required。 |

并发 race 至少执行两种强制赢家次序（两进程屏障指定赢家，local candidate 的原始结果故意不同）：

| Winner | Loser 本地 candidate | 必须收敛的唯一 P4 canonical row / result / P3 projection |
|---|---|---|
| Success(text=`winner-success`, valid Artifact) | ExpectedFailure(text=`loser-failure`) | 两次 P4 invoke 均向各自调用者返回 winner Success/text/ref/hash；只一个 Artifact metadata/ref，Session 只一条 Succeeded ToolResult/source，Action Applied/cursor 前进一步。Loser candidate 不得被落库或留成 Artifact。 |
| ExpectedFailure(text=`winner-failure`) | Success(text=`loser-success`, `resultRef=null`) | 两次 P4 invoke 均返回 winner ExpectedFailure/text/hash；row `result_ref=NULL`、无 Artifact；Session 只一条 Failed ToolResult/source、Action Applied/cursor 前进一步。Loser 成功 candidate 不得使已知 ExpectedFailure 变成 Success/OutcomeUnknown，也不得写入 Artifact。 |
| 任一 terminal winner 的 observation/hash/ref 缺失或冲突 | 任一本地 candidate | loser 不返回本地 candidate、不更新行、不写 Artifact 或 P3 ToolResult；返回 typed RecoveryBlocked，P9 durable Attention 恰一份。 |

并发用例断言唯一 invocation row、唯一已提交 settlement/evidence、唯一 P3 Session
source/ToolResult/Action/cursor。Success race 断言唯一**被 winner row 引用**的 Artifact
metadata/blob ref；P4 `07` 仍允许 kill/rollback 留下不可达 content-addressed orphan blob，
不把 orphan 清理语义混入本 proposal。此竞态矩阵不声称两个 concurrent executor 只运行
一次；外部 effect admission/approval 由已接受但尚未并入本基线的 AH7-DG-03 合同负责。

所有过程断言要独立 SQLite connection 观察事务前态和提交后态；不以 fiber 中断替代
OS 进程 kill。Acceptance 另须覆盖 Success（Artifact ref 存在与 null）、
ExpectedFailure、Interrupted、RuntimeFailure、OutcomeUnknown 的 tag/ref/hash 对应，
`truncated=true/false` 原样回放，wrong execution/callRef/invocation/source 交叉绑定，
UTF-8 JSON body 的 16,384-byte 上限及每个字段的 cap/cap+1，legacy row
nonSuccess+non-null `result_ref` 的 `UnexpectedResultRef`，legacy oversized cause/ref
fail closed，legacy exact Applied+Session pair、legacy Pending 缺证据，approval 自身重入，
及四类 `SideEffectSemantics` 未结算分支保持原规则。Success invalid Artifact ref 和
oversized RuntimeFailure cause 要断言 P4 settlement tag 不变、同一闭合 canonical 结果
先写后回；OutcomeUnknown ref 超限要断言 P4 row 仍 unsettled、P3 只收口现有
`OutcomeUnknown([invocationId])` 与 P9 reconciliation/Attention gate、不调用 executor。
此资格只关闭 AH7-DG-01 指定边界，不可扩大成 AH7 整体关闭声明。

## 审阅状态

修订 1 的 2026-10-05 readiness review 证明了原 ExpectedFailure RED 和旧合同缺口，
独立 review 对修订 2 提出两个 Blocking，修订 3 固定 observation byte/field envelope、
超限时首写 canonicalization 和逐 tag/ref 一致性。对修订 3 的独立 review 仍发现
terminal settlement loser 的 winner evidence convergence 缺口；修订 4 固定 CAS loser
读、赢家返回及 P3 loser projection 矩阵。对修订 4 的独立 review 又发现 stale-fence
ownership loss 与 winner-evidence corruption 不可合并成 Attention 的 Blocking；修订 5
固定 fence-before-read 和 stale-generation/new-generation 矩阵。旧 review 均未审阅本稿
完整定稿。接受前须对修订 5 的精确 LF SHA 独立复审；复审 Blocking = 0 后仍需人工
Governor 明确接受。
