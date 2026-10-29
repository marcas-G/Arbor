# AH7 action / tool handoff — 部分进程崩溃资格结果

日期：2026-10-05

状态：**部分 PASS，AH7 未闭合。**

## 已取得的真实进程证据

`tests/functional/process/agent-action-ah7-pending-intent.functional.test.ts`
在四个独立提交点收到精确 probe 后杀死首个 daemon，以同一 SQLite DB 和普通生产
入口重启。四点分别为 AgentLoop `Pending` action intent、P4 ToolInvocation intent、
P4 tool settlement，以及 Session ToolResult + action `Applied` + Step cursor 的原子
收口。ReadOnly `read` 的四条用例合并 4/4 PASS：同一 logicalActionId/callRef 与
ToolInvocationId 保持稳定；P4 已结算后复用原 Artifact，未再产生 Artifact；Session
ToolResult 恰一份，Provider 首次工具决策没有重放。

`tests/functional/process/agent-action-ah7-reconcilable.functional.test.ts`
分别在 Reconcilable `shell` intent 已落盘但 executor 尚未进入，以及 shell
外部效应已发生、P4 settlement 尚未提交时杀进程。首侧效应文件始终不存在；
后侧文件仅有一次追加的 marker，重启后内容不变。两侧均不盲执行 shell；原
action 是 `ReconciliationPending`，Execution 是 `OutcomeUnknown`。这些用例
只证明安全停止，不宣称完成外部现实 reconciliation。

测试发现并修复了三条实现缺陷：

1. 生产调度遇已有 Active Work 就 `Noop`，重启后 Pending action 永久停滞；
   scheduler tick 现在在旧租约到期后恢复 exact Work Execution，并跳过待人工批准。
2. ToolRuntime 对已存在 P4 intent 直接再次 INSERT，触发主键冲突；现在先比较
   exact intent，再按副作用语义决定安全重入或 OutcomeUnknown。已结算 Success 且
   Artifact 可读时复用原结果。
3. ToolRuntime 的 OutcomeUnknown 曾被包装成普通 Observation，使 AgentLoop 错记
   `Applied`；现在映射为 `OutcomeUnknown(ReconciliationRequired)` settlement，
   保留 `ReconciliationPending`。

另外，`packages/tool-runtime/test/p4-approval-reentry.test.ts` 证明同一 invocation
已消费的 exact approval 可在重启后复用；不同 invocation 不能借此重复消费。
`apps/single-workspace/test/executable-invocation-identity.test.ts` 证明新调用 ID 同时
绑定 Execution 与 callRef，同一 Execution 重试稳定；精确匹配的历史 callRef-only
记录仍按旧 ID 继续。P4 pipeline 的三个旧 fake store 补齐 `findById` Port 方法。

## 尚未通过 / 不能宣称关闭

- Reconcilable 工具在 effect 已发生、P4 settlement 未提交时，已证明不盲重放；
  仍缺**主动核对外部现实并收敛**的测试与实现。
- 已结算的非 Success（例如 ExpectedFailure）没有持久的 bounded Observation，
  resultRef 又可为空。P4 record 仅有 settlement/resultRef，不能精确重建原模型
  观察；需要设计归属确认和红灯反例，不能伪造成功或把已知失败说成外部效应未知。
- exact approval consumption 与 P4 settlement 目前仍是不同事务；需覆盖两侧
  crash，并按冻结 P4 合同收敛。
- 非幂等 effect 未结算、两动作交错、ControlBasis stale、并发同 invocation 等
  AH7 子边界仍缺进程资格。

本批 `pnpm check` PASS：架构 155、核心 1680 + 3 skipped、Web 216。
`26f80f2` 上 `pnpm test:functional` PASS：公开进程 29/29、浏览器 2/2，
包含从该提交的干净检出测试，零重试。隔离 AH7-DG-01 红灯仍失败，不计入
正式 PASS。治理审阅见 `planning/results/AH7-DG-01-governance-readiness.review.md`。
AH8–AH14 仍 OPEN。

## 2026-10-16 P40 schema-44 qualification addendum

