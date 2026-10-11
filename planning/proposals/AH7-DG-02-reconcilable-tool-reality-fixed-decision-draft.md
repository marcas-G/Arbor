# AH7-DG-02 — Reconcilable 外部现实证明与 shell 分级：固定治理决策稿

状态：**DRAFT / 等待人工治理接受；未接受、未授权实现**  
建议接受标识：`ACCEPT_RECONCILABLE_TOOL_REALITY_PROOF`  
基线：`db929654128b8e864d3733b95088f4edda0e4c43`（AH7 独立 worktree）  
历史稿：`planning/proposals/reconcilable-shell-reality-proof-decision-draft.md`，SHA-256
`41E0998B6B93648C0D0CA5767C97628F091E54E757299D1D585D0B4E71B50A9A`。

## 决策摘要

1. **任意 shell 默认不再声明 `Reconcilable`。** 新模型调用的通用
   `shell@3` 使用既有 `NonIdempotent` side-effect tag。`shell@2` 的冻结历史
   定义不被重写；它保持历史 `Reconcilable` 快照，但无已存 profile 的未结记录
   按 `StillUnknown(ProfileUnavailable)` 失败关闭，绝不用新 catalog 反向解释。
2. **`Reconcilable` 是可执行的 versioned profile 合同，不是工具名标签。** 仅
   Runtime 注册的精确 `(ToolDefinition name, version, hash)` 与
   `(ReconciliationProfileId, version, hash)` 绑定、含稳定外部 effect identity、
   可核验现实源和终局性/旧请求 fencing 保证的受限工具可以声明它。v1 不为任意
   shell 文本提供此 profile；模型不能提交、改写或选择 profile/effect key。
3. **任何 `MayHaveStarted` 恢复先 reconcile，且没有“停在 Unknown 就算已核对”。**
   仅 `NotOccurred` 的完整强证据可以进入受限重试资格；`Occurred` 必须同时提供
   可重建原 canonical settlement 和 bounded observation 的证据；其余一律
   `StillUnknown`，不再执行工具。
4. **重试需同一 invocation 身份、exact authority/resource/approval 快照仍有效、
   新 fence 有效、未 StopExecution，并有外部可证的 attempt finality。** 不满足时
   不执行；保留 `ReconciledNoEffect` 终结事实/typed result。每个 invocation 最多
   一个自动 replay attempt；超限不循环。
5. **工具现实核对是 P4-owned port，结果是 append-only P4 fact。** P9 只枚举并
   驱动，不能把 `ReconciliationSource.pending` 的 InvocationRef 当成现实证明。
   Occurred/NotOccurred/StillUnknown 的证据、Attempt 和 terminal settlement
   事务边界、P3 ToolResult/Action/cursor 与 P9 Attention 来源按下文唯一映射。
6. **历史无 profile/无 effect identity 的 unsettled `Reconcilable` 记录不迁移成
   `NonIdempotent` 的新写，也不猜效果。** 保留原语义快照，记录
   `StillUnknown(LegacyProfileUnavailable)`，不重放；由 P9 durable Attention 暴露。

本稿不修改 `docs/design/**`，也不构成实现授权。接受后仅按 §10 所列 owner contracts
落地；测试或代码不得先行把 `shell@2` 重新定义。

## 现有合同是否足够直接实现

**不足，AH7-DG-02 仍是设计缺口。** 冻结 P4 `01` §2 已定义四种 side-effect
语义，`Reconcilable` 要求“reconcile before deciding replay”；P4 `02` §2/§5
要求现实核对后再 replay；P4 `08` §5 却把任意 `shell@2` 固定为
`Reconcilable`。但：

- P4 `06` §4 的 `ReconciliationSource.pending` 只返回 InvocationRef；§6 明确它
  不拥有 provider/tool 外部核对逻辑。
