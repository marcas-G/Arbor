# P9 — 05 Consumer Offset & Projection Rebuild Hardening

**Authority:** P1 `05` §3–§6 (offset / dead-letter / rebuild), `06` (C-matrix
format precedent); P7 `04` §4 (coordinator failure semantics); P8 `03` §1–§3
(consumers A/B); GQ2 / GQ5 governance rulings; DID v1.9 §5.4.
**Status:** DRAFT (first draft for contract review).
**Naming:** Phase P9 ≠ DID §8.4 "P9 Verification Program" (scope-extraction B-10).

## 1. Consumer offset wiring (frozen)

- The P7 coordinator and P8 consumers A/B wire onto the P1 consumer
  infrastructure: `runConsumerBatch` + `ConsumerOffsetStore` +
  `ConsumerDeadLetterStore` — apply-then-advance in one transaction
  (P1 `05` §4). The current direct event-array invocation is retired.
- Poll-driven form (loop interval, batch size, dispatcher placement) is a
  task-level implementation choice, not contract.

Dual-guarantee semantics:

```text
primary    consumer_offsets.last_sequence, keyed (consumer_id, project_id),
           never deleted (P1 `05` §4)
fallback   deterministic CommandId idempotency (CommandReceipt, P1 `01` §8;
           P7 `04` §2; P8 `03` §1–§2)

injection assertion (offset loss / regression):
  delete or regress the offset row → the consumer re-delivers from the
  effective retained floor → every re-submitted Event→Command is absorbed
  by the deterministic CommandId (existing Receipt / typed terminal
  rejection recorded, no re-burn); canonical state converges; zero
  duplicate domain effects
```

## 2. Consumer crash injection matrix

| # | injection | expected (frozen) | source |
|---|---|---|---|
| CC-1 | mid-batch abort after projection apply, before offset advance | apply + advance are ONE transaction → both roll back → re-run re-delivers and re-applies idempotently (`(project_id, sequence)` key); the offset NEVER advances without the apply | P1 `05` §4 |
| CC-2 | offset row deleted / regressed below the true position | `read` returns 0 (absent) or stale → full/stale replay absorbed by id idempotency (§1); dead-letter re-quarantine is a no-op (PK dedup, `INSERT OR IGNORE`) | P1 `05` §3–§4 |
| CC-3 | poison path 1 — `eventVersion` > reader ceiling | quarantine + offset advance past the sequence in the SAME transaction; consumer never stalls (no head-of-line block); dead-letter row persists | P1 `05` §3 |
| CC-4 | poison path 2 — deterministic handler/projection defect (thrown error) | same poison semantics: dead-letter + skip + advance + alert. Classification rule (frozen): typed `DomainError` rejections are NOT poison (recorded outcomes, P7 `04` §2); deterministic defects (decode/schema/unexpected throw) ARE poison. Transient operational failures (busy/IO) abort the batch and retry — never dead-letter | P1 `05` §3 |
| CC-5 | projection failure mid-batch | never rolls back the domain command transaction (DID §5.4); consumer-level disposition per CC-3/CC-4 | P1 `05` §4 |
| CC-6 | concurrent double-dispatch of one consumer | single-flight per `(consumer_id, project_id)`; `BEGIN IMMEDIATE` serializes; idempotent re-apply makes the overlap harmless | P1 `05` §4 |

## 3. GQ2 split: generic rebuild (P9) vs business projections (P10)

GQ2 refines the coarse "projection rebuild (P10)" deferral note in P2 `06` §1:
**P9 hardens the generic recovery/rebuild mechanism; P10 owns concrete
business-projection rebuild at scale.**

### 3.1 P9 surface — generic projection recovery/rebuild

Assertions over `rebuildProjection` (persistence-sqlite `consumer.ts`) and
the generic batch path:

```text
RB-1  floor refusal   offset < pruned floor (MIN(domain_events.sequence))
                       → typed refusal ConsumerRebuildRefused{offset, floor};
                       no partial reset, no state destruction
RB-2  reset atomicity  projection reset + offset rewind to floor in ONE
                       transaction; abort mid-rebuild leaves either the
                       pre-reset or post-reset state, never a hybrid
RB-3  replay idempotency  re-running rebuild to completion is a no-op delta:
                       (project_id, sequence) INSERT OR IGNORE → at-most-once
                       projection rows; re-quarantine is a PK no-op
RB-4  rebuildability  with intact domain_events up to the retention horizon,
                       rebuild always reaches the same projection state
                       (P1 `05` §6 — append-only before the horizon)
RB-5  degenerate      zero-events project: floor 0, replay 0, success
```

### 3.2 P10 surface (explicitly not P9)

- Concrete business projections (InboxProjectionStore, Attention views,
  wait-graph derived views) at-scale rebuild: incremental checkpoints,
  per-projection retention policy, rebuild orchestration, query correctness.
- P9 implements and injects only the generic mechanism; no business
  projection rebuild is built or asserted here.

## 4. Durability-asserted segment (GQ5)

```text
crash-injected (this contract)   process / fiber / transaction level:
                                 aborted transactions inside the consumer
                                 path, killed consumer loops, fiber
                                 interrupts — reproducible in-envelope
durability-asserted (evidence)   WAL / power-loss / checkpoint class is NOT
                                 crash-injected; it is proven by reopen +
                                 integrity evidence: reopen the DB after
                                 harness teardown, run the integrity check,
                                 verify the last committed batch and offset
                                 (P1 C10/C11 discipline continued; no
                                 fault-injecting SQLite adapter)
```

## 5. Must Not Decide

- No business projection rebuild / at-scale orchestration (P10, GQ2).
- No retention / pruning semantics change (P1 `04` owns the horizon).
- No offset / dead-letter schema change (P1 `05` owns the tables).
- No new delivery semantics beyond P1 `05` (at-least-once + idempotent
  apply; DID §5.4).
- No external projection stores (P1 `05` §7).
- No fault-injecting SQLite adapter (GQ5 option (b) declined).
