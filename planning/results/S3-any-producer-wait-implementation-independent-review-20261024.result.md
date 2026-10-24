# S3 AnyProducer Wait Implementation — Independent Code Review

**Disposition: PASS — Blocking = 0** for the reviewed implementation and
focused test scope.  
**Reviewed HEAD:** `749ddd65d031660698f10fc7a30770b4917b6af6`  
**Implementation commits:** `9421c019`, `922e9ab0`, `749ddd65`  
**Review type:** source/test review plus focused in-process verification. No
production daemon, process fixture, real Provider, Web build, or user/current
database was run or touched.

## APW-1 — receipt-first admission and bounded evidence

`apps/single-workspace/src/control-actions.ts` leaves the existing prior
Action/Command receipt path before the new evidence check. For a new
AnyProducer invocation it validates any exact current Command receipt against
the registered handler schema, exact project, fingerprint/algorithm and typed
result/canonical Dependency before returning the prior observation. Thus a
committed/rejected exact receipt does not re-evaluate producer evidence. The
new no-receipt path reads evidence before `CommandGateway.execute`; absence
returns the existing `AgentActionRejected(action/precondition,
ChooseAlternative)` and does not submit a canonical Command.

`apps/single-workspace/src/any-producer-evidence.ts` collects the bounded
producer evidence in one `TransactionPort` snapshot. It validates project
Workspace membership, counts only another same-Project Open Work, requires an
exact Approved proposal revision with the accepted materializing fulfillment
states/initial Work identity, or uses an already persisted same-Project
Deliverable through the unchanged P7 matcher. It reads no Work/proposal prose,
Message/Inbox, or Provider text. It performs no receipt lookup for the
pre-Declare Deliverable case, where no DependencyId yet exists. P7 command,
coordinator, matching, satisfaction and wake behavior remain unchanged.

AH10 coverage includes the new no-evidence/no-Gateway rejection and the added
case proving an exact committed receipt is replayed when producer evidence
has since disappeared (`evidenceChecks=0`). Existing FencingRejected
generation takeover, committed receipt convergence, absent canonical row
fail-closed, and non-fencing terminal rejection cases remain present.

## APW-3 — canonical read-side Attention

`apps/single-workspace/src/any-producer-attention.ts` owns the complete
APW-3 read query inside one `TransactionPort.transact` snapshot. It checks
Open Project; project-idle executions; active Workspace/consumer Work and
exact current-revision `DependencyChanged` wait; exact Unsatisfied
AnyProducer Dependency; other Open Work; exact approved materializing
formation and pending proposal; and P7-matcher Deliverables plus their exact
deterministic satisfaction receipt status. A Deliverable suppresses
Attention while its receipt is absent/retryable/nonterminal; `Committed` and
`TerminalRejected` are not convergence candidates. A cleared/stale Wait,
active execution, satisfied/terminal Dependency, or producer transition
cannot produce the row.

The projection maps only to the existing
`WaitingOnVacantProducer`/Attention source, consumer Workspace target and
`vacant-producer:<dependencyId>` dedup key, with fixed non-content-bearing
summary. It issues no wake, command, or canonical write. The P10 in-memory
SQLite fixture snapshots the canonical database before/after projection and
covers fresh/stale/cleared waits, active execution, pending formation, and
missing/retryable/Committed/TerminalRejected matching-Deliverable receipts.

No schema/API/source-label/DDL/migration/event/receipt/wake-reason change was
introduced. The new `AnyProducerSettledWaitFact` and `AttentionReadDeps`
extension are internal projection inputs only.

## Focused verification

- Focused P10/APW-1/AH10/P7/P10 suites: **6 files, 84 tests passed**.
- Normal `tests/p10-any-producer-attention.test.ts`: **1 file, 9 tests passed**.
- `@arbor/single-workspace` TypeScript build: **PASS**.
- `@arbor/projection-runtime` TypeScript build: **PASS**.
- Biome on 10 changed implementation/test files: **PASS**.
- `git diff --check`: **PASS**.

The scripted public-process regression source checks ModelUsable/no Dependency
and clarification, but it was not run in this review because it launches the
production fixture. No S3 real-provider or process qualification is claimed.
The earlier APW-3 RED is now a normal P10 in-memory SQLite test and passed; no
production daemon was started.

## Review boundary

The reviewed APW-1/APW-3 code matches the accepted S3 package and P7/P10
owner contracts within the tested scope. This record does not qualify S3's
multi-Workspace real-provider journey, authorize a real Provider run, or make
any release-readiness claim.
