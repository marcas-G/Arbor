# P6 — 06 Acceptance Stories

**Authority:** S1.4 步骤 1–6, S2 v1.7 §3–§8; DID v1.59 §11 P6, §5.4, v1.47 P8 UnboundLegacy route amendment, and v1.52 operator rebuild / v1 route-command qualification; P5 `05`（验收故事风格先例）; P6 `01`–`05`（含 D1–D4 约束断言）.
**Status:** FROZEN (manual governance adoption).

全部故事使用 deterministic Fake Provider（沿 P5 决策），同一 durable DB，`apps/` 既有 composition root 扩展，不新建第二套 runtime。

## 1. Story A — 第一层分工形成（含 human gate，D1 全约束）

1. `CreateProject` bootstrap 出 Root Workspace。
2. Root main Execution 与"用户"讨论后发出 `ProposeChildWorkspace(proposal-A)`。
3. 断言：无 `WorkspaceCreated`；FormationProposal admitted（Pending, revision=1）；human Inbox 含 governance 引用；`RequestGovernance` 观察 model-visible。
4. 用户 `RecordDecision { outcome: modify(proposal-A') }`。
5. 断言：proposal revision=2，内容为 A'，仍 Pending。
6. 用户 `RecordDecision { expectedProposalRevision: 1 }`（stale）→ `DomainError.RevisionConflict`，不产生任何 governance fact。
7. 用户 `RecordDecision { expectedProposalRevision: 2, outcome: approve }`。
8. 断言：`DecisionRecorded { proposalId, proposalRevision: 2 }` 产生；**此刻仍无 `WorkspaceCreated`**（approve 只是 governance fact）。
9. Application consumer 执行（deterministic CommandId）。
10. 断言：`WorkspaceCreated`（parent=Root，depth=1）+ `WorkAssigned`（initialWork）；子 Workspace Inbox 含 bootstrap 输入。
11. 重放步骤 7 的 decision 投递 → 幂等 Receipt，不重复 create。
12. 子 Workspace 首次 admission 的 Context 含五项 bootstrap 来源（01 §5），`rationale` 标注为 DataOnly。

## 2. Story B — 深层自主 formation（无 gate）

1. 子 Workspace（depth=1）执行中发出 `ProposeChildWorkspace(proposal-B)`。
2. 断言：**不经过** human Inbox / FormationProposal 实体；authority fact 投影判定（03 §3）后直接 `WorkspaceCreated`（depth=2）。
3. 构造 `resourceBoundaryDraft ⊄ parent 边界` 的反例 → `AuthorityDenied`，Execution 不失败，观察可续。
4. sibling 试图为非自己 parent 的 Workspace 发起 formation → `AuthorityDenied`（R3）。

## 3. Story C — specialist spawn 与结果回流（D3 全约束）

1. 父 Execution 发出 `SpawnSpecialist(spec)` → `ExecutionAdmitted(ExecutionBound)`，原子带 `ExecutionScoped` Session。
2. specialist 执行两 Turn 后 `Completed`。
3. 断言：父 Workspace Inbox 收到 SpecialistSettled（dedup key = specialistExecutionId + settlementFingerprint）；父 Session **零写入**（条目数不变为机械断言）；reevaluation 触发。
4. **重放 SpecialistSettled 投递两次** → Inbox 仍恰有一条（upsert-by-key）；无重复 canonical 副果。
5. `StopExecution` 提交后的父 Execution 再发 `SpawnSpecialist` → 拒绝新 admission（quiescence 列表）。

## 4. Story D — Communication 全链路（D2 约束）

1. Child 发 `Communicate(Report)` → `MessageSent` → parent Inbox admission（同一提交边界）。
2. 断言：parent 当前 active main **不被抢占**（不变量 21）；wake signal 已注册。
3. **断言：Report 到达不产生任何 Dependency 类事件/状态变化（D2：Report ≠ Deliverable，无 satisfaction 语义）**。
4. parent 消费 Report 后发 `Communicate(Reply, correlationId)` → child 侧 correlation 关闭（promotion）。
5. `Query` 发往非法收件人（sibling 之外/跨 Project）→ `AuthorityDenied`。