- 当前 `ToolExecutor` 只有 `execute`，`shellExecutor` 直接 `spawnSync` 任意
  policy-allowed 文本；catalog 仅提供固定 `shell-v2-mount-relative-cwd` hash 和
  `sideEffectSemantics: Reconcilable`，没有 effect identity、profile、reconcile
  adapter、证据源或“旧命令之后不可能再生效”的终局性证明。
- P9 `02` §5 T3 要求真实 ReconciliationSource 外部现实核对；P9 `07` §1–§4
  只定义 recovery 顺序与状态处置，没有 `NotOccurred/Occurred/StillUnknown`
  的证据 schema、权限/资源绑定、Attempt/Facts 或 shell profile 选择规则。

因此 P4/P9 现有规则定了目标，但没有足以实现通用 shell 的证明合同。旧稿的方向
（任意 shell 无证明则 NonIdempotent、受限 profile 才 Reconcilable）正确；本稿
固定其证据、状态机、权限/资源复核、观察投影和旧数据策略，供人工接受，而不是
从“安全停在 OutcomeUnknown”推断 reconciliation 已完成。

## 术语与持久绑定

### ReconciliationProfile

Runtime-only catalog 注册项，至少包括：

```ts
interface ReconciliationProfileRef {
  readonly profileId: string;
  readonly version: string;
  readonly hash: string;
}
```

profile 由 owning tool/adapter 注册并由 ToolDefinition hash 精确绑定。它定义：

- 规范化输入与外部 effect identity/effectKey 的算法；effectKey 基于 Runtime
  `ToolInvocationId`、tool/profile exact version/hash、规范化参数摘要与目标资源快照，
  不接受模型传入的覆盖值。
- 可查询的权威现实源、查询新鲜度/终局性水位、成功/不存在证明格式，以及它如何
  证实一个 in-flight/旧 generation 尝试已终结且未来不能迟到生效。
- 对 `Occurred` 重建 canonical `ToolInvocationSettlement`、原 bounded
  observation/result Artifact 的能力；不能重建就只能给 `StillUnknown`。
- execute/reconcile 支持的外部幂等键、fencing/cancel/finality 能力和有限 attempt
  policy。profile 不得执行原命令作为“探测”，不得产生新外部 effect。

对纯自由文本 `shell@3`，Runtime 无法从命令字符串证明外部操作、effect identity、
完成终局性或原始 stdout/stderr 可重建，故不得注册 Reconcilable profile。任何真正
受限的将来工具必须是独立 version/hash 的 typed ToolDefinition/profile；不是在
shell policy 正则里给任意命令贴“可核对”标签。

### 每次 claim 冻结的 RecoveryBinding

P4 在 intent/claim durable transaction 记录 immutable binding（规范化 JSON + hash
或等价强类型列），包含：

- ExecutionId、ToolInvocationId、ProviderTurnId、LogicalActionId、callRef；
- 精确 ToolDefinition `(name, version, hash)`、SideEffectSemantics、profile
  `(id, version, hash)` 或显式无 profile；参数摘要、资源区域/目标 identity 摘要；
- InvocationAuthority sourceRevision、principal/subject、capability、PermissionGrant
  IDs+revisions、target、workspace/project policy revisions、controlBasisDigest；
- exact approval ID、批准 revision/subject/target/basis 绑定与 `consumedBy`；
- canonical resolved regions、ResourceBoundary/ResourceAdmission 所依据的
  environment/resource version/revision；
- `effectKey`、`attemptNo` 初值与 profile 证据协议版本。

不得存 model claim 作证据，不得把路径/命令原文复制到 Attention；敏感参数只存现有
受保护的 intent/argument digest，binding/fact 通过 content-addressed Artifact/ref
保留。任一 binding 字段不能被持久读取、哈希不符或 profile 版本不存在，核对只能
`StillUnknown`。

## 固定核对结果及证据规则

`ToolReconciliationPort.reconcile` 是只读/confirm/cancel/fence 外部状态的 P4 port，
不是 ToolExecutor 的 execute 重入。结果为闭合 union：

