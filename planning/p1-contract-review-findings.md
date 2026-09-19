# P1 Contract Review Findings (draft — contracts not modified)

Status: **BLOCKED** — 4-way independent review of
`docs/design/implementation/P1/**` against DID v1.5. Contracts were **not**
modified. P1-DG-06..09 remain `OPEN`.

Reviewers: Command/Port, Transaction/DDL, Event/Recovery, Cross-document
Consistency.

## A. Blocking

| ID | Finding | Docs | Fix owner |
|---|---|---|---|
| B1 | **`AssignWork` rejection set not implementable.** `WorkspaceNotFound`/`ProjectClosed`/`ResponsibilityViolation` are not in the frozen `DomainError` (§6A.15); `RevisionConflict` was dropped; retired-workspace maps to `RetirePreconditionFailed` (inconsistent with `TerminalLifecycleMutation`). §0A.1 is illustrative, not normative. | 01 §5, 00 | contract + possibly DID |
| B2 | **`CommandRejection` / parameterized `CommandResolution<Result,Rejection>` never defined.** 01/03/04 reference `CommandRejection.FencingRejected`/`ExecutionStopping`; no doc defines the union; P0 `CommandResolution` hardcodes `DomainError`. | 01,03,04 | contract (+P0 evolution) |
| B3 | **Fingerprint algorithm not frozen.** DID §4.1 delegates canonical serialization + hash to a P1 contract; no P1 doc freezes it; P0 FNV-1a is interim. Idempotency compare must include `(fingerprint, schema_version, fingerprint_algorithm_version)`. | 01,02,04 | contract |
| B4 | **`CommandStore.insert*` omit `fingerprint_algorithm_version`** while DDL declares it `NOT NULL`. | 02 vs 04 | contract |
| B5 | **Fence predicate cannot split `FencingRejected` vs `ExecutionStopping`.** Single `SELECT 1` returns 0 rows for both invalid generation and `stop_requested_at` set. Need two predicates (or a `fence_valid` + `stopping` result). | 03,04 | contract |
| B6 | **`CreateProject` payload missing Project `revision`** (DDL `revision NOT NULL`; P0 `createProject` requires it). | 01 | contract |
| B7 | **Bootstrap `WorkspacePrimary` Session `contextEpoch` unspecified** (DDL `context_epoch NOT NULL`). | 01,04 | contract |
| B8 | **`command_attempts` write contradicts transaction model.** `recordAttempt` requires `TransactionScope` but must be written after ROLLBACK (outside the failed scope). | 02,03,06 | contract |
| B9 | **Sequence allocation unsafe / no durable counter.** 03 (`BEGIN IMMEDIATE` only for ownership) contradicts 05 (`BEGIN IMMEDIATE` for write scopes); allocation derived from `MAX(sequence)` breaks after retention pruning. | 03,05 | contract |
| B10 | **`ProjectEnvironmentPort.resolve` split contradicts DID §1.5** (must return regions + `observedEnvironmentRevision` together); resource-region physical encoding still OPEN (DID §13 P1 blocker not closed). | 02,04 | contract |
| B11 | **`commands` retention window contradicts stable idempotency** (must be never-hard-deleted / infinite window). | 04 | contract |
| B12 | **03 §3.1 idempotency branch omits fingerprint comparison** (different fingerprint must → `IdempotencyConflict`). | 03 | contract |
| B13 | **Concurrent duplicate-attempt commit-conflict protocol missing** (DID §7.4 requires one authoritative resolution; losers re-read receipt). | 03,06 | contract |
| B14 | **Repository `E` channel wrong:** catch-all `RepositoryError`, self-requirement in `R`, and 02↔03 disagreement. Violates §6A.2 / §0A.6. | 02,03 | contract |
| B15 | **`consumer_offsets` has no port** — offset advance (P1-DG-06 closure) has no implementing contract. | 02 | contract |
| B16 | **`00-contract-index.md` closure/status mapping inaccurate/self-contradictory** (claims 01 closes P1-DG-02/05 which are already RESOLVED; says 06..09 OPEN while tables say closed; A1–A8 labels unverifiable). | 00 | contract |

## B. Important

