# P12 — 05 StorageScaleAssessment / DurabilityEnvelope (G5)

**Authority:** DID v1.14 G5, §9.1 (Storage Strategy), §6A.4 (persistence translation),
§6.3 (fencing scope/atomicity), §10.4.1; SD v1.3 §10.5 (Lease / Fencing), §10.7
(Durability Envelope), §14 No.60; `00-problem-goals.md` G7/#11; P1 `04`; P2 `06`; P9 `02`
(durability assertions) §12; P12 `00` §P11 convergence item disposition; `planning/results/P11.result.md:55/:57`.
**Status:** DRAFT.

## 1. SQLite remains the default

- `adapters/persistence-sqlite` remains the v1 canonical store; no forced migration.
- PostgreSQL is implemented **only if** the declared operating envelope cannot be met.

## 2. `StorageScaleAssessment` (P12 deliverable, frozen mechanism — E-10)

```ts
type EnvelopeDimension =
  | "maxConcurrentRuntimes"
  | "maxWriteThroughput"
  | "maxDbSize"
  | "availabilityTarget"

// R-04: every dimension is a canonical numeric measure, so the comparator is
// total; a string-typed dimension is not admissible evidence.
type Measure = { value: number; unit: string }

type OperatingEnvelope = Record<EnvelopeDimension, Measure>
// e.g. { maxConcurrentRuntimes: { value: 1,     unit: "count"    },
//        maxWriteThroughput:   { value: 500,   unit: "writes/s" },
//        maxDbSize:            { value: 8,     unit: "GiB"      },
//        availabilityTarget:   { value: 0.999, unit: "fraction" } }

type Measurement = {
  dimension: EnvelopeDimension          // exactly one per declared dimension
  observed: Measure                     // measured in the declared unit
  method: string
  workload: string
}

type StorageVerdict =
  | "SQLiteSufficient"
  | "PostgreSQLRequired"
  | "InsufficientEvidence"          // no vacuous pass: added by E-10

type StorageScaleAssessment = {
  operatingEnvelope: OperatingEnvelope
  measurements: ReadonlyArray<Measurement>
  verdict: StorageVerdict
  postgresTrigger: ReadonlyArray<PostgresTrigger>
  governanceGatedTriggers: ReadonlyArray<GovernanceGatedTrigger>
}

declare function assessStorage(
  envelope: OperatingEnvelope,
  measurements: ReadonlyArray<Measurement>,
): StorageScaleAssessment
```

Dimension → trigger table (frozen, R-04 — the mapping the mechanical rule uses):

```text
dimension              direction   violation when       trigger on violation    v1-actionable
maxConcurrentRuntimes  ceiling     observed > declared  MultiWriterControlPlane no  (governance-gated, §3)
maxWriteThroughput     ceiling     observed > declared  SqliteWriteContention   yes
maxDbSize              ceiling     observed > declared  DbHa                    yes
availabilityTarget     floor       observed < declared  DbHa                    yes
```

Mechanical rule (frozen):

```text
assessStorage is pure / deterministic (R = never)
measurements empty, or not covering EVERY declared envelope dimension
  → verdict = "InsufficientEvidence"          (never "SQLiteSufficient")
else a measurement's unit ≠ its declared dimension's unit
  → verdict = "InsufficientEvidence"          (incomparable is not evidence)
else a measured dimension violates its declared direction:
  mapped trigger is v1-actionable
    → verdict = "PostgreSQLRequired"; postgresTrigger = demonstrated v1 triggers
  mapped trigger is governance-gated only
    → verdict = "InsufficientEvidence"; governanceGatedTriggers = demonstrated
else
  → verdict = "SQLiteSufficient"
```

- `SQLiteSufficient` requires **positive measurement evidence for every declared envelope
  dimension** — an empty / partial measurement set can never yield it.
- The DID §9.1 trigger candidates remain **candidates**, not automatic obligations (the v1
  actionable subset is reconciled in §3); only a measured violation produces
  `PostgreSQLRequired`.
- If `verdict = PostgreSQLRequired`, a `persistence-postgres` adapter may be added
  (`adapters/* → domain, ports`, no new edge); the frozen overlap/ownership semantics must
  not change.

### 2.1 Checked-in artifact + schema test (E-10)

```text
planning/results/P12.storage-assessment.json   // a checked-in StorageScaleAssessment
```

