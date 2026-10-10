# F23 Receipt Integrity — P9 Prior-Receipt Disposition Review

状态：**只读先导；AH10/P9 disposition 仍有最小 Design Gap；未落 design/production**
基线：`be5833be871c2540a19ec09804ace93ca59d09fb`（F23 候选提案 LF blob SHA-256 `3CDADC7468A8AB70CC0C73A09F9F0052A1E73541C49095A1CE6FF99B997236A6`）

本 review 只读取设计、接受记录和实现；没有改 `docs/design/**`、提案、生产代码或测试，也没有运行测试。只新增本 review 结果文件。初始隔离树 tracked/untracked clean。

## 结论

能确定 **B 类**：CommandType/schema 严格解码通过后，结构合法的 `AssignWorkResult` 若与已绑定的 child/ref/Work/effect/authority 证据不匹配，应继续走现有 P9 绑定 proof 检查；代码已把具体差异分类为 `ReceiptMismatch`、`RefMismatch`、`AuthorityMismatch`、`WorkMismatch` 等，随后 `block(failureCode)` 写入既有 P9 fact/event、保持 Action Pending 且不产生 Observation/新 Command。无需改写语义。

**可解析但错误 shape（A2）** 当前也已有 disposition：例如 `AssignWorkResult` 缺 `lifecycle/revision` 或 result identity 与 binding 不符，现有 `validateAssignWorkReceiptBinding` 返回 `ReceiptMismatch` 并走 P9 fact/event。未来严格 decoder 会在 P9 validator 前拦住 A2；direct-child 专用边界必须将有界的 v1 result-shape failure 保留到既有 `ReceiptMismatch` proof-failure 路径，而不能让通用 decoder 绕过它。此处无需新增 failure code/source，但实现须保留既有 behavior。

真正未决的是 **A1 raw JSON syntax corruption**：如 `result_json = '{'`，解析在 binding lookup/`block` 前失败。F23 exact-tuple 候选将通用 decode corruption 作为 `PersistenceCorruption` operational failure；但 SD §4.11 / P1 `07` / P9 `07` 要求 direct-child prior Committed receipt 的 malformed binding/effect evidence 留下 P9 durable failure fact/event。现有文案没有逐字裁决不可解析的 receipt result 是否属于这组 evidence，也没规定此路径应只 operational fail、写 P9 fact，还是二者兼有。**两阶段“通用 decoder → P9 evidence check”对 B 足够；A2 可由现有 ReceiptMismatch path 保留；A1 仍有窄 Design Gap。**

因此本次不修改 owner design，也不准备/落地 design package。需先由 P9 owner/governor 明确 A1 disposition；这不是 F23 Gateway tuple-first 的回退或比较顺序缺口。

## A / B 反例及证据

| 类别 | 隔离先导例 | 严格结构解码结果 | P9 现有合同/代码结果 | 未决点 |
|---|---|---|---|---|
| **A1. raw JSON syntax corrupt** | prior Committed `result_json = '{'` | generic decoder 提案下是 `PersistenceCorruption` operational failure；不能成为 `AgentActionRejected` | `decodeCommandReceipt` 在 P9 binding proof/`block` 前失败；当前没有 P9 fact/event。 | P9 “malformed evidence” 是否包括不可解析 receipt result？若是，需裁决它如何进入既有 P9 fact 以及 typed corruption 的优先级；若否，需确认不产出 AH10 durable fact 是合同容许的。 |
| **A2. 可解析但 result shape 错** | `{}` 或缺 `AssignWorkResult.lifecycle/revision` | 通用 exact-tuple consumer 将错误 shape 判为 corruption；direct-child P9 validator 当前归 `ReceiptMismatch` | 当前 `decodeCommandReceipt` 仅 `as R`，因此 A2 到达 `validateAssignWorkReceiptBinding` 并进入 P9 fact/event。严格 decoder 若先拒绝，必须保留 direct-child 的既有 ReceiptMismatch disposition。 | 无需新 code；实施须保证 decoder 失败不会绕过 direct-child proof-failure mapping。 |
| **B. 结构合法但绑定/effect 不匹配** | 正确 schema 的 AssignWork v1 `{workId, workspaceId, lifecycle:"Open", revision:0}`，但 `workId`/`workspaceId` 与 immutable binding 不符；或 ref/source action/authority/parent/work provenance/event 不匹配 | strict v1 decoder 接受形状 | `validateAssignWorkReceiptBinding` 对 receipt identity/result mismatch 返回 `ReceiptMismatch`；ref/authority等分别返回相应 P9 code；direct-child caller 调 `block(code)`，通过 `RecoveryAttentionFactStore` 记录既有事实/事件，随后 `AgentActionRecoveryBlocked`，无 Observation。 | 无新设计决策；严格 decoder 不应吞掉这些结构合法的业务/证明 mismatch。 |