| ID | Finding | Docs |
|---|---|---|
| I1 | `command_attempts` recording on success/terminal paths unspecified (`outcome` allows all three; only retryable path writes one). | 03,04 |
| I2 | Ownership retire-read index missing (`resource_ownership(workspace_id) WHERE released_at IS NULL`). | 04 |
| I3 | Environment-revision stale-check anchor undefined (no `environment_revision` table; what is compared to what?). | 04 |
| I4 | `eventVersion` tolerate-vs-reject contradiction; unsupported version can stall a consumer forever (poison handling undefined). | 05 |
| I5 | Offset/projection co-location + re-apply idempotency key unspecified (external-store projections break the frozen atomicity). | 05 |
| I6 | Durability/`synchronous` declaration + WAL-checkpoint crash point missing (DID §9.1 `DurabilityEnvelope`). | 05,06 |
| I7 | `CreateChildWorkspace` phase ownership (P1 vs P6) resolved in 01 without DID amendment. | 01, DID §11 |
| I8 | Workspace-tree-same-project not enforced at L3 (composite FK) though §6.2 claims L3. | 04 |
| I9 | `TransactionScope` as bare `{sessionId}` does not structurally prevent per-repo connections (should be an Effect `Context.Tag` carrying the live session). | 03 |
| I10 | `AssignWork` `RevisionConflict` dropped vs §0A.1; state the deviation explicitly. | 01 |
| I11 | `ResourceOwnershipRepository` / `ProjectEnvironmentPort` / `SessionRepository.appendEntry` are P1-listed but unused by P1 commands (scope creep vs §11 P1). | 02 |

## C. Minor

- Redundant `idx_domain_events_project_sequence` (UNIQUE already indexes).
- `commands.settled_at NOT NULL` deviates from DID `settled_at?` (justified by no-Pending; call it out).
- `attempt_no` 0-based not restated in DDL/port.
- Table↔domain mapping omits `agent_execution_state`, `workspace_lineage`, `session_epochs`, `session_entries`, `checkpoints`.
- `workspaces.current_work_id ↔ works` is a third FK cycle not declared in DID §9.13.
- `releaseClaim` should be `WHERE released_at IS NULL` + `CHECK (released_at >= created_at)`.
- "append-only claim rows" wording inaccurate (soft-release update).
- `EnvironmentError` owning package undefined.
- `findById` returning `T | null` vs ADT in `A`.
- `result_json`/`terminal_error_json` codec not actually frozen in 04 (01 cross-ref false).
- `CommandRejection` payloads (`FencingRejected`/`ExecutionStopping`) undefined.
- DID Appendix C still prints "Detailed Implementation Design v1.4" (version drift).
- `docs/design/implementation/P1/**` placement authorization should be confirmed by manual governance.

## D. DID-level items (need governance)

| ID | Item |
|---|---|
| D1 | §0A.1 (illustrative AssignWork signature) vs §6A.15 (closed `DomainError`) inconsistency; decide the canonical `AssignWork` rejection set and clarify §0A.1 is illustrative. |
| D2 | `CommandRejection` / parameterized `CommandResolution` (v1.5 §6A.15) not reflected in P0 code; P1 must evolve it. |
| D3 | Resource-region physical encoding (DID §13 P1 blocker) — confirm whether P1 must freeze it or it is waived. |
| D4 | `CreateChildWorkspace` P1-vs-P6 phase ownership. |
| D5 | DID Appendix C version drift (v1.4 → v1.5). |
| D6 | Confirm `docs/design/implementation/P1/**` as authorized phase-contract location. |

## E. Recommended remediation order

```text
1. DID v1.6 patch (D1, D4, D5, D6)  — small, governance
2. 03 transaction-model  (B5, B8, B9, B12, B13, B14, I9)
3. 01 command-contracts  (B1, B2, B6, B7, I10)
4. 02 port-contracts     (B3, B4, B8, B10, B14, B15, I2, I11)
5. 04 sqlite-schema      (B5, B9, B10, B11, I1, I2, I3, I8)
6. 05 event-journal      (B9, I4, I5)
7. 06 recovery-matrix    (B8, B13, I6)
8. 00 contract-index     (B16)
9. re-run 4-way review
```