The earlier DG01 paragraph above is historical and is superseded by the
accepted DID v1.41 P40 Observation contract. On schema 44, P4 persists the
bounded terminal Observation/version/hash with settlement. The focused result
`planning/results/AH7-DG-01-P40-expectedfailure-process-replay.result.md`
qualifies one real-daemon ExpectedFailure boundary: P4/P40 commit → SIGKILL →
P3 ToolResult/Action/cursor recovery, with exact evidence bytes and no executor
re-entry. Schema-44 SQLite adapter tests separately prove Missing and
HashMismatch evidence fail closed; those adapter tests are not process
qualification.

The earlier DG03 review requiring approval consumption and terminal
settlement in one transaction is also superseded by the accepted
`ACCEPT_TOOL_APPROVAL_SETTLEMENT_ATOMICITY` contract: exact approval consume is
atomic with P4 intent claim, while terminal settlement remains separate.
The P40 ExpectedFailure process qualification proves one original `read`
ToolCall decision and no Executor replay (including the late-file
counterfactual). It permits zero or one completion Provider call after P3
projection; it does not establish a general completion-response contract.
AH7 remains PARTIAL / OPEN; positive production Reconcilable proof/recovery
and the remaining crash/concurrency matrix are not qualified by this addendum.

## 2026-10-17 AH7-DG-02 P40/P3 crash-matrix source addendum

`tests/functional/process/agent-action-ah7-reconcilable.functional.test.ts`
now contains four P40 terminal-selection cases (NotOccurred/Occurred, each
before and after settlement COMMIT) and four P3 terminal ActionResult
projection cases (NotOccurred/Occurred, each before and after commit).
StillUnknown is covered by its independent terminal recovery case, not as an
ActionResult-commit boundary. The child
process test probe gates those durable boundaries; each case checks the
independently visible pre/post-commit state, then restarts and checks the
existing exact invocation, selected fact, result, action, observation and
external-effect invariants. NotOccurred's P40 terminal cases use the existing
test-only resource-revision change to reach the terminal
`ReconciledNoEffect` selection; P3 NotOccurred cases retain the ordinary
single same-invocation retry.

At the time of this source-addendum these were **source additions only**;
real-process qualification is recorded in the later matrix progress sections
below. No AH7 phase-closure claim is made. AH7 remains PARTIAL / OPEN.

The exact P39 replay path now has a P4 pipeline code checkpoint documented in
`planning/results/AH7-DG02-reconciliation-runtime-shell-v3-implementation.result.md`:
it binds recovery to the persisted RecoveryBinding/attempt/profile and delays
the current snapshot retry decision until after reality reconciliation.
Focused P4 pipeline tests pass 44/44, including changed-boundary denial and
tampered binding/recorded-region fail-closed cases. The earlier real-process
NotOccurred-before-P40-commit case failed to converge on the pre-fix candidate;
it has not yet been rerun against this repair. P40 real-process qualification
and all P3 crash-side qualification therefore remain pending; AH7 remains
PARTIAL / OPEN.

The earlier 44-test code checkpoint was superseded by the B1 terminal receipt
change: settled RNO now replays through exact model/persisted identity and the
fenced P40 reader before any current-region admission or reconciliation.
Focused receipt tests pass 3/3; the complete P4 pipeline passes 47/47, with
typecheck, Biome and `git diff --check` passing. This is still unit/code
evidence only; no real-process qualification was run for B1. AH7 remains
PARTIAL / OPEN.

B2 narrows that path to exact terminal P39 candidates and keeps ordinary
settled receipts on strict current-region replay. P40 read, fence assertion,
and selected P39 evidence now run in one transaction. Focused receipt cases
pass 11/11 and the complete P4 pipeline passes 55/55; typecheck, Biome and
`git diff --check` pass. This remains unit/code evidence; no real-process run
or AH7 closure is claimed.

The subsequent provenance correction makes selected P39 evidence, rather than
the terminal settlement tag, authorize region-drift receipt replay. A missing
selection falls back to strict current-region handling; a present mismatched
selection fails closed. Occurred ExpectedFailure receipts require recorded P4
resultRef `null` while the authenticated selected P39 fact retains a non-null
artifact ref; Success requires three-way resultRef equality. Focused receipt
tests pass 3/3 and full P4 pipeline 57/57; typecheck, Biome and diff-check
pass. Still no real-process run for this checkpoint; AH7 remains PARTIAL /
OPEN.