精确顺序证据：

- `apps/single-workspace/src/control-actions.ts:371-424` 的 `findPriorCommandReceipt` 读取 raw prior row 后立即调用 `decodeCommandReceipt<unknown>`（`:413`），再检查 CommandId/Project（之后），且不通过 Gateway、不比较 candidate tuple。
- Direct-child `AssignWork` 调用 `findPriorCommandReceipt` 后才读 exact binding，并在 binding/effect proof 后执行 `block(failureCode)`（约 `apps/single-workspace/src/control-actions.ts:693-800`）。
- `apps/single-workspace/src/control-actions.ts:453-512` 的 `validateAssignWorkReceiptBinding` 对可解析但缺字段或与 binding 不一致的 receipt result 返回 `ReceiptMismatch`；Ref/Action/Work/Provenance/Event 等各自有独立失败代码。
- `packages/ports/src/assign-work-target-binding.ts:140-151` 的现有 failure enum 含 `ReceiptMismatch`，不含 JSON parse/`CommandStoreCorruption`；P9 SQL enum 同样固定该集合。
- SD `docs/design/02-system-design.md:785-798`、P1 `docs/design/implementation/P1/07-agent-loop-step-command-identity.md` §2 和 P9 `docs/design/implementation/P9/07-agent-loop-step-recovery.md:48-68` 明确 prior Committed proof-incomplete 必须 Action Pending、无 Observation/新 Command，并由 P9 记录 durable fact/event；但没有明确 corruption decoder fail vs P9 fact 的组合顺序。
- P1 `docs/design/implementation/P1/01-command-contracts.md:138-158` 把 exact-tuple decode 放在 tuple match 后，并明确没有定义 exact-tuple result/error shape 与 corruption failure mapping；它不直接裁决 AH10 receipt-first consumer。

## Trusted decoder key 可得性

当前静态 prior-consumer 调用点可给 expected CommandType：AssignWork→`AssignWork`、AcceptResult→`AcceptWorkOutcome`、SendMessage→`SendMessage`、SelectCurrentWork→`SelectCurrentWork`、DeclareDependency→`DeclareDependency`、ProduceDeliverable→`ProduceDeliverable`；`AssignWork` 有两个 prior 路径，`SelectCurrentWork` 另有 legacy CommandId。对应当前 Handler schemaVersion 均为 `"1"`。因此没有“完全拿不到可信 type/schema key”的阻断：future consumer 可以将 expected type 明确传入，并由 Composition/Handler registry 提供 expected schema decoder descriptor。stored `schemaVersion` 不应自行选择任意 decoder；unsupported historical version 应按 accepted compatibility contract 处理，否则 fail closed。

但当前 `findPriorCommandReceipt` 本身没有这些输入；增加可信 descriptor 是未来实现工作，不属于本次 review 的生产修改。P1 exact tuple comparator仍只归 Gateway transaction；prior consumer 不可伪称使用该 comparator。

## 最小治理问题与建议后续

需要 P9 owner/governor 逐字回答的单一窄问题（A2 已由现有实现归类为 `ReceiptMismatch`；本问题仅针对 A1）：

