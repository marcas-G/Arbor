# P14 — 01 SubmitHumanMessage（命令/事件/持久化）

**Owns:** human-facing 输入命令的完整冻结语义
**Does not own:** 执行触发（`02`）、read model（`03`）、UI（`04`）

## 1. 命令语义（frozen）

```text
Authenticated Human → Root Workspace
```

```ts
interface SubmitHumanMessagePayload {
  readonly messageId: MessageId;          // caller-preallocated（msg_ 前缀 uuid-v7）
  readonly targetWorkspaceId: WorkspaceId; // 必须等于 Project.rootWorkspaceId
  readonly bodyRef: ContentRef;            // 正文进 Blob（DID §8.14 bounded view 原则）
}
```

- **sender 由谁决定**：human principal 来自 authenticated External
  submission context（P12 `10` §3 transport 边界证明）；**payload 不自报
  sender**——resolver 从 principal 产 fact。
- **authority**：新增 `SubmitHumanMessageAuthority`（exact-bound:
  principal + commandId + fingerprint + projectId + targetWorkspaceId）；
  resolver 规则 = authenticated human（`user:` 前缀 / governance facts）且
  `targetWorkspaceId === rootWorkspaceId`——root-only exact binding 在
  authority 层强制，非 UI 层。
- **stopAdmission**：`Unclassified`（不修改 Work、无 steer 语义）。

## 2. 前置与拒绝

| Condition | Rejection |
|---|---|
| target ≠ project root workspace | `DomainError.AuthorityDenied`（root-only） |
| bodyRef 超 bounded 上限（P6 `02` §2 quota） | `CommandRejection.InvalidRequest` |
| messageId 冲突且 fingerprint 不同 | `DomainError.IdempotencyConflict` |
| 同 commandId 重复提交 | 幂等返回原 receipt（P1 §8 规则） |

**不变**：不修改 Work lifecycle；不产生 WorkSteered/HumanInterventionApplied
（那是 SteerWork 专属，`05` seam-3 机械锁定）。

## 3. 事件：`HumanMessageSubmitted`（frozen）

```ts
interface HumanMessageSubmitted {
  readonly messageId: MessageId;
  readonly projectId: ProjectId;
  readonly rootWorkspaceId: WorkspaceId;   // 事件内是 workspace 语境的收件人
  readonly humanPrincipal: Principal;      // 事件内显式 human sender（非 senderWorkspaceId）
  readonly bodyRef: ContentRef;
  readonly occurredAt: string;
  readonly causedByCommandId: CommandId;
}
```

- **独立事件，不复用 `MessageSent`**（其 payload 语义是 workspace sender；
  硬套 human 会伪造 senderWorkspaceId——`05` seam-3）。
- projection 消费：transcript read model（`03`）+ Root Inbox admission
  （kind=`HumanConversation`，与 `HumanInput`（steer 专属）区分）。

## 4. Persistence / DDL（frozen）

```sql
CREATE TABLE human_messages (
  message_id      TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  root_workspace_id TEXT NOT NULL,
  human_principal TEXT NOT NULL,
  body_ref        TEXT NOT NULL,
  command_id      TEXT NOT NULL,
  fingerprint     TEXT NOT NULL,           -- 语义幂等（P1 §8）
  state           TEXT NOT NULL CHECK (state IN ('Pending','Claimed','Answered')),
  claimed_by_execution_id TEXT,            -- 02 的 claim 语义
  created_at      TEXT NOT NULL,
  settled_at      TEXT,
  UNIQUE (command_id, fingerprint)
);
CREATE INDEX idx_human_messages_pending ON human_messages(project_id, state, created_at);
```

- 迁移 `0014_human_messages.sql`（P14 拥有；PRAGMA user_version → 14；命名沿既有单下划线风格）。
- `attempt_no`：retry-until-response 的 attempt 计数（`02` §4.2）；每次
  Failed/OutcomeUnknown 回滚时 +1，admission id 由 `(messageId, attempt_no)`
  派生。
- durable 在命令事务内（与 event append 同事务）。

## 5. Inbox admission

- `HumanMessageSubmitted` → Root Inbox `admitUpsert`：
  `entryKey = humanmsg:{messageId}`，kind=`HumanConversation`，
  summary 取 bounded 首行。upsert-by-entryKey（D3 泛化规则）。
- 消费（promotion/consumption）属既有 Inbox 语义，不新增抢占（不变量 21
  延续——chat 无 interrupt）。

## 6. Must Not Decide

- 不决定 conversation trigger 时机（`02`）；
- 不决定 transcript 呈现（`03`）；
- 不扩展 SendMessage / 不改 P6 四种 message kinds；
- 不引入 human→child 通路（GQ-D）。

## 7. Verification

单测：payload/authority/root-only 拒绝矩阵；幂等矩阵（同 commandId 重放
同 receipt；fingerprint 冲突拒绝；**同 messageId 同 fingerprint 异
commandId → 由 P1 命令层语义幂等收敛为同一逻辑消息**——测试锁定不产生
双 Human turn）；事件形状（含 humanPrincipal、无 senderWorkspaceId）；
DDL 迁移 + 约束；inbox admission 形状。

## 8. Tracked revision（TR-A，DID v1.16 G-A）

本合同对 P6 domain 冻结产物的 recorded supersession：`InboxEntry` /
`InboxArrival` kind 封闭集扩展 `HumanConversation`（见 §5）；api-contracts
`InboxEntryKind` 随扩。P6 其余语义（四种 message kinds、SendMessage
规则、HumanInput=steer 专属）不 reopen。