### P40 NotOccurred settlement-commit-after checkpoint

The isolated real-process case `qualifies the P40 NotOccurred selection
across AH7AfterToolSettlementCommit` passes 1/1 (serial, no file parallelism,
zero retries). The P40 terminal fact/selection and action projection checks
pass. The recovered source step retains the same provider-turn id, decoded
output hash, and model-output session sequence; the diagnostic run observed
`next_action_index = 0`. Since this boundary qualifies P40 settlement only,
the P40 oracle now permits cursor 0 or 1 and records the observed cursor;
non-P40 recovery cases still require cursor 1. This does not qualify P3
projection convergence or the other P40 matrix cells. AH7 remains PARTIAL /
OPEN.

### P40 reconciliation settlement-commit matrix progress

All four P40 settlement-commit cells have isolated serial real-process PASS
evidence (zero retries): NotOccurred × before commit (75.252s), NotOccurred ×
after commit (51.454s), Occurred × before commit (111.027s), and Occurred ×
after commit (112.616s). Occurred cases model the real causal ordering: the
first daemon reaches
`AH7AfterToolEffectBeforeSettlement`, so the external effect and result
artifact exist before recovery returns Occurred. Resource drift is injected
during reconciliation, but the terminal Success must retain reconciliation
provenance, selected fact/resultRef and the single external effect. The test
oracle only treats NotOccurred resource/authority/approval/stop drift as a
no-effect retry denial; P40-only source-step cursor remains 0 or 1 while its
provider-turn identity/hash/session sequence stay exact. At the P40 after-
commit probe the P3 ToolResult is still absent; after the next restart the
final assertions require unique Action/ToolResult convergence. The separate
P3 matrix evidence is recorded below. The initial Occurred
fixture used a pre-executor kill and could not yield a real Occurred result;
after correcting that boundary, a shared RNO-only wait predicate and then an
over-eager P3-at-P40-boundary oracle were corrected. The resulting four P40
cells pass; this does not close AH7 or qualify the separate P3 matrix.

### P3 NotOccurred ActionResult-commit checkpoint

The NotOccurred P3 projection pair also passes in isolated serial real-process
runs with zero retries: `recovers NotOccurred across
AH7BeforeActionResultCommit` (105.024s) and `recovers NotOccurred across
AH7AfterActionResultCommit` (81.591s). Both sides recover the same selected
P39/P40 no-effect fact into one Action result and one ToolResult, without a
second shell effect; the before-commit snapshot is Pending/no ToolResult and
the after-commit snapshot is Applied with its committed ToolResult. At that
checkpoint the Occurred P3 pair and independent StillUnknown case remained
pending.

### P3 Occurred ActionResult-commit checkpoint

The Occurred P3 projection pair passes in isolated serial real-process runs
with zero retries: `recovers Occurred across AH7BeforeActionResultCommit`
(105.032s) and `recovers Occurred across AH7AfterActionResultCommit`
(81.429s). For these P3 cells the first crash is after the actual shell
effect and result artifact but before settlement, allowing the trusted
profile to return Occurred from its external-effect ledger. Both sides
converge the authenticated P39 selection/P40 Success into one Applied Action
and one ToolResult while preserving the single real external effect. P3
NotOccurred and Occurred pass both ActionResult commit sides. StillUnknown is
qualified separately via the terminal recovery case below; AH7 remains
PARTIAL / OPEN.

### Independent StillUnknown terminal recovery

The existing `recovers StillUnknown from a test-only trusted profile after a
daemon restart` case passes 1/1 (75.188s, serial, zero retries). The initial
crash is after effect admission but before the first P39 fact; on restart the
unknown RecoveryInput fact commits, the daemon is killed after commit, and a
second restart converges. P4 remains unsettled, P3 reports
`OutcomeUnknown`/`ReconciliationPending`, and the executor/effect is not
replayed; no result is inferred. StillUnknown does not enter the P3
ActionResult-commit matrix because that runtime boundary is not reached. AH7
remains PARTIAL / OPEN; production profile-version drift and other authorized
takeover/concurrency cells remain open.