```ts
type ToolReconciliationResult =
  | { readonly _tag: "NotOccurred"; readonly proof: ReconciliationProofRef }
  | {
      readonly _tag: "Occurred";
      readonly proof: ReconciliationProofRef;
      readonly settlement: "Success" | "ExpectedFailure";
      readonly resultRef: ArtifactRef;
    }
  | {
      readonly _tag: "StillUnknown";
      readonly reasonCode: ReconciliationUnknownCode;
      readonly evidenceRef: ArtifactRef | null;
    };
```

`ReconciliationUnknownCode` 固定为：`ProfileUnavailable`,
`EffectIdentityUnavailable`, `ExternalSourceUnavailable`,
`ExternalSourceNotAuthoritative`, `EvidenceStale`, `EvidenceBindingMismatch`,
`AttemptNotFinal`, `ResultEvidenceUnavailable`, `ProfileVersionUnavailable`。
对这些原因不接受自由文本替代，也不接受“owner-approved equivalent”。

- **NotOccurred**：必须是对 exact `(effectKey, profile, attemptNo)` 的权威否定证明，
  有外部 source revision/watermark、查询时间、完整 visibility scope，并能证明此前
  attempt 已被 fence/cancel/terminally rejected 或超过协议 finality horizon，之后
  不可能迟到生效。Eventually-consistent “暂未查到”、timeout、文件缺失但旧 process
  仍可能写入、未覆盖的外部 region 都是 StillUnknown，不是 NotOccurred。
- **Occurred**：权威源证实 exact effect 已完成且终局；若不能重建实际 Success/
  ExpectedFailure 与 canonical bounded observation/resultRef（包括 stdout/result
  不可再读），应降为 StillUnknown，禁止编造 Success 或复用“不确定时”的输出。
- **StillUnknown**：无充分证据、结果冲突、source 不可用、profile/identity 不匹配、
  old attempt 仍可能迟到完成时的唯一结果。不得调用 Executor；保留 unresolved gate。

权威源 proof 必须覆盖 **外部 effect 与迟到 effect 风险** 两者。单次 GET 观察到
“无记录”不足以解除旧 worker 在非 fenceable 外部系统内继续写入的可能性。profile
必须提供外部 idempotency key 或可证明的 cancel/fence/finality 查询，否则只能
StillUnknown。

## 固定状态机、重试与 projection

P4 invocation-level `effect_admission_state` 保持单调：`NotAdmitted → MayHaveStarted`，
绝不因核对而倒退。为允许有证据的最多一次安全 replay，新增 append-only
`tool_invocation_effect_attempts`（同一 invocation/effectKey）和
`tool_reconciliation_facts`；每个 attempt 自己的 admission 同样单调。Invocation 顶层
MayHaveStarted 表示“至少一次尝试可能开始”，不是“任何 attempt 都必须仍 Unknown”。

```text
NotAdmitted, no P4 effect-admission commit
  → normal fresh authority/resource/approval/fence gate; no reconciliation

MayHaveStarted + unsettled + exact profile
  → reconcile exact attempt before any new Executor call
  → Occurred with reconstructable result: fact + P4 settlement commit
  → NotOccurred with definitive proof:
       revalidate full RecoveryBinding + current grant/policy/resource/approval
       and current lease/stop in one fenced P4 transaction
       if unchanged, no stop, attemptNo=0: record proof and admit attemptNo=1
       if changed/stopped/attemptNo=1: ReconciledNoEffect terminal result; no execute
  → StillUnknown or no profile:
       immutable fact + P9 Attention + ReconciliationPending/OutcomeUnknown; no execute

Settled P4 result + missing P3 ToolResult/Action/cursor
  → skip reconciliation and Executor; rebuild P3 projection from canonical resultRef/fact
```