## 5. Story E — Human Steer（S2 切片）

1. 用户对 depth=1 Workspace 的 Open Work 明确选择 `DirectionGuidance` 或完整 `ContractAmendment` 并提交 `SteerWork(Normal)`。
2. 断言：无执行中断；两类操作都 revision++ 且记录完整快照；DirectionGuidance 保持 contract 不变并产生 `WorkSteered`，ContractAmendment 完整替换 contract 并产生 versioned `WorkAmended`；下次 admission 使用 canonical current contract，方向 guidance 独立标示。
3. `SteerWork(Critical)` 对同两类 typed operation 使用相同 Work CAS/history semantics，并在同一提交边界内发出相应 `WorkSteered`/`WorkAmended` + `StopExecution`；事务内 active main 进入 quiescence，无新 ProviderTurn/ToolInvocation/spawn；Stop 失败则整体回滚。
4. Work 保持 Open；reevaluation 后重新 admission（恢复自治，S2 §7）。
5. sibling 对该 Work 发 steer → `AuthorityDenied`。

**S2-RDG-01 governance acceptance (design only):** the same human SteerWork
may carry a non-normative `DirectionGuidance` or an explicit complete
`ContractAmendment`; legacy schema-v1 and `scope="Constraint"` mean guidance
only. An amendment advances the exact open Work revision once and records the
complete replacement snapshot; a partial/stale/unauthorized amendment has no
partial Work/history/Inbox/event commit. Normal/Critical share those contract,
CAS, history and replay semantics; Critical only adds the existing exact
Stop/quiescence leg. A new Verification uses the current revision's canonical
mission. An old Open Verification remains on its immutable old mission and can
conclude only for its old revision; it cannot satisfy new-revision Acceptance
or CompleteWork. Implementation and qualification remain separately gated.

## 6. Story F — Prompt Program 版本纪律（D4 约束）

1. 四个 Program v1 全量 eval 绿（05 §3 E1–E4）。
2. 机械断言：每个 Program 文件头含 `contractRevision + textVersion + textHash`；Manifest hash 一致。
3. 变更实验：textVersion bump 后未跑 eval → CI/验证门拒绝（合入条件 = eval 全量绿）。
4. 诱导性 eval：模型试图以 Report 充当交付/依赖满足 → E3 违禁断言触发。

## 7. Story I — P8 UnboundLegacy current-route Governance Inbox（DID v1.47/v1.52）

1. 用可识别但无法证明 permanent replay origin 的历史成功
   `RetryVerification` receipt 建立 fixture；migration 同一事务留下不可变
   `UnboundLegacy/OriginEvidenceIncomplete` disposition 和一个 P6 Governance
   Inbox entry。Inbox 使用现有 `Governance` kind 与
   `retry-verification-unbound:<commandId>` stable key，不新增 P6/P7/P14/P10
   kind/Attention source。
2. 验证 typed `RetryVerificationUnboundLegacy` 内容只含 CommandId、ProjectId、
   source WorkId/VerificationId、固定 disposition/reason 与 Inbox row
   timestamps/revision；任何 receipt JSON、summary、event JSON、fingerprint、
   path/host detail 都不出现在该条目。Agent/Session consumer 不获得条目；人类
   读取不消费、不 ACK、不 clear、不发 command/wake/ProviderTurn。
3. Root Work current route 只对当前 Root-local human 可见；child Work current
   route 只对当前 exact direct-Parent Workspace human 可见。Foreign/unauthenticated
   human 与 Agent 读取 fail closed。P12 每次按当前 canonical owner/Parent 与
   current P8 auth re-evaluate，Inbox row 本身不授予权限。
