# P1 Governance Patch (DRAFT — not applied)

Status: **DRAFT / AWAITING REVIEW**. Nothing in `docs/design/**` has been
modified. This file is the proposed patch for `P1-DG-01` … `P1-DG-10`.

Version plan (proposed): **DID v1.4 → v1.5** (governance patch).
System Design v1.3 is **unchanged** (no P1 gap changes System-level semantics).

## 1. Authority classification

| Gap | Classification | Needs DID edit |
|---|---|---|
| P1-DG-01 | **upstream frozen-design defect** — error-algebra layering unspecified; frozen `FencingRejected` has no owner | yes |
| P1-DG-02 | **upstream frozen-design defect** — §9.9 `Pending` durability contradicts §7.4 rollback | yes |
| P1-DG-03 | **upstream frozen-design defect** — `payload_hash` (§9.9) vs `semanticRequestFingerprint` (§4.1) | yes |
| P1-DG-04 | **upstream frozen-design defect** — §11 P1 vs P2 fencing scope; Stop-quiescence vs fence predicate | yes |
| P1-DG-05 | **upstream frozen-design defect** — `CreateProject` bootstrap contradiction | yes |
| P1-DG-06 | **P1 phase-scoped closure** — §2.3 leaves sequence scope open; version/offset are P1 contracts | no |
| P1-DG-07 | **P1 phase-scoped closure** — §13 delegates DDL/migration; mapping is a contract | no |
| P1-DG-08 | **P1 phase-scoped closure** — P1 owns ownership persistence | no |
| P1-DG-09 | **P1 phase-scoped closure** — §13 delegates migration; retention is P1 | no |
| P1-DG-10 | **upstream frozen-design defect** (port classification §7.2 vs Appendix B) + phase-scoped sub-items (ID gen, `AssignWork` errors, child-workspace phase) | yes (classification) |

## 2. Patch — DID v1.4 → v1.5

### 2.0 Header

```diff
-**Version:** 1.4
-**Status:** TOP-LEVEL ARCHITECTURE FROZEN — governance patch (P0-RELEVANT CLOSURE CLOSED)
-**Supersedes:** v1.3
+**Version:** 1.5
+**Status:** TOP-LEVEL ARCHITECTURE FROZEN — governance patch (P0 + P1-RELEVANT CLOSURE)
+**Supersedes:** v1.4
 **Date:** 2026-09-20
```

Add changelog block:

```text
Governance changes (v1.4 → v1.5):
- P1-DG-01: error-algebra layering (DomainError / CommandRejection / operational)
- P1-DG-02: command resolution states reconciled with the transaction rollback rule
- P1-DG-03: idempotency identity unified on semanticRequestFingerprint
- P1-DG-04: P1 vs P2 fencing scope + fence predicate owner + Stop-quiescence
- P1-DG-05: CreateProject bootstrap contract
- P1-DG-10: TransactionPort/CommandStore/DomainEventJournal package ownership
```

### 2.1 P1-DG-01 — error-algebra layering

Insert a new §6A.15 after §6A.14:

```text
## 6A.15 Error algebra layering (P1 closure)

三类 failure 必须分开，且各有归属：

DomainError (pure domain transition 的 expected rejection)
  IdempotencyConflict / AuthorityDenied / RevisionConflict / WorkNotOpen /
  TerminalLifecycleMutation / RetirePreconditionFailed /
  ActiveExecutionConflict / VerificationAcceptanceMismatch /
  DependencyNotSatisfiable / PermissionRevoked

CommandRejection = DomainError | FencingRejected
  = CommandResolution.TerminalRejected 的 payload

OperationalFailure (非 authoritative)
  PersistenceUnavailable / transport / transient
  = 不产生 CommandResolution；可 retry，产生新的 CommandAttempt

规则：
- FencingRejected 由 persistence enforcement 产生（§6A.5），是 terminal
  CommandRejection，不是 DomainError；payload 至少含 executionId 与
  observedGeneration。
- PersistenceUnavailable 是 retryable operational failure，绝不写入
  commands.terminal_error_json。
- CommandResolution.TerminalRejected 携带 CommandRejection。
```

**P0 artifact impact:** `packages/domain/src/command.ts` currently types
`TerminalRejected` as `DomainError`. P1 must widen it to `CommandRejection`
(add `FencingRejected`). Recorded as a P0→P1 contract evolution, not a P0
reopen.

### 2.2 P1-DG-02 — resolution states vs rollback

Amend §9.9 `commands.resolution` semantics:

```diff
-resolution                Pending | Committed | TerminalRejected
+resolution                Pending | Committed | TerminalRejected
+  Pending 是 durable 预登记状态，写入独立的 pre-attempt transaction，
+  不是 authoritative CommandResolution。
```

Add the resolution/rollback contract:

```text
Pre-attempt registration (separate tx):
  INSERT commands(command_id, project_id, semantic_request_fingerprint,
                   resolution = Pending, created_at)
  COMMIT

Semantic attempt (one tx):
  BEGIN
  → authoritative fence (if ExecutionOrigin)
  → canonical reads + preconditions + transition
  → canonical writes
  → UPDATE commands SET resolution = Committed | TerminalRejected,
       result_json / terminal_error_json, settled_at = now
  → append Domain Events (Committed only)
  COMMIT

Retryable operational failure:
  ROLLBACK semantic tx
  → command row remains Pending
  → record command_attempts(outcome = RetryableOperationalFailure)
  → bounded retry

Authoritative CommandResolution = Committed | TerminalRejected
(no Pending); Pending is a durable pre-registration, not a resolution.
```

Also freeze attempt vocabulary (amend §9.9 `command_attempts`):