- A schema test validates the artifact against the `StorageScaleAssessment` schema and
  asserts `assessStorage(envelope, checkedInMeasurements)` reproduces the artifact verdict.
- The schema test asserts `assessStorage(envelope, [])` does **not** return
  `"SQLiteSufficient"` (no vacuous pass).
- R-04 assertion: one measured violation of a declared v1-actionable dimension yields
  `verdict = "PostgreSQLRequired"` with the **named** trigger from the §2 table (e.g. a
  `maxWriteThroughput` violation yields `postgresTrigger = ["SqliteWriteContention"]`; a
  `maxDbSize` or `availabilityTarget` violation yields `["DbHa"]`). A measurement whose unit
  does not match the declared dimension's unit yields `"InsufficientEvidence"`, never a pass.

## 3. `postgresTrigger` reconciliation with the single-writer control plane (RG-06)

```ts
type PostgresTrigger = "DbHa" | "SqliteWriteContention"
type GovernanceGatedTrigger = "MultiWriterControlPlane"
// governance-gated, NOT a v1 trigger: MultiWriterControlPlane
```

- DID §9.1 lists **three** trigger candidates — `multiRuntimeConcurrentWrite`, `DbHa`,
  `SqliteWriteContention`. P12 does **not** edit the frozen DID; the disposition below is a
  **recorded clarification** (NEW-9), not a silent deletion of the DID candidate.
- `06` (G6) freezes the canonical control plane as **single-writer**: no distributed
  consensus, no multi-writer control plane, and remote workers never open/write the
  canonical DB (`06` §1/§6 CI-1). `multiRuntimeConcurrentWrite` would *imply* a multi-writer
  control plane, so it **cannot** be an actionable v1 trigger.
- Reconciliation: **multi-process canonical writes are NOT permitted in v1.** The
  `multiRuntimeConcurrentWrite` candidate is **retained in DID §9.1 as a candidate** but is
  **non-v1**: P12 classifies it as `GovernanceGatedTrigger = "MultiWriterControlPlane"`
  (see the §2 dimension→trigger table), recorded in `governanceGatedTriggers`, and it never
  yields `PostgreSQLRequired`. A future deployment requiring multiple canonical writers is a
  DID governance change to the control-plane model (and a different consistency model), not
  a P12 implementation option.
- `05` and `06` are therefore consistent: `DbHa` / `SqliteWriteContention` are
  single-writer-compatible; `MultiWriterControlPlane` is explicitly out of v1.

## 4. `DurabilityEnvelope` + backup/restore (P12 owns delivery)

```ts
// R-02: the envelope is the declared side the drill measures against.
type DurabilityEnvelope = {
  backupStrategy: string        // e.g. "sqlite-online-backup + object-store copy"
  schedule: string              // ISO-8601 duration, e.g. "PT1H"
  restoreProcedure: string      // reference to the restore runbook
  declaredRpo: string           // ISO-8601 duration, e.g. "PT5M"
  declaredRto: string           // ISO-8601 duration, e.g. "PT30M"
}
```

```text
DurabilityEnvelope semantics:
  covered: process / worker / runtime / compute-host failure (canonical storage intact)
  declared: backup strategy + schedule, restore procedure, RPO, RTO (the type above)
  verified: restore drill (executed, with evidence)
  out-of-envelope: storage-media / region loss → truthful reporting
```

- P12 owns `DurabilityEnvelope`, backup/restore, RPO/RTO, and the **restore drill**.
- P9 continues to own **runtime fault hardening** (crash/expiry/resurrection/rebuild).
- Out-of-envelope failures must be reported truthfully (SD §10.7), never silently absorbed.
- RPO/RTO comparison is canonical: durations are ISO-8601 strings parsed by `parseDuration`,
  and the drill asserts `parseDuration(artifact.measuredRto) <= parseDuration(envelope.declaredRto)`
  (and `parseDuration(artifact.measuredRpo) <= parseDuration(envelope.declaredRpo)`).

### 4.1 Restore drill command + artifact (E-11)

```bash
pnpm drill:restore
```

emits `planning/results/P12.restore-drill.json`:

```json
{
  "timestamp": "2026-09-22T00:00:00Z",
  "backupRef": "backup://...",
  "restoredDbHash": "sha256:...",
  "migrationUserVersion": 13,
  "measuredRpo": "PT0S",
  "measuredRto": "PT30S"
}
```

