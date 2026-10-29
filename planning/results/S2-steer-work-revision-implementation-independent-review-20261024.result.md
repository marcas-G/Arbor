# S2-RDG-01 Work Revision Implementation — Independent Code Review

**Disposition: PASS — Blocking = 0** for the reviewed source and focused
qualification scope.  
**Reviewed HEAD:** `fb52aa8531ad5b17dd7a6d760f2bc0f7a887e4ad`  
**Relevant implementation commits:** `2f377d75`, `6ac6432f`, `11591478`,
`5373ee19`, `51688893`, and the formatting-only `fb52aa85`.  
**Review type:** source/test review with focused light verification. No
production process, daemon, real Provider, deployment, or existing/preserved
database was accessed.

## Governance boundary

The implementation corresponds to the accepted S2-RDG-01 package and its
independently reviewed design landing. This review reports code-level
consistency only; it does not add S2 real-provider qualification, migration
activation, or release readiness. P52 is registered in source, but migration
verification in this review used only the disposable schema-51 test fixture.
No current or preserved database was upgraded.

## Findings

### Typed operations, schema versions, and receipt replay

`SteerWork` current writes use handler schema version 2 and declare schema 1
as the prior receipt version. The external codec keeps schema-v1 payloads
guidance-only, rejects mixed legacy/typed payloads, and permits an explicit
`DirectionGuidance | ContractAmendment` discriminator only under the v2
payload shape. The handler result codec supports both receipt result versions.
P1's existing exact tuple remains authoritative: a v1 receipt is replayed
only for the exact legacy guidance request using its stored v1 fingerprint;
a same-CommandId amendment is an `IdempotencyConflict`, not an upgrade or
relabel of the old receipt. The focused replay test verifies both cases.

The shared mission validator rejects an empty mission, empty criteria, and a
mission with no required criterion. P6 runs this validation before the
Work-row CAS, revision-history append, Inbox admission, event, or successful
receipt outcome. The invalid-amendment test verifies the Work stays at its
original revision with no Inbox or Steer/Amended event. Malformed external
payloads are rejected by the closed codec before the command handler.

### P52 ledger, CAS, atomicity, and replay

P52 creates the immutable logical WorkContract revision ledger keyed by exact
`(WorkId, WorkRevision)`, with a canonical full snapshot, SHA-256 digest,
record kind, source command, actor/provenance, and timestamp. Update/delete
triggers preserve append-only history. The disposable migration backfills only
the exact current Work row as `LegacyCurrentSnapshot`; it does not reconstruct
older revisions. The migration test also proves schema/version rollback when
application fails, idempotent re-run, and immutability.

AssignWork appends the initial snapshot. SteerWork performs an exact
`Open + expected WorkRevision` CAS and, in the same P1 TransactionScope,
replaces all normative Work fields when amended and appends the new snapshot
for either operation. Event, HumanIntervention, Inbox, and the one P1 receipt
remain in that transaction. The P52 append store requires `TransactionScope`,
so insert/CAS/Inbox/event/receipt failures roll back together. No other
production `WorkRepository.create` or `refineIfRevision` writer was found
outside AssignWork/SteerWork.

### Normal/Critical and P12 authority

Normal and Critical share the same typed operation, human-origin check, exact
Workspace/Work authority, revision CAS, full history snapshot, versioned
event, receipt and replay semantics. Critical still routes through the
existing P12-resolved exact active-main StopExecution composite inside the
same outer Gateway transaction/receipt. The transaction re-reads the current
Workspace active main, refreshes Stop authority if the prepared main changed,
and fails the whole composite if exact Stop authority/handling fails. The
no-active-main path commits the steer without inventing a Stop. The P6
Critical Steer focused tests passed.

### P8 exact-revision mission and old Verification

StartVerification now requires the P52 snapshot for the observed current
Work revision, verifies that the full stored snapshot matches the canonical
Work row at that same revision, and verifies that the submitted mission is
exactly its canonical VerificationMission. Missing/inconsistent history or
mission mismatch returns `InvalidVerificationMission` before Verification
insertion. The focused P8 start tests passed, including invalid/no-required
mission rejection.

Existing Verification rows, results, receipts, and wake logic remain
revision-bound and unmodified. Old Open Verification continues to use its
immutable mission/target revision and cannot satisfy new-revision Acceptance
or CompleteWork; this implementation adds no cancel/relabel or old-wake
retargeting path.

`WorkAmended` is a distinct version-1 event; `WorkSteered` v1 remains the
DirectionGuidance event. The new event carries only Work identity, revision
transition, and severity; the complete contract remains in the P52 ledger.
P10 pairs either event with the existing `HumanInterventionApplied(Steer)`
fact. No existing event payload, public route/DTO, API field, or permission
was widened by this implementation.

## Focused verification

- Focused domain/codec/P6/P8/P10/P52 tests: **7 files, 78 tests passed**.
- `pnpm --filter @arbor/single-workspace build`: **PASS** (`tsc -b`).
- Biome over the 39 changed TypeScript files after the export-order fix
  `fb52aa85`: **PASS**.
- `git diff --check`: **PASS**.

These checks do not run a process journey, real Provider, `pnpm check`,
full functional suite, or release profile. No S2 real-provider pass is implied.