重试必须保持同一个 Execution/ProviderTurn/LogicalAction/callRef/ToolInvocationId 和
approval consumer；消费审批不重做。attemptNo 0 是首次执行，attemptNo 1 是唯一自动
replay；attempt 1 再次 NotOccurred 时终结，不形成无限 loop。所有 admission/replay
与 proof/fact durable writes 使用 current full lease tuple、`expires_at > now` 和
`stop_requested_at IS NULL` 同事务 fencing。ReconciliationPort 的外部只读查询在
SQLite 事务外；其结果只有通过新 lease/current authority/version binding 检查后才能
提交。Stale generation 可以做只读诊断，但不能提交事实、settlement、Attention 或
Observation。

### 终结结果与 Attention 映射

P4 `ToolInvocationSettlement` 增加单独的 `ReconciledNoEffect`（不新增
SideEffectSemantics tag，也不冒充原 `Denied`）：它只表示已有权威 NotOccurred proof
后，系统确认没有 effect、但不执行 replay。闭合 reason code：
`AuthoritySnapshotChanged`, `ResourceSnapshotChanged`,
`ApprovalNoLongerAuthorized`, `StopRequested`, `ReplayLimitReached`。
`Denied` 仍只用于 P4 `NotAdmitted`；`ReconciledNoEffect` 必须同时带
`ReconciliationFactRef`。

- `Occurred`：P4 settlement 和 fact 同事务；`resultRef` 指向可重建 canonical bounded
  observation/result Artifact。P3 写唯一 ToolResult，精确
  `observationRef == AgentLoopAction.observation_source_ref == Session.source_ref`，
  再转换同一 Action/cursor。
- `ReconciledNoEffect`：P4 settlement 与 proof fact 同事务；P3 写有闭合 disposition
  的 bounded ToolResult（authority/resource/approval changed → `Denied` +
  `TerminalRejected`; `StopRequested` → `Interrupted` + existing stop disposition;
  `ReplayLimitReached` → `ExpectedFailure` + `Applied`），不伪称命令成功。相同 fact
  重放只收敛同一 Observation/Action/cursor。
- `StillUnknown`：P4 invocation 保持 MayHaveStarted/unsettled；P9 durable Attention
  fact 由 `(invocationId, attemptNo, profileHash, reasonCode, evidenceHash)` 确定且
  幂等，AgentLoop action 为 `ReconciliationPending`，Execution 受
  `OutcomeUnknown(ReconciliationRequired)` gate 阻挡。可附 typed OutcomeUnknown
  ToolResult，但 observation 只报告“未能证实，未重放”，`source_ref` 指向 fact；
  不写 Success/ExpectedFailure，也不推进普通完成。
- User-visible Attention 不含 raw command/secret/host path；只引用
  invocation/profile/fact 和闭合 reason code。新权限授予或当前 catalog 升级本身不
  自动重放旧 invocation；需相同 invocation 上显式重新核对或由人工发起新调用。

## Permission / resource binding 决策

`NotOccurred` 只证明外部 effect 状态，不重新授权旧调用。允许 attemptNo=1 的唯一条件：

1. current Execution lease 完整 tuple 有效、未 StopExecution；
2. 当前 Authority sourceRevision、principal、PermissionGrant IDs/revisions、capability/
   target、workspace/project policy revisions、controlBasisDigest 与原 RecoveryBinding
   完全相同且仍未过期/撤销；
3. canonical resource address/region、ResourceBoundary/Admission 版本与原 binding
   完全相同且仍 admitted；
4. exact approval 仍为原 invocation 消费者绑定（若适用），未撤销/过期/替换；不再
   consume；
5. ToolDefinition/profile hash 与原绑定精确可用；effectKey、argument digest、source
   watermark/proof 无冲突；
6. attemptNo=0 且 profile 的 stale-attempt fencing/finality 证明已成立。

任一版本变化即不执行 attemptNo=1。不可把“当前权限仍大致相似”、新的 resource
boundary 或新 shell profile 当作等价授权。发生变化时若 NotOccurred proof 完整则提交
`ReconciledNoEffect` 对应 reason；若 proof 本身受权限/资源缺失影响而无法权威核对，
则 StillUnknown/Attention。

## 历史数据与版本迁移

