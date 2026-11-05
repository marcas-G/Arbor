# AH7-DG-03 P36 Wave 1 — Independent Landing and Integration Review

Date: 2026-10-11
Reviewed HEAD: `9852ec014e11ab234fe5ba46923ce2ead0bc8234`
Integration base: `f80ee9132774c0c1fb570744d81398fad17da188`
Review mode: read-only; no tests run; no production or test files changed.

## Review outcome

**Technical/source-consistency Blocking = 0.** The accepted AH7-DG-03 owner
package and the P36 implementation inspected in this tree are consistent.
This is not AH7 closure and does not itself grant implementation
authorization for a subsequent wave.

The accepted proposal's LF-normalized SHA-256 is
`E818CC208F6A3B233FEF213E54E02AA30A1E96D6147313870C75FDE38DC94CBE`, matching
the acceptance record. The acceptance record's 12 current owner-file hashes
were checked against the worktree; all match. The P9 `00` index's additional
reference to P4 `03` is a cross-reference supplement within the accepted owner
scope, and its current hash matches the recorded value. No implementation
commit changed `docs/design/**` after the accepted landing except that index
reference update.

## P36 migration and production baseline

- P36 is the forward migration after P35 and sets the production SQLite
  baseline to `user_version = 36`. It rebuilds only `tool_invocations`, adds
  `effect_admission_state`, and copies every legacy invocation as
  `LegacyUnknown`; existing settlements, settlement JSON, and result refs are
  copied. No effect history is inferred from a prior row. The migration runs
  with foreign keys disabled and legacy rename behavior enabled inside the
  migration runner, restores both pragmas in its finalizer, and runs
  `foreign_key_check` before continuing.
- Production migration wiring and `CURRENT_MIGRATIONS` both use P36. Health
  readiness requires an exact version-36 match together with the existing
  database-open and T1-recovery conditions.
- The P12 B7 daemon-entrypoint fixture starts from P35 and exercises the
  production startup migration to P36. The P12 B8 composition fixture also
  runs P36 directly. The P36 migration test checks legacy unsettled and settled
  rows become `LegacyUnknown`, preserves the prior Success settlement, and
  rejects a no-effect Denied rewrite of a LegacyUnknown row.
- HTTP views continue to use the local `user:local` credential; commands keep
  their authenticated human principal and Gateway/Resolver governance. The
  change does not merge these read and command identities.

## Accepted atomic-claim semantics and test changes

The P4 runtime now records intent and consumes the exact Executable
`InvocationApproval` in one fenced claim transaction. Effect admission remains
a separate fenced transaction before Sandbox/Executor; terminal settlement
remains later. Stop/quiescence and current authority are checked at the
accepted boundaries. Legacy uncertainty cannot be rewritten as a no-effect
outcome.

The P4 architecture test no longer requires `ApprovalConsumption` as an
independent stage. That stage was merged into the accepted atomic
`IntentJournal` claim; the remaining stage ownership assertions are present.
The same-invocation approval-reentry test asserts that intent and consumption
share one `TransactionScope`, and the adapter/runtime tests cover rollback on
claim failure, one-use consumption, stale fencing, and the pre-effect gate.
Mock changes add the new store outcomes or fail loudly if unexpected denial or
interruption paths are entered; the existing provider/tool business assertions
remain.

Control `ActionApproval` for AssignWork remains a distinct Gateway-owned
transaction contract. This P36 work changes neither its approval ledger nor
the P12 view/command authentication boundary.

## Qualification evidence and limits

The tracked records document L1 adapter/migration qualification (5 files / 10
tests), L2 module runs (9 files / 28 tests, with a later 9-file / 29-test
authority-source run), a separate L2 source-revision plus P12 story-12 run (2
files / 4 tests), and L3 AgentLoop projection (1 file / 7 tests). L4 records
qualify selected P4 store before/after-COMMIT cases, effect-admission takeover,
P4 settlement, and P3 Observation/Action/cursor boundaries. They explicitly
keep AH7-DG-03 and AH7 open.

The aggregate runner counts `adapter 13`, `L2 31`, `architecture 158`, and
`typecheck` may refer to additional integration output, but this tree has no
tracked result record proving those exact aggregate counts. I did not rerun or
independently verify them. No full `pnpm check` or full functional suite was
run for this review.

The evidence is not approved-Executable end-to-end qualification. The audited
production `ExecutableToolHandler` still supplies `approvalId = null`, and
there is no production `InvocationApproval` issuance/binding route. Store-level
atomic claim tests do not replace that route. Any wave specifically claiming
an approved Executable call needs an owner-approved path and its own
qualification; test-only approval injection would not establish production
evidence.

AH7-DG-02 remains OPEN: `MayHaveStarted` is an admission fact, not proof of
external reality. Active Reconcilable reconciliation and the remaining AH7
crash/replay permutations remain outside the evidence recorded here. No DG-02
or overall AH7 closure is claimed.

## Wave 2 gate

The acceptance/landing record and P2/P3/P4/P9 owner headers still state that
post-landing consistency review is pending; the landing record also requires
separate implementation authorization after that review. This independent
review finds no technical inconsistency in the accepted proposal/hash/owner
package or the P36 Wave 1 source, and may be used as input to the formal review
record. Wave 2 should begin only after the coordinator records the required
post-landing review outcome and the separate implementation authorization.

For a Wave 2 limited to already accepted no-approval executable crash/recovery
cases, the recorded P4/P3 foundations are relevant. If Wave 2 requires
approved-Executable end-to-end behavior, that path remains unqualified and
must not be inferred from P4 store/process evidence.
