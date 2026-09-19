# P1 Governance Patch (DRAFT v2 — not applied)

Status: **DRAFT / AWAITING REVIEW**. Nothing in `docs/design/**` modified.
Version plan: **DID v1.4 → v1.5**. System Design v1.3 **unchanged**.

Revision basis (user rulings): DG-01 parameterized `CommandResolution` +
Application-owned `CommandRejection`; DG-02 single-transaction, no durable
`Pending`; DG-03 unified fingerprint name + version columns, algorithm →
P1 phase contract; DG-04 fence validation separated from stop/quiescence
admission; DG-05 single-tx bootstrap + explicit Session-event rule; DG-10 as
drafted.

## 1. Authority classification

| Gap | Classification | DID edit |
|---|---|---|
| P1-DG-01 | upstream frozen-design defect | yes |
| P1-DG-02 | upstream frozen-design defect | yes |
| P1-DG-03 | upstream frozen-design defect | yes |
| P1-DG-04 | upstream frozen-design defect | yes |
| P1-DG-05 | upstream frozen-design defect | yes |
| P1-DG-06 | P1 phase-scoped closure | no |
| P1-DG-07 | P1 phase-scoped closure | no |
| P1-DG-08 | P1 phase-scoped closure | no |
| P1-DG-09 | P1 phase-scoped closure | no |
| P1-DG-10 | upstream defect (port classification) + phase-scoped sub-items | yes |

## 2. DID v1.4 → v1.5 diff

### 2.0 Header

```diff
-**Version:** 1.4
-**Status:** TOP-LEVEL ARCHITECTURE FROZEN — governance patch (P0-RELEVANT CLOSURE CLOSED)
-**Supersedes:** v1.3
+**Version:** 1.5
+**Status:** TOP-LEVEL ARCHITECTURE FROZEN — governance patch (P0 + P1-RELEVANT CLOSURE)
+**Supersedes:** v1.4
```

```text
Governance changes (v1.4 → v1.5):
- P1-DG-01: parameterized CommandResolution + Application-owned CommandRejection
- P1-DG-02: single-transaction command resolution; commands persist Committed | TerminalRejected only
- P1-DG-03: semantic_request_fingerprint unified + algorithm/version columns
- P1-DG-04: fence validation separated from stop/quiescence admission
- P1-DG-05: CreateProject single-transaction bootstrap + explicit Session-event rule
- P1-DG-10: TransactionPort/CommandStore/DomainEventJournal package ownership
```

### 2.1 P1-DG-01 — failure algebra layering (new §6A.15)

```text
## 6A.15 Failure algebra layering (P1 closure)

三层分离：

1) DomainError — pure domain transition 的 expected rejection。
   Domain 不得依赖 Application 的任何 rejection 类型。
   DomainError =
     IdempotencyConflict | AuthorityDenied | RevisionConflict | WorkNotOpen |
     TerminalLifecycleMutation | RetirePreconditionFailed |
     ActiveExecutionConflict | VerificationAcceptanceMismatch |
     DependencyNotSatisfiable | PermissionRevoked | ExecutionStopRequested

2) CommandRejection (Application-owned) — CommandResolution.TerminalRejected
   的 payload。
     CommandRejection ⊇ DomainError
     CommandRejection 额外包含 persistence/ownership terminal rejection：
       FencingRejected

3) OperationalFailure — 非 authoritative、非 terminal；不进入
   CommandResolution；不冻结为顶层单一 closed union，由 owning layer
   按 phase 细化（如 PersistenceUnavailable / transport / transient）。

CommandResolution 是参数化 ADT：

  CommandResolution<Result, Rejection> =
      Committed(Result)
    | TerminalRejected(Rejection)

  Domain 内部：CommandResolution<R, DomainError>
  Application boundary：CommandResolution<R, CommandRejection>

规则：
- FencingRejected 属于 Application CommandRejection，不是 DomainError。
- OperationalFailure 不产生 authoritative resolution，可 retry。
```

### 2.2 P1-DG-02 — single-transaction resolution (amend §9.9)

```diff
 commands
 ────────────────────────────
 command_id                PK
 project_id
-payload_hash
+semantic_request_fingerprint
+schema_version
+fingerprint_algorithm_version
-resolution                Pending | Committed | TerminalRejected
+resolution                Committed | TerminalRejected
 result_json?              // Committed
 terminal_error_json?      // TerminalRejected
 created_at
 settled_at?
```

```text
语义（P1 closure）：
- commands 只持久化 authoritative resolution：Committed | TerminalRejected。
- 一个 semantic command 使用单一事务完成：
    canonical reads + authority/preconditions + fence validation +
    domain transition + canonical writes +
    authoritative receipt (Committed/TerminalRejected) +
    Domain Events (Committed only)
  原子提交。
- 不引入 durable Pending 预登记，不引入双事务模型。
- 未 commit 的 operational failure：ROLLBACK → 不产生 authoritative
  resolution → 不写 commands row；同一 CommandId 可重试（语义请求不变）。
- 一旦存在 Committed/TerminalRejected row，same CommandId 重试：
    same fingerprint → 返回既有 Receipt；
    different fingerprint → IdempotencyConflict。
- CommandAttempt 仅是非权威 operational trace：
    (command_id, attempt_no)，不要求 FK 到 commands；
    outcome ∈ { Committed | TerminalRejected | RetryableOperationalFailure }；
    attempt_no 从 0 开始。
```

### 2.3 P1-DG-03 — idempotency identity (amend §4.1 / §9.9)

```diff
-commands.payload_hash
+commands.semantic_request_fingerprint   // 与 §4.1 同一值
+commands.schema_version
+commands.fingerprint_algorithm_version
```