```text
outcome ∈ { Committed | TerminalRejected | RetryableOperationalFailure }
failure_kind? = operational failure category (nullable)
attempt_no 从 0 开始（与 P0 createCommandAttempt 一致）
```

**P0 artifact impact:** `CommandResolution` stays `Committed |
TerminalRejected` (correct); `CommandReceipt` view fields are frozen in the
P1 contract (projectId, fingerprint, resolution, result/error, createdAt,
settledAt), not in P0.

### 2.3 P1-DG-03 — idempotency identity

Amend §9.9 `commands` column:

```diff
-payload_hash
+semantic_request_fingerprint   // 与 §4.1 semanticRequestFingerprint 同一值
+schema_version                 // 独立列
+fingerprint_algorithm_version  // 序列化/哈希算法版本
```

Add to §4.1:

```text
Canonical serialization contract (frozen):
- 稳定 key 排序；undefined 视为 absent；number/boolean/string/array/object 的
  规范编码；tagged union 以 _tag 参与。
Hash: 由 P1 contract 冻结算法与宽度（不得使用 32-bit 作为 durable identity）。
IdempotencyConflict 当且仅当 same command_id 且 fingerprint 不同。
```

**P0 artifact impact:** P0's FNV-1a 32-bit fingerprint is an interim value;
P1 freezes the durable algorithm + version. P0 tests remain valid.

### 2.4 P1-DG-04 — fencing scope + predicate owner + Stop

Amend §11 P1/P2 scope:

```diff
 P1 — Persistence + Command Core
 ...
-atomic State + Receipt + Event + authoritative fencing
+atomic State + Receipt + Event + authoritative fence *validation hook*
+(lease acquisition/lifecycle remains P2)
```

Amend §9.7:

```text
Authoritative fence validation 由 CommandStore/TransactionPort 的 canonical
mutation path 执行；ExecutionRepository 只提供 lease/generation 读写。
Fence predicate（对 ExecutionOrigin command）：
  execution_id = ? AND generation = ? AND settled_at IS NULL
  AND stop_requested_at IS NULL
Stop-quiescence（§3.4）由 stop_requested_at 参与同一 predicate 表达；
不新增独立 lifecycle state。
```

**P0 artifact impact:** `Execution` needs durable `stopRequestedAt` /
`settledAt` at P1; P0's in-memory `stopRequested` is the domain projection.

### 2.5 P1-DG-05 — CreateProject bootstrap

Amend §12.11 Project `CreateProject` row / §4.1:

```text
CreateProject bootstrap contract:
- projectId 由 caller 预分配（UUIDv7 + prj_），CommandEnvelope.projectId 即该值；
  CreateProject 不依赖一个已存在的 Project row。
- payload 必须提供 Root Workspace 的 ResponsibilityDefinition /
  ResourceBoundary / ResponsibilityBoundAgentBinding / WorkspacePolicy /
  ProjectPolicy / default configuration / environmentRef。
- rootWorkspaceId 与 root primarySessionId 由 caller 预分配。
- 单事务原子创建 Project + Root Workspace + Primary Session（§9.13 deferred FK）。
- authority: bootstrap principal；无 authority → AuthorityDenied。
- emitted events: ProjectCreated 与 WorkspaceCreated（同一事务，顺序
  ProjectCreated → WorkspaceCreated）。
```

### 2.6 P1-DG-10 — port ownership

Amend Appendix B to match §7.2 (Persistence ports):

```diff
-Application (Effect services)
-├── CommandGateway(CommandEnvelope, CommandSubmissionContext)
-├── TransactionPort
-├── CommandStore / Receipt
-└── DomainEventJournal
+Application (Effect services)
+├── CommandGateway(CommandEnvelope, CommandSubmissionContext)
+│     (uses Persistence ports below)
+Persistence ports (§7.2)
+├── TransactionPort
+├── CommandStore / Receipt
+└── DomainEventJournal
```

Phase-scoped sub-items (closed in P1 contracts, no DID edit):
ID-generation ownership; `AssignWork` rejection set; `CreateChildWorkspace`
P1-vs-P6 ownership + child Primary Session atomicity.

## 3. Phase-scoped closures (no DID edit)

| Gap | Closed by |
|---|---|
| P1-DG-06 | P1 `05-event-journal.md`: one sequence mechanism + `eventVersion` policy + offset/projection tx boundary |
| P1-DG-07 | P1 `04-sqlite-schema.md`: deferred-FK declarations, table↔domain mapping, root uniqueness constraint |
| P1-DG-08 | P1 `04-sqlite-schema.md`: claim release/supersede, CAS columns, conflict-load index |
| P1-DG-09 | P1 `04-sqlite-schema.md` + `06-recovery-matrix.md`: retention/delete + migration mechanism |

## 4. Post-apply audit (proposed)

```bash
grep -n "FencingRejected" docs/design/03-detailed-implementation-design.md   # §6A.15 + refs
grep -n "semantic_request_fingerprint" docs/design/03-detailed-implementation-design.md
grep -n "stop_requested_at" docs/design/03-detailed-implementation-design.md
grep -n "CreateProject bootstrap" docs/design/03-detailed-implementation-design.md
grep -n "payload_hash" docs/design/03-detailed-implementation-design.md      # 0 live uses
```

## 5. Apply gate

**Not applied.** Awaiting explicit approval of this diff. On approval:
apply to DID (v1.5), mark P1-DG-01/02/03/04/05/10 `RESOLVED`, leave
P1-DG-06/07/08/09 `OPEN (phase-scoped)`, then write
`docs/design/implementation/P1/**`.