- `read@2` 保持 ReadOnly；`patch@2` 保持 Idempotent；不修改既有已 settle 结果。
- 新 catalog 使用 `shell@3`/新 definition hash，SideEffectSemantics 固定
  `NonIdempotent`；shell policy / requiresApproval 仍是单独维度。任意模型 shell 文本
  无 profile，不得声明 Reconcilable。
- `shell@2` 已 settled invocation 原结果重放；未结 `NotAdmitted` 仍按 P4 当前 gate
  恢复；未结 `MayHaveStarted`/`LegacyUnknown` 因没有历史 profile/effectKey/source
  snapshot 记为 `StillUnknown(LegacyProfileUnavailable)`，不补造 effect identity，不
  重执行，不把其 stored `Reconcilable` 值改写成 v3。若迁移无法证明是哪种状态，按
  LegacyUnknown 失败关闭。
- 新 migration 为新的 ToolDefinition/profile/effect key binding、effect attempts、
  append-only reconciliation facts 和 P9 Attention source 增加不可省略列/约束/索引；
  history rows 不回填 profile；unique `(invocationId, attemptNo)`、`factId` 和
  deterministic Attention identity 防双 worker 重复落账。Migration 前后的 crash
  replay都基于同一 P4/P9 durable state，无意外默认 Reconcilable。

## 资格矩阵与阶段门

验收 owner 与边界见
`planning/tasks/AH7-DG-02-reconciliation-qualification-matrix.md`。最低测试必须验证：

- `NotOccurred`/`Occurred`/`StillUnknown` 的可信证据校验、乱序/重复/过期/source
  outage/profile hash mismatch/结果缺失都 fail closed；
- effect admission 前 kill；admission 后但 effect 前 kill；effect 已发生、settlement
  前 kill；P4 settlement 后、P3 ToolResult/Action/cursor 前后 kill；每侧 crash/restart
  后同 invocation 与唯一外部 effect/ToolResult；
- 旧 worker 仍可能在外部系统迟到生效时，不把空查询当 NotOccurred；Profile 的外部
  fencing/idempotency key 与双 daemon race；
- grant/policy/verifier/resource version 或 approval revoke/expiry 发生在 effect 前、
  MayHaveStarted 后、核对后/replay 前的矩阵；任何改变不得 replay；
- 有权限不变时的唯一一次 attemptNo=1；attempt 1 crash/reconcile 不循环；stop 在
  replay gate 前阻止新 effect；
- Historical shell@2 无 profile 与 retired profile fail-closed；新的 shell@3
  NonIdempotent no-blind-replay；read@2/patch@2 不回归；
- Occurred resultRef/Observation 可真实重建；ToolResult observationRef 精确等于
  Action/Session source、唯一；StillUnknown 进入可见 Attention/P9 durable fact，不
  变普通 Applied/Completed。

现有 baseline RED/reproduction 复用
`tests/functional/process/agent-action-ah7-reconcilable.functional.test.ts` 的
真实 marker-after-effect / settlement-missing 场景：它 PASS 的含义只是 marker 未被
盲重放、Action 为 ReconciliationPending、Execution 为 OutcomeUnknown。它**不是**
RealityProof PASS；新的 deterministic pending assertions 与层级矩阵在接受前只记为
资格计划，本稿工作不运行真实 daemon、不改变测试状态。

## 建议 landing package（接受后）

仅在人工接受本固定稿后，由 owner landing 更新：

- P4 `01`（ReconciledNoEffect result）、`02`（reconcile/admission/retry 顺序）、
  `06`（profile binding/attempts/facts/port/SQL/fence）、`08`（shell@3 与可核 Profile）；
- P9 `02`（T3/AH7-DG-02 crash/finality/权限矩阵）、`07`（状态收敛、P3 observation 与
  Attention recovery）；必要的 P3 `08` 仅同步 ToolResult/Action/cursor source mapping。

不得先改生产、migration、`docs/design/**`、catalog 测试或把当前
OutcomeUnknown 安全停止结果升级成“现实已核对”。人工接受与实现授权须分别留档。
