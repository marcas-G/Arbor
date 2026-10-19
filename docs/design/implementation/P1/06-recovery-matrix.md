# P1 — 06 Recovery Matrix

**Authority:** DID v1.6 §7.4, §12.5, §12.6, §9.1, §9.9, §6A.5, §5.4
**Status:** P1 phase-scoped closure (revised after 4-way review)
**Closes:** the P1 crash-point matrix.

P1 uses **one transaction per semantic command** (no durable `Pending`), with
`BEGIN IMMEDIATE` for write scopes and `PRAGMA synchronous = FULL`
(`04-sqlite-schema.md` §1).

## 1. Command transaction crash points

| # | Crash point | Durable observation | Recovery action | Guarantee |
|---|---|---|---|---|
| C1 | before transaction starts | nothing | caller retries same CommandId | no resolution |
| C2 | after BEGIN, before any write | nothing (rolled back) | retry | no resolution |
| C3 | after canonical writes, before event append | nothing (same tx, rolled back) | retry | atomicity |
| C4 | after event append, before COMMIT | nothing (same tx, rolled back) | retry | atomicity |
| C5 | during COMMIT | WAL: committed **or** not | re-read `commands` row by CommandId | all-or-nothing |
| C6 | after COMMIT, before response | `commands` row (+ state/events if Committed; receipt only if TerminalRejected) | same CommandId retry returns existing Receipt | idempotent replay |
| C7 | concurrent duplicate command | winner commits; loser sees PK conflict or `SQLITE_BUSY` | loser: ROLLBACK → re-read receipt → match/differ per 03 §3.4 | single authoritative resolution |
| C8 | process crash mid-transaction | nothing (WAL rollback on restart) | retry | no partial state |
| C9 | `SQLITE_BUSY` / `BUSY_SNAPSHOT` / rollback | nothing | `TransactionOperationalFailure` → bounded retry / new `CommandAttempt` | non-authoritative |
| C10 | OS/power loss after COMMIT | committed durable (`synchronous = FULL`) | none | durability |
| C11 | crash during WAL checkpoint | prior committed txs durable (FULL) | restart recovery | durability |

Notes:

- "After command registration" is **not** a durable point: the `commands` row
  is written only with its authoritative resolution (DID §9.9).
- C3/C4 cannot produce durable partial state (writes and events share one tx).
- C7: no blind retry after an authoritative conflict (03 §3.4).
- C10/C11 depend on `synchronous = FULL`; deployments may relax it only by
  declaring a weaker `DurabilityEnvelope` (DID §9.1).
- C5 (crash during COMMIT), C10 (OS/power loss), C11 (WAL checkpoint) are not
  reproducible in-process. P1 asserts them via adapter fault injection
  (commit-failure injection + a `synchronous = FULL` durability check) or
  records them as "durability-asserted, not crash-injected" with the exact
  mechanism. They are P1 claims, not deferred to P2.

## 2. Operational failure handling

```text
TransactionOperationalFailure (PersistenceUnavailable, SQLITE_BUSY, BUSY_SNAPSHOT, …):
  - no commands row written/unchanged
  - record command_attempts(outcome = RetryableOperationalFailure) in a
    SEPARATE short transaction after ROLLBACK (may be lost on crash)
  - bounded retry (attempt_no++); same CommandId, unchanged fingerprint
  - changing the semantic request requires a NEW CommandId (DID §4.1)
```

Attempt recording (frozen):

```text
resolving attempt (Committed / TerminalRejected): recorded in the command tx
retryable failure: recorded after ROLLBACK in its own scope
attempt_no allocation: CommandStore assigns the next free
  (command_id, attempt_no) for the same CommandId; concurrent retries
  serialize via BEGIN IMMEDIATE on command_attempts
```

## 3. Consumer / projection crash points

| # | Crash point | Durable observation | Recovery action |
|---|---|---|---|
| P1 | after projection writes, before COMMIT | nothing (offset+projection same tx) | re-deliver batch, re-apply |
| P2 | after COMMIT, before next batch | offset advanced | continue from offset |
| P3 | transient projection error | offset not advanced | retry / catch-up (DID §5.4) |
| P4 | deterministic unprocessable event (poison: unsupported version / bad payload) | dead-letter row + offset advanced past that sequence, same tx | alert; operator reviews; consumer continues (no stall) |