- The drill restores a backup and measures actual RPO/RTO against the declared
  `DurabilityEnvelope`.
- R-03 (mechanizable migration assertion): migrations use the integer
  `PRAGMA user_version` (`adapters/persistence-sqlite/src/migrate.ts:31-34`), **not**
  timestamps, so the artifact records `migrationUserVersion` and the evidence test asserts
  `artifact.migrationUserVersion === max(P12_MIGRATIONS.map(m => m.id))`. The old
  "timestamp newer than the last schema migration" assertion is removed as unmechanizable.
- R-02 (duration comparison): the evidence test asserts
  `parseDuration(artifact.measuredRto) <= parseDuration(envelope.declaredRto)` and
  `parseDuration(artifact.measuredRpo) <= parseDuration(envelope.declaredRpo)`, where
  `envelope: DurabilityEnvelope` is the declared envelope from §4.
- Evidence test asserts the file **exists** and both assertions above hold.
- NEW-11 (migration-baseline advance, explicit P12 contract revision): P12 owns advancing
  the migration baseline — the `PRAGMA user_version` high-water mark moves from the P11
  max (`10`, `P11B_MIGRATIONS`) to the P12 max when P12 adds migrations. The restore-drill
  `migrationUserVersion` is pinned to the P12 max (`13` = `0011_lease_worker_incarnation` /
  `0012_permission_grants` / `0013_project_tool_registry`; see `06` §3 list authority), so
  adding a P12 migration is a recorded contract revision, not an implicit baseline drift.

### 4.2 Restore-drill isolation + post-restore fencing (RG-07)

Restore changes the single-writer/fencing picture; the drill and a real restore MUST NOT
resurrect a stale worker incarnation (SD §10.5; DID §6.3):

```text
Drill isolation (RG-07):
  restored state is opened in an isolated drill environment (separate path / read-only)
  restored state is NEVER mounted as a live canonical writer
  no Runtime / worker connects to the restored DB as the canonical control plane
  during the drill

Post-restore reconciliation (RG-07, before accepting any work):
  invalidate leases present in the restored snapshot / advance the lease generation
  reconcile (WorkerId, WorkerIncarnationId, generation) so no pre-restore worker
    incarnation can commit
  run T1 startup recovery; assert no live lease that a stale worker could match
  a restored pre-crash snapshot therefore cannot resurrect a stale worker incarnation
```

## 5. P11 convergence item disposition + cross-phase deferrals (F7)

§5.1–§5.2 are the P11 convergence items; §5.3 is the cross-phase snapshot-pruning
deferral. All are assigned to `05` by `00-contract-index.md`.

### 5.1 `advanceAnchor` residual exposure (`planning/results/P11.result.md:55`)

- **Owned here — concrete fix.** `EnvironmentRevisionStore.advanceAnchor` is **removed from
  the public `ports` surface**; advancement remains reachable **only** through the
  `RecordEnvironmentChange` command path via an internal, non-exported capability, so no
  observation-side code can import or invoke it (P11 `01`; CI-1).
- **P11-closure test amendment (R-01, recorded contract revision; NEW-6).** P11 closed with
  `tests/architecture/p11-closure.test.ts:138-150` asserting the *residual exposure*:
  `expect(environmentPort.includes("advanceAnchor")).toBe(true)` plus the ports re-export
  (`export * from "./environment.js";`). That assertion encodes the pre-P12 state and
  directly contradicts the fix above, so `pnpm check` cannot be green until it is amended.
  P12 therefore **amends `p11-closure.test.ts`** to assert
  `environmentPort.includes("advanceAnchor") === false` (and drops the re-export
  assertion), and the new `tests/architecture/p12-closure.test.ts` asserts the absence
  independently. This is the P12 reconciliation of the recorded P11 residual, **not a
  silent deletion**: `planning/results/P11.result.md:55` remains the provenance, and the
  amended test name/comment records the P12 narrowing.
- **Additional affected suites (B1):** removing `advanceAnchor` from the public port also
  breaks `tests/p11-revision-algebra.test.ts:210-257`, `tests/p11-controlbasis.test.ts:340` and
  `tests/p11-acceptance.test.ts:990`, which invoke `(yield* EnvironmentRevisionStore).advanceAnchor(...)`. These are re-homed
  onto the internal non-exported capability (or the removal is scoped so they still
  type-check) as part of the same recorded amendment.