> 对 direct-child AssignWork 的旧 Committed receipt，若 raw result JSON 语法不可解析，这是否算 SD §4.11/P9 §07 所称的 malformed receipt/effect proof evidence并必须写入既有 P9 fact/event，还是仅走通用 non-retryable `PersistenceCorruption` operational failure？如果要求二者兼有，明确先后/事务边界，并保证 raw JSON/解析异常不入 fact 或 Problem；如果仅 operational failure，明确不产出该类 AH10 durable fact 是合同所容许的。

可选落地路径及代价：

1. **A1 属于 P9 proof failure（若人工确认）：**先核 prior receipt identity，再把 direct-child prior decode failure 安全映射到既有 P9 `ReceiptMismatch` fact/event，保持 RecoveryBlocked/no Observation/no new Command；同时裁决 `PersistenceCorruption` 是否仅留内部 cause或还需非重试 Problem。须由 P9 owner 明确，不能从枚举名推断。
2. **A1 不属 P9 source（若人工确认）：**只返回 `PersistenceCorruption` operational failure；owner 明确 SD §4.11/P9 §07 的“malformed evidence”不含 raw receipt JSON syntax corruption，并接受这类 direct-child unproven effect不生成既有 AH10 durable fact。若该 disposition 与 owner原意冲突，应先治理修订再实施。

在该选择前，不提交对 P1 `07`/P9 `07`/DID 的 owner landing，不修改固定 proposal `be5833b`。F23 exact-tuple decoder方案的其他边界保持原样；P10 不新增通用 corruption source。已接受 AH10 的 P9→P10 `Action Required` mapping继续存在，但其是否接收 A 类不是本 review 能从文案唯一推导的结论。

## 验证与范围

- 只读审阅 `SD §4.11`、DID/F23 receipt ordering owner、P1 `07`、P9 `07`、AH10 accepted decision record、当前 control-action 调用路径、FailureCode enum 和 validator。
- 未运行测试；未编辑测试/生产代码/设计文档/固定 proposal。
- 仅本 review 结果用于记录 Design Gap 与后续需要的最小治理问题；不得宣称 P9 corruption disposition 已闭合。

## 后续 P9 disposition direction（候选更新，未落 owner documents）

后续独立 P9 审阅给出如下 direct-child prior Committed 裁决建议，现已并入 F23 固定候选草案
（本 review 上述结论是裁决前的只读状态快照，不再表示 A1 完全无方向）：

- A1 raw `result_json` JSON syntax corruption：在 decoder/control boundary内分类为非披露
  `PersistenceCorruption<"CommandStore">`，同时进入 direct-child 既有 P9 `ReceiptMismatch`
  fact/event transaction，最后 `AgentActionRecoveryBlocked`。该 ADT不携带 cause，P9 fact也不存
  corruption cause；当前无可观察 log/diagnostic sink，不声称已有。若要求operator-visible诊断，
  diagnostic-port/logger另为OPEN。不得把 decoder corruption原样返回成
  `AgentActionOperationalFailure` / `ControlActionHandlerRejected`。
- A2 可解析坏 shape 与 B 结构合法但 receipt/ref/authority/effect mismatch：保留 existing
  P9 `ReceiptMismatch` 或具体 failure code / fact/event。
- 普通非-direct-child prior consumer corruption：仅 operational failure，不创建 P9 fact。
- P9 fact/event transaction/identity/crash replay沿用现有 direct-child合同；transaction failure
  fail closed。P10 不加通用腐败 source，existing P9 AH10 fact→Action Required view保持不变。

该 follow-up 是候选措辞/实施方向，不是 `docs/design/**` landing 或新的实现通过证据。本波
加入 A1 isolated RED 检查当前 decoder 是否在 P9 fact sink 调用前退出；真实 P9 adapter 事务和
提交前/后 crash资格仍须实现阶段按已接受 P9 contract验证。