Projection failure never rolls back the domain transaction (DID §5.4).
Consumers must be idempotent (re-apply key `(project_id, sequence)`).

## 4. Resource-ownership transaction

| Crash point | Recovery |
|---|---|
| after resolve, before `BEGIN IMMEDIATE` | re-resolve |
| inside `BEGIN IMMEDIATE`, before COMMIT | rollback; re-resolve; `ResourceResolutionStale` if `environment_revisions.revision` changed |
| after COMMIT | claims durable |

Resolve/canonicalize happens outside the write transaction (DID §9.5).

## 5. Migration

| Crash point | Recovery |
|---|---|
| during additive migration tx | rollback; `PRAGMA user_version` unchanged; re-run |
| during table-rebuild (`foreign_keys=OFF`) | re-run; startup refuses on version mismatch |
| after migration COMMIT | `user_version` advanced |

## 6. Explicitly not covered in P1

- Worker crash / lease expiry / old-worker resurrection (P2, DID §3.4/§9.7).
- Provider disconnect, tool `OutcomeUnknown` reconciliation (P3/P4).
- Projection rebuild at scale (P9/P10).

## Native OS Sandbox accepted recovery rows

| Boundary | Before commit | After commit / restart |
|---|---|---|
| Exact Grant issuance | Crash rolls back Grant/provenance/receipt/event together; no orphan provenance may be visible. | One Committed GrantPermission, immutable issuer provenance and `SandboxPolicyGrantIssued`; retry/restart does not duplicate. Deferred command FK must be satisfied at commit. |
| TerminalRejected GrantPermission | No Grant, provenance or audit event is written. | Exact rejection receipt only; replay remains idempotent. |
| Policy decision | Crash rolls back decision, `SandboxPolicyDecisionRecorded` and receipt together. | Restart rereads the exact durable Execution/Episode/policy revision and Grant provenance; it never reconstructs from event/model/current defaults. |
| Config removal/change/re-add | No stale snapshot is accepted after quiesced restart. | Exact operator-config revision/digest mismatch, missing/corrupt provenance, changed Grant or expired decision yields fail-closed Attention; re-adding an operator cannot revive old Grants and requires a new Grant/decision. |

AgentLoopStep action/settlement takeover reuses this matrix per generated
CommandId. Cross-generation logical eligibility and receipt-first convergence
are owned by `07`; AgentLoopStep state recovery is P9 `07`.

## V21 policy decision and binding-recovery cases

| Boundary | Before commit / failure | After commit / restart |
|---|---|---|
| DecideSandboxPolicy preparation before final transaction | Transient read-only P11/P5 preparation failure triggers one final receipt lookup; if still absent, retryable preparation-unavailable with no command/receipt/rejection row. | An already committed same-fingerprint receipt is returned without recapturing source state. |
| Final transaction before decision commit | Crash rolls back decision, command result/receipt and `SandboxPolicyDecisionRecorded` together; no partial decision is authoritative. | Receipt lookup returns the exact committed closed result; P9 verifies `decision_command_id`, variant and policy digest against existing `commands.result_json`. |
| Policy result exceeds 65,536 UTF-8 bytes | Commit only durable `TerminalRejected(SandboxPolicySummaryTooLarge)` receipt; no decision/event and no truncation. | Same CommandId replays the same rejection. |
| Missing/corrupt/mismatched RecoveryBindingV1 proof | No P9/P40 fact/event/marker, lease, P4/Provider call, effect, observation or settlement; invocation remains NotAdmitted/Pending and Step ActionsInProgress. | P10 derives safe Attention by query from existing P4 rows; Stop or invocation terminality clears it. No automatic/manual repair or rebind. |
| Malformed non-NULL binding SHA format or missing/invalid immutable `intent_at` | P10 projection fails closed as Persistence/ProjectionIntegrityFailure, emits no derived row and does not fabricate an identity/timestamp. | Existing corruption Problem/operational handling applies; no persistent Attention marker is created. |