```text
§4.1：
- semanticRequestFingerprint 覆盖 commandType、projectId、declared actor、
  schemaVersion 与 semantic payload。
- 具体 canonical serialization 与 hash 算法在 P1 phase contract 冻结
  （并随 fingerprint_algorithm_version 持久化）。
- P0 的 32-bit FNV-1a 为 interim，不是冻结算法。
- IdempotencyConflict 当且仅当 same CommandId 且 fingerprint 不同。
```

### 2.4 P1-DG-04 — fence vs stop admission (amend §11 / §9.7 / §3.4)

```diff
 P1 — Persistence + Command Core
 ...
-atomic State + Receipt + Event + authoritative fencing
+atomic State + Receipt + Event + authoritative fence *validation hook*
+(lease acquisition/lifecycle remains P2)
```

```text
§9.7 / §6A.15：
- Authoritative fence validation 与 stop/quiescence mutation admission 是
  两个独立的检查。
- FencingRejected 只表示 ownership/fence 无效（generation 不匹配 /
  非当前 owner）。一个仍然合法（generation 有效）的 Worker，仅因
  stop_requested_at 被拒绝时，**不得**返回 FencingRejected。
- stop/quiescence admission 是 domain admission precondition，返回
  DomainError.ExecutionStopRequested（见 §6A.15）。
- P1 冻结 persistence hook 与 transaction integration（fence validation +
  canonical read/write + receipt + event 同一事务）。
- P2 负责 lease acquisition/renewal/loss lifecycle。
- 精确 SQL predicate 在 P1 phase contract 冻结。
```

### 2.5 P1-DG-05 — CreateProject bootstrap (amend §12.11 / §4.1)

```text
CreateProject bootstrap contract:
- projectId 由 caller 预分配（prj_ + UUIDv7）；CommandEnvelope.projectId 即该值。
- payload 提供 Root Workspace 的 ResponsibilityDefinition /
  ResourceBoundary / ResponsibilityBoundAgentBinding / WorkspacePolicy /
  ProjectPolicy / default configuration / environmentRef。
- rootWorkspaceId 与 primarySessionId 由 caller 预分配。
- 单一事务原子创建 Project + Root Workspace + WorkspacePrimary Session
  （§9.13 deferred FK 在同一 COMMIT 校验）。
- emitted events: ProjectCreated → WorkspaceCreated（同一事务）。
- Primary Session 创建 **不产生** Domain Event（§5.3 catalog 无 Session
  event；Session 仅通过 workspace.primarySessionId 被引用）。
  实现阶段不得自行新增 Session event。
- authority: bootstrap principal；无 authority → DomainError.AuthorityDenied。
```

### 2.6 P1-DG-10 — port ownership (amend Appendix B)

```diff
-Application (Effect services)
-├── CommandGateway(CommandEnvelope, CommandSubmissionContext)
-├── TransactionPort
-├── CommandStore / Receipt
-└── DomainEventJournal
+Application (Effect services)
+├── CommandGateway(CommandEnvelope, CommandSubmissionContext)
+Persistence ports (§7.2)
+├── TransactionPort
+├── CommandStore / Receipt
+└── DomainEventJournal
```

## 3. Phase-scoped closures (no DID edit)

| Gap | Closed by |
|---|---|
| P1-DG-06 | `05-event-journal.md`: sequence mechanism + `eventVersion` policy + offset/projection tx boundary |
| P1-DG-07 | `04-sqlite-schema.md`: deferred-FK declarations, table↔domain mapping, root uniqueness |
| P1-DG-08 | `04-sqlite-schema.md`: claim release/supersede, CAS columns, conflict-load index |
| P1-DG-09 | `04-sqlite-schema.md` + `06-recovery-matrix.md`: retention/delete + migration |

## 4. P0 artifact impacts (P0→P1 contract evolution, not a P0 reopen)

| P0 artifact | Change |
|---|---|
| `command.ts CommandResolution<R>` | becomes `CommandResolution<Result, Rejection>`; Domain instantiates `DomainError`, Application `CommandRejection` |
| `command.ts CommandReceipt<R>` | Application-side rejection widens to `CommandRejection`; view fields frozen in P1 contract |
| `errors.ts DomainError` | add `ExecutionStopRequested` (new admission rejection); `FencingRejected` stays **out** of DomainError |
| `command.ts CommandAttempt` | becomes non-authoritative trace; add outcome/attempt_no semantics at P1 |
| `semanticRequestFingerprint` | P0 FNV-1a marked interim; P1 freezes durable algorithm + version |

## 5. Post-apply audit (proposed)

```bash
grep -n "ExecutionStopRequested" docs/design/03-detailed-implementation-design.md
grep -n "CommandRejection" docs/design/03-detailed-implementation-design.md
grep -n "semantic_request_fingerprint" docs/design/03-detailed-implementation-design.md
grep -n "payload_hash" docs/design/03-detailed-implementation-design.md   # 0 live uses
grep -n "Pending" docs/design/03-detailed-implementation-design.md        # 0 in commands.resolution
```

## 6. Apply gate

**Not applied.** On approval: apply to DID (v1.5); mark P1-DG-01/02/03/04/05/10
`RESOLVED`; leave P1-DG-06/07/08/09 `OPEN (phase-scoped)`; then write
`docs/design/implementation/P1/**`.

One item needs your explicit confirmation before apply:
**`ExecutionStopRequested`** is a new `DomainError` tag proposed for the
stop/quiescence admission rejection (DG-04). Confirm the name or supply the
intended tag.