4. **v1 command-level N/A:** production 中不存在改变 canonical Work owner 或
   Workspace Parent 的 P1 command，因此 owner/Parent route-move 命令旅程、旧/新
   recipient 的 command commit 可见性和对应 command/process crash case 不属于 v1
   qualification。本 N/A 只针对不存在的 command，不把 same-key transaction helper
   或 route/rebuild invariant 列为 N/A。Any future separately-governed route-mutating
   P1 command must use one transaction to update canonical route and the same Inbox
   stable key. It must preserve old/new current-route visibility with no async window;
   Inbox `createdAt` remains, one real move increments revision/updatedAt once, and a
   no-op changes neither.
5. For such a future command only, if the same-transaction Inbox move cannot complete,
   it must use the existing P1 Gateway and return `TerminalRejected(AuthorityDenied)`
   (or the narrowest existing typed rejection), commit its normal receipt/attempt, and
   make zero canonical Work/Workspace/Event/Inbox/disposition mutation. Same tuple
   replays that receipt; a different CommandId independently rejects. Its command-level
   crash cases must cover receipt commit before/after. No pre-Gateway rejection/read.
6. Remove only the disposable fixture's Inbox projection row, then prune/corrupt receipt
   JSON 与相关 Domain Events；从 disposition 与当前 canonical Work/Workspace
   facts rebuild 一个当前 recipient row，不查询/解码 receipt、不依赖 Event
   retention。相同 stable key 的 source/disposition 内容不一致为 typed integrity
   corruption，不覆盖原行。Qualify the operator-only offline
   `p6:inbox-rebuild` on disposable schema 48 with the P39 maintenance permit,
   distinct P39 blocker-report `--p39-sidecar` and protected JSONL `--manifest`;
   use the same P39 primary connection and one `TransactionPort` transaction for the
   existing rebuild helper. Exercise lock refusal, sidecar `wx` winner/loser and
   crash/retry, pre-/mid-/post-commit process crashes, manifest reconciliation,
   idempotency, same-key revision behavior, canonical zero-mutation and current P8
   authorization after rebuild. The P39 pre-lock infrastructure-only effects must
   never create a primary, P6 projection, or JSONL committed mutation when the
   RuntimeShared holder blocks maintenance.
7. Ordered P8 migration 的 commit 前 crash 不留下 disposition 或对应 Inbox row；
   commit 后二者均存在。现有 migration `0045` 已固定并纳入当前 schema
   48 历史（schema 44→45）；其 DDL 和 backfill 不由本次 v1.52 proposal
   重开。本次接受只增加 schema-48 operator rebuild/route-command
   qualification disposition，不新增 migration、注册 migration 或推进
   schema high-water。

## 8. 机械断言清单（汇总）

```text
- 01 §4 两条 formation 链的每步事件序列与拒绝集与契约逐条一致
- D1：approve 与 create 是两个可观测步骤（DecisionRecorded ≠ WorkspaceCreated；stale revision 拒绝；幂等重投）
- D2：Report 无任何 Dependency 副果（负断言）
- D3：Inbox upsert-by-key 重放幂等；Parent Session 零写入
- D4：双层版本字段齐全；text 变更 → eval 强制门
- depth 判定纯结构计算（无模型参与）的单元证明
- capability ceiling 四项 validate-only 检查各有正/反例
- Inbox admission/promotion/consumption 三段各有独立可观测断言
- Story I：Governance kind/key/payload、current P8 authorization、same-P1-transaction route helper、future-command Gateway rejection contract、schema48 P39 operator rebuild / manifest / crash-restart / idempotency、disposition-only source and no-consume 断言；仅因当前无 recipient-changing P1 command，command-level route move/crash qualification 为 v1 N/A
- Normal/Critical steer 的中断差异可由 Execution 动作计数判定
- 既有 P5 验收故事不回归（重构护栏）
```

## 9. Must Not Decide

- No 真实 provider / 真实人类在线作为 gating 条件（human 角色由测试驱动）。
- No P7/P8 owner behavior enters the assertions except the fixed DID v1.47
  P8 `UnboundLegacy` trigger/disposition/replay boundary explicitly accepted
  for Story I; dependency/verification behavior outside that fixed boundary
  remains out of scope.
- No UI/projection 呈现验收（P10）。
