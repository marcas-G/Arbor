# F21 OPEN-3 — formal implementation closure

Date: 2026-10-16

Reviewed source: `4d6147a4` (`test: prefer single-worker core Vitest`)

Status: **F21 OPEN-3 FORMALLY CLOSED.** Blocking = 0; B1 = 0; B2 = 0.
This closes only the accepted OPEN-3 post-commit resource-activation recovery
contract. It is not a full release-readiness claim and does not re-evaluate or
close F21 OPEN-1 or OPEN-2.

## Basis and evidence

The implementation was checked against §4 of the accepted OPEN-3 package,
`planning/proposals/F21-postcommit-resource-activation-recovery-draft.md`,
LF-normalized SHA-256
`E6EEE5CE68B78328FE96D3D14387A34F9B05F31C6BE8E53D4FB2701EE7728ECE`, and the
landed P1/P10/P11/P12 owner contracts recorded in
`planning/results/F21-open3-governance-acceptance-and-landing.review.md`.
Production order and behavior remain within that package: P1 commits the
Pending intent with CreateProject; P11 resolves only the persisted Workspace
boundary and atomically commits claims, Active, and its event; P12 startup
reconciles current intent truth and retries Pending intents; P10 Attention is
path-free and source-reconciled independently of the generic consumer offset.

At this source, the exact focused evidence is:

```text
.test-results/f21-open3-close-4d6147a4-process-20261016-113752.log
  tests/functional/process/f21-open3-activation-recovery.functional.test.ts: 7/7
  tests/functional/process/f21-open3-p10-full-rebuild.functional.test.ts: 2/2
  total: 2 files / 9 tests passed

.test-results/f21-open3-close-4d6147a4-ui-20261016-114213.log
  tests/functional/ui/f21-project-resource.spec.ts: 2/2 passed
```

The process run proves real-daemon restart/recovery and P10 Story L ordering;
the browser run confirms the public Profile selection/file-evidence journey and
rejects forged references/free paths without creating Projects. UI evidence is
supporting evidence, not a substitute for the process matrix.

## Accepted §4 matrix disposition

| Required boundary | Evidence checked | Result |
|---|---|---|
| Before CreateProject commit | `tests/p1-create-project.test.ts` injects transaction failure and asserts no canonical Project/Workspace/Session, receipt, events, intent, claim, or Attention. | PASS |
| Gateway commit before P11 | Process test kills at the test-only post-Gateway/pre-P11 seam; verifies committed receipt and Pending intent, no claim, then restart auto-activates without client resend. | PASS |
| Resolver/claim failure across restart | Repeated failure and physical missing-path cases retain Pending and one public path-free Attention with no partial claim/Active event; the missing path is restored at the same address and later activates. | PASS |
| Activation succeeds exactly once | P11 before/after-commit kill cases and restart checks assert one claim set, Pending→Active, one Active event, unchanged P1 receipt/canonical entities, and Attention removal. | PASS |
| Duplicate/concurrent processing | Two independent SQLite-backed P11 service compositions race one intent and produce one winner/claim/CAS/event; real-daemon restart and exact receipt replay cover sequential re-entry. The proposal permits these alternatives; a simultaneous two-P12-daemon race is stronger than required. | PASS |
| Profile catalog changes while Pending | Repeated-failure process case changes the available Profile version during Pending; subsequent recovery keeps the original persisted Workspace boundary and does not reselect. | PASS |
| Path unavailable repeatedly | Missing persisted FileTree survives two real restarts with one path-free Attention and zero claims, then recovery of the same directory activates once without request replay. | PASS |
| ConversationOnly | CreateProject admission/codec tests assert empty boundary and no activation intent, event, or claim. | PASS |
| P10 rebuild after event pruning | Corrected `280130ba` Story L fixture uses a real temporary pinned tree and the production-equivalent full resolver. The two passing process cases prove pre-commit rollback and post-commit catch-up around the reset/snapshot/offset-rewind transaction, with the Pending event pruned. | PASS |
| P1 offset below retained floor | P12 source-only startup reconciliation reconstructs public Attention from the intent without generic rebuild or offset mutation; generic `ConsumerRebuildRefused` behavior remains unchanged. | PASS |
| Stale Pending event after Active | P10 reconciliation test redelivers a stale Pending wakeup and confirms current Active intent truth prevents row recreation. | PASS |
| Pending→Active versus reconciliation/rebuild | Story L lock handshake and both kill boundaries prove serialization and current-source catch-up; Active committed before replay leaves no stale Attention. | PASS |
| Pre-intent v2 receipt | Migration test preserves the historical receipt/events/Workspace and creates no inferred intent/Attention. v1 remains preserve-only; current exact-v2 replay is not redefined. | PASS |

## Specific final-review checks

- The `9a7ed686` active-resource-overlap branch is narrow: only the exact
  `ResourceOwnershipRepository` / `insert-active-claim` /
  `active-resource-overlap` constraint after a Gateway-Committed
  CreateProject returns the stored HTTP 200 Committed receipt. The intent
  remains Pending and Attention is reconciled. Its real-process test asserts
  replay stability and no duplicate Project/Workspace/Session/receipt/event
  or provider call. Other post-commit failures keep the convergence-failure
  response.
- `211e461e` corrected the two F21 tuple-mismatch test oracles to the frozen
  HTTP 200 `TerminalRejected(IdempotencyConflict)` receipt contract. It did
  not change production behavior or weaken ordering/security assertions:
  profile resolution counts, byte-equivalent legacy receipt, no pre-Gateway
  old-v1 decode, no path reflection, and zero canonical writes remain
  asserted.
- The `280130ba` P10 fixture update is test-only and retains the full resolver
  fail-closed requirement. Windows lock contention accepts only the known
  busy/locked result or exact extended code 1546; qualification still requires
  the same P11 child to acquire the writer lock after P10 is killed and commit
  activation. No production semantic relaxation was made.
- Public Attention uses a fixed path-free summary and no Profile/path/OS error
  data. Activation reads the pinned Workspace boundary, not the Profile
  catalog. No pre-commit receipt pre-read or change to F23 tuple/receipt
  ordering was introduced.

## Limits

These results close the accepted OPEN-3 implementation matrix only. The logs
above are focused qualification, not a fresh full `pnpm check` or full
`pnpm test:functional` claim. F21 OPEN-1 Profile-source audit and OPEN-2
historical CreateProject v1 same-ID replay remain separate, open work. Overall
release validation remains open and must proceed through its remaining gates.
