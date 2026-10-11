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

### P39 active-legacy preflight and report recovery (DID v1.40)

This is a design contract, not migration implementation or durability evidence.
P39 is `0039_ah7_reconciliation_attempts` after P36→P37→P38 owner contracts;
those contracts are integrated in the current governance baseline, but the
0036–0038 migration wiring is not. P39 must not ship or run by itself.

| Boundary | Crash/failure | Required recovery / invariant |
|---|---|---|
| Before primary open | Missing/invalid `--migration-block-report-db`, unknown sidecar schema, alias/path, unsupported filesystem | Typed failure; primary DB has not been opened; no service runtime |
| Sidecar setup | Before initialization COMMIT | No partial accepted sidecar schema; retry exclusive initialization |
| Sidecar setup | After COMMIT, before caller response | Reopen read-only, verify exact app id/version/object schema/digest, then continue |
| P36–P38 preflight | Before `BEGIN IMMEDIATE` | Re-run only with all primary writers still quiesced |
| P36–P38 preflight | Read snapshot, no active unbound `NotAdmitted` | Roll back/close preflight; apply pending ordered 0037→0038→0039 while maintenance mode keeps writers stopped |
| P36–P38 preflight | Active P36 `NotAdmitted` found | Under primary reservation, write/read back exact sidecar report with primary→sidecar lock order; roll back/close primary; exit `P39_LEGACY_DB_ISOLATED` / 78; no DDL, committed primary row or `user_version` changes, no service start |
| Sidecar report insert | Before sidecar COMMIT | Retry same stable key/content only after resolving transaction outcome; primary snapshot still held |
| Sidecar report insert | COMMIT response lost | Reopen/query stable key+content hash; exact row means success then primary rollback/isolation; no row permits bounded identical retry; conflict/corruption/unresolved state fails closed |
| Sidecar report insert | Same key, different hash/bytes | Preserve existing immutable record; typed `P39_REPORT_KEY_CONFLICT`; rollback primary and never run P39 DDL |
| Primary snapshot | Crash before rollback/exit | SQLite rolls back uncommitted snapshot transaction; restart re-evaluates same committed state and idempotently finds/reports same blocker |
| Ordered P39 migration | Failure before COMMIT at any rebuild/backfill/FK stage | Roll back schema, data and `user_version`; approvals/P3 state remain as before; retry only under migration contract |
| Ordered P39 migration | COMMIT result uncertain | Reopen primary and inspect version/schema transactionally; never infer P39 success from process response absence |
| Windows sidecar durability | Kill/I/O fault/VM power-off/reopen | Release remains blocked until actual Node VFS/local-volume matrix plus integrity check passes; WAL `FULL` alone is not qualification |

The active legacy refusal does not settle the old invocation or close human
recovery. It preserves the database/report for future governance. No old
approval is refunded/transferred; no binding is fabricated; no data is deleted.
Readiness is reported by DB cohort. The operator retains the sidecar DB and its
WAL/SHM together and owns backup/retention. Network/unknown filesystem refusal
and Windows durability remain explicit deployment gates.

### P40 cumulative migration and P39-only startup gate (DID v1.41)

P40 `0040_tool_observation_evidence` runs only after P36→P37→P38→P39 has
committed and `user_version=39`. P39 alone is maintenance-only: do not start
Agent/P4 Runtime or release that schema; finish P40 first and start only a
binary that understands the P40 v1 RNO envelope branch. Two OS-process
migration runners must serialize at the cumulative startup boundary; this
property is required but not qualified by the owner design.

| Boundary | Crash/failure | Required recovery / invariant |
|---|---|---|
| Before P40 transaction | process exits | `user_version=39`, no P40 objects/data; maintenance-only, retry cumulative P40. |
| During P40 transaction before COMMIT | process/database failure | All P40 DDL and version bump roll back; prefix stays at 39 and Runtime remains unavailable. |
| COMMIT response uncertain | caller loses response | Reopen and inspect exact P40 schema/version transactionally; version 40 means committed, version 39 permits identical serialized retry; ambiguous/corrupt state refuses service. |
| After P40 COMMIT before service start | process exits | `user_version=40`; supported six-tag decoder starts only after prefix/schema check. |
| Two daemons observe version 39 | concurrent startup | One cumulative runner proceeds; the other waits/re-reads version 40. Current runner serialization remains a qualification gate. |
| P39 RNO terminal before/after P4 transaction kill | partial candidate/commit boundary | Before commit: neither selected-fact terminal update nor P40 Observation survives; after commit: both survive as one immutable winner; P39 fact/selection is never duplicated or rewritten. |

The accepted P39 sidecar preflight/report runs at its existing predecessor
boundary and is not rerun, altered, or reused by P40. P40 performs no
historical-observation backfill. These are owner recovery contracts, not
process-crash, migration or Windows durability evidence.

## 6. Explicitly not covered in P1

- Worker crash / lease expiry / old-worker resurrection (P2, DID §3.4/§9.7).
- Provider disconnect, tool `OutcomeUnknown` reconciliation (P3/P4).
- Projection rebuild at scale (P9/P10).

AgentLoopStep action/settlement takeover reuses this matrix per generated
CommandId. Cross-generation logical eligibility and receipt-first convergence
are owned by `07`; AgentLoopStep state recovery is P9 `07`.