- Assert: the amended `p11-closure` test and `p12-closure` both prove the ports public
  export surface contains no `advanceAnchor`, and every observation-side module
  (drift / staleness / impact / verdict) has no advancement import.

### 5.2 `parseSnapshotBlob` mtime roundtrip (`planning/results/P11.result.md:57`)

- **Owned here — concrete fix.** Replace the delimiter-based blob encoding with a
  **collision-free structured encoding** (length-prefixed fields or explicit JSON fields)
  so ISO-8601 mtimes containing `:` round-trip exactly; `RegionDiff` no longer degrades to
  the conservative full-set mode.
- Assert: a round-trip test over ISO mtimes containing colons reproduces the exact
  `EnvironmentSnapshotRef`; narrow invalidation is reachable end-to-end (ties to `09`).

### 5.3 Environment snapshot pruning / retention (P11 `02` §3 — "pruning is P12/ops")

- **Owned here.** Environment snapshots (`EnvironmentSnapshotRef` blobs) and their
  retention/pruning are an ops concern owned by this doc; P11 `02` §3 defers it to P12/ops.
- Mechanism (frozen shape, numbers empirical): a retention policy `{ keepLastN, maxAge }`
  over snapshot blobs; pruning is an explicit ops action (never inline in a canonical
  transaction); a pruned snapshot referenced by a still-live change record is refused
  (typed) rather than silently dropped.
- Assert: a pruned-but-referenced snapshot is refused; unreferenced snapshots older than
  `maxAge` (or beyond `keepLastN`) are pruned; canonical records are untouched.

## 6. Invariants

```text
SQLite default unless StorageScaleAssessment verdict = PostgreSQLRequired
StorageScaleAssessment is mechanical: no SQLiteSufficient without measurements
every declared dimension is a { value, unit } measure; a violating v1-actionable
  dimension yields PostgreSQLRequired + its named trigger (dimension→trigger table)
v1 canonical writes are single-writer; multiRuntimeConcurrentWrite is retained as a
  DID §9.1 candidate but non-v1 (GovernanceGatedTrigger = MultiWriterControlPlane)
DurabilityEnvelope declared (typed) + restore drill executed (evidence)
restore drill artifact records migrationUserVersion = max(P12 migration id)
DurabilityEnvelope RPO/RTO compared via parseDuration (measured <= declared)
restore drill is isolated; post-restore fencing cannot resurrect a stale incarnation
out-of-envelope failure reported truthfully
no change to canonical overlap/ownership semantics on storage swap
```

## 7. Must Not Decide

- No forced PostgreSQL; no new distributed consensus / multi-writer control plane (`06`).
- No change to the durability *semantics* owned by SD §10.7 / DID §9.1.
- No replacement of P9 runtime fault hardening.
- No v1-actionable `multiRuntimeConcurrentWrite` trigger: it stays a DID §9.1 candidate,
  classified non-v1 (governance-gated only) — not deleted from the DID.
- No edit to the frozen DID; P12 records the trigger-candidate disposition here only.
- No unmechanizable assertions (timestamp-vs-migration ordering); migration baseline is
  asserted via `PRAGMA user_version`.

## 8. Verification

```text
StorageScaleAssessment present with operating envelope + measurements + verdict
assessStorage(envelope, []) ≠ "SQLiteSufficient" (no vacuous pass)
one measured violation of a declared v1-actionable dimension → PostgreSQLRequired with
  the named trigger from the dimension→trigger table; unit mismatch → InsufficientEvidence
planning/results/P12.storage-assessment.json validated by a schema test
pnpm drill:restore emits planning/results/P12.restore-drill.json; file exists;
  migrationUserVersion == max(P12_MIGRATIONS.map(m => m.id));
  parseDuration(measuredRto) <= parseDuration(declaredRto) (and RPO)
restore drill isolated (restored state never a live canonical writer);
  post-restore lease/generation reconciliation (SD §10.5; DID §6.3)
advanceAnchor absent from the ports public surface; no observation-side advancement import
  (p11-closure.test.ts amended to assert absence; p12-closure.test.ts asserts independently)
parseSnapshotBlob round-trips ISO mtimes containing colons
snapshot pruning/retention (5.3): pruned-but-referenced snapshot refused (typed);
  unreferenced snapshots pruned; canonical records untouched
PostgreSQL adapter absent unless verdict = PostgreSQLRequired
```
