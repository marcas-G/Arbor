# F23 / P8 RetryVerification Permanent Replay Origin — Fixed Governance Package

状态：**DRAFT — fixed proposal package; not accepted and not implementation authorization**

Recommended exact design-acceptance token:
`ACCEPT_F23_P8_PERMANENT_REPLAY_ORIGIN_AND_LEGACY_DISPOSITION`

Acceptance of this token authorizes only landing the fixed changes in the
owning design documents listed below and an independent post-landing
consistency review. It does not authorize production implementation, DDL,
migration registration/execution, or test implementation; each remains
separately gated. This proposal itself does not modify `docs/design/**`,
production code, migrations, schema registry, or online databases.

## 1. Evidence and frozen-contract conflict

Commit `bee70f2a58f3c42610fa245adb4d8dd9f9e06b68` correctly removed external
receipt pre-read: P12 Resolver visibility must precede Gateway, and the
Gateway `BEGIN IMMEDIATE` transaction remains the sole Command receipt lookup
and tuple comparison point (DID §4.1B; P1 `01` §3 / `03` §3.1; P12 `02` §2 /
`10` §3). The real-process RED at
`tests/functional/pending/f23-retry-verification-permanent-replay.functional.test.ts`
shows the resulting gap: a first public `RetryVerification` commits, but an
immediate exact same-CommandId/same-payload retry receives HTTP 403
`authority/denied` because the source Verification is now Concluded.

P8 `01` §3A and `06` Story H say exact replay returns the same receipt and
successor IDs without an expiry. P12 `02` and DID §4.1B require current
visibility/authorization before receipt access. P1 `04` §6 says Commands are
never hard-deleted, while Domain Events may be deleted after a deployment-
configured retention horizon. Current `verifications` rows do not retain an
originating CommandId. The event pair is therefore insufficient as permanent
non-receipt authorization evidence.

The fixed recommendation is: **exact replay returns the stored receipt only
if the caller still passes current P12 visibility and authorization**.
Revoked/changed owner authorization, a different actor, or a foreign source
gets the same generic Resolver denial before Gateway and without reading a
receipt. P8's current unqualified wording is broader than that boundary and
must be amended before implementation; do not silently reinterpret it in
code.

## 2. Minimum permanent canonical origin fact

Add a P8-owned immutable physical relation provisionally named
`retry_verification_origins`. This is a canonical non-receipt fact: Resolver
may query it by CommandId; it is not a CommandStore alias and contains no
receipt JSON. The row is retained for the entire lifetime of its permanent
Command receipt and is not subject to Domain Event retention/pruning.

The row contains only these fields:

| Field | Purpose |
|---|---|
| `command_id` | Permanent origin key; primary key and FK to `commands.command_id` |
| `project_id` | Scope of the P8 handoff and current visibility check |
| `actor` | Original external actor identity, checked against current principal and envelope |
| `source_verification_id` | Exact source Verification identity |
| `source_work_id` | Exact source Work / target scope |
| `successor_verification_id` | Durable successor identity from P8 handoff |
| `successor_verifier_execution_id` | Durable verifier Execution identity from P8 handoff |
| `created_at` | Immutable origin creation time |

Do **not** store or compare fingerprint, Handler schema version, fingerprint
algorithm version, summary content, expected Work revision, payload JSON, or
receipt result in this origin relation. Those tuple decisions stay at Gateway.
Origin may use FK protection for Project, source/successor Verification and
successor verifier Execution. Enforce at most one origin per CommandId and
source Verification, and immutable update/delete behavior. Exact DDL, FK
deferral, uniqueness and trigger details belong to the accepted owning P8/P1
contract; migration number is deliberately **TBD**.

### Resolver and Gateway semantics

1. Decode the strict external envelope and require declared Actor to match the
   authenticated Principal. Malformed CommandId remains the existing HTTP 400
   codec failure before Resolver/Gateway.
2. For a normal first retry against an Open exact source, use the existing
   current P12 human authority path.
3. For a non-Open historical source, Resolver queries `retry_verification_origins`
   by candidate CommandId. It then requires bound project/actor/source Work and
   Verification IDs to match the envelope and requires the current caller to
   remain authorized for the bound source. No origin or any project/actor/
   source mismatch returns the existing generic `authority/denied` before
   Gateway. It does not query CommandStore or compare receipt tuple fields.
4. For an origin match, Resolver supplies a dedicated replay-only authority.
   It intentionally does not compare summary, expected Work revision, or
   successor Verification/Execution IDs from the candidate payload. Therefore
   changed summary/revision/successor IDs with the same CommandId and same
   source scope reach Gateway and take Gateway's existing complete-fingerprint
   `IdempotencyConflict` branch. Changed source/project/actor remains a
   pre-Gateway generic deny.
5. Gateway remains the only component to look up the receipt. Under
   `BEGIN IMMEDIATE`, exact tuple returns the original decoded receipt;
   mismatch returns the existing non-disclosing `IdempotencyConflict` before
   either JSON field is decoded; neither branch writes/repairs the receipt,
   attempts, canonical state, Event, or spawn intent.
6. If a replay-only authority reaches Gateway but the receipt row is absent,
   Gateway must return the existing narrow safe
   `PersistenceCorruption<"CommandStore">` / external
   `persistence/corruption` unavailable response, with no handler invocation
   or writes. It must not turn an origin-only row into a new retry.
7. Malformed, duplicate, contradictory, or FK-inconsistent origin facts fail
   closed with a typed persistence-corruption disposition mapped to a fixed
   safe response; no row contents, receipt bytes, raw JSON, fingerprint, or
   parser/database text is exposed.

Current visibility is intentionally evaluated on every exact retry. If
authorization is revoked or the current governing owner changes so the
original actor is no longer permitted, Resolver denies without receipt access.
Restoring valid current authority allows exact replay again. A different
CommandId for the same source has no origin row and cannot obtain a
replay-only authority.

## 3. Atomic write, migration and legacy disposition

The origin row is written in the same successful Gateway command transaction
as the old `Unknown(Orphaned)` conclusion, successor Verification, durable
spawn intent and Committed receipt. The handler writes only the typed origin
facts; any FK to a Command inserted later in the same Gateway transaction must
be deferred until commit. If a command fails, the origin is not written. A
pre-commit crash leaves none of the handoff/origin/receipt facts; a
post-commit crash leaves all. Replay creates no additional Verification,
Execution, Event, spawn intent, or origin.

The migration identity is **TBD** pending accepted owning-doc changes. It must
be ordered, transactional, monotonic, safe to re-run after an already-committed
version, and roll back schema/data together on an interrupted transaction. No
migration is registered or applied by this proposal.

### Evidence-gated backfill

Backfill an old successful receipt into `retry_verification_origins` only when
all available canonical evidence proves the exact handoff:

- a strict current `RetryVerificationResult` receipt decodes as Committed and
  its CommandId/ProjectId and source/successor Work, Verification and Execution
  IDs are internally consistent;
- exactly one `VerificationConcluded(v1)` and one `VerificationStarted(v1)`
  event are present with the same `caused_by_command_id`, ProjectId and actor;
- the conclusion event binds the exact source Verification, Work and target
  Work revision, `Unknown`, and `Orphaned`;
- the start event binds the exact successor Verification, same Work and target
  revision; the canonical successor Verification and
  `verification_executions` facts bind its verifier Execution to the exact
  result ID;
- the current command row is Committed and its ProjectId agrees.

If any field is absent, malformed, duplicated, pruned, or inconsistent, do
not guess from Session text or repair/delete the receipt. Mark the recognized
successful receipt `UnboundLegacy` in a separate immutable legacy-disposition
fact and admit a queryable Governance Inbox item to the current authorized
human route. The disposition carries only bounded identity/reason data, not
raw receipt JSON or summary content. External replay of an UnboundLegacy
receipt is a generic Resolver deny. Governance Inbox admission and the
disposition fact commit atomically with migration/backfill. This is a new
route-specific Inbox use; its exact key, recipient, query/consumption and
rebuild behavior require owner-document acceptance. No automatic backfill
may use a pruned event or a partial receipt to fabricate origin.

## 4. Required test matrix

### Resolver / visibility

- Origin exact CommandId + same project/actor/source Work/Verification and
  currently authorized Root human or exact direct Parent human yields only
  replay-only authority.
- Missing origin / arbitrary new CommandId, wrong project, actor mismatch,
  changed source Work/Verification, foreign source, wrong Parent, Agent
  principal/grant, revoked authority or changed owner all generic-deny before
  Gateway and reveal no receipt/output IDs.
- With exact origin and same source + CommandId, changed summary, expected
  revision, successor Verification ID or successor Execution ID reaches
  Gateway; Gateway returns `IdempotencyConflict`. The test proves Resolver
  did not compare those tuple fields.
- Malformed CommandId returns codec HTTP 400 before Resolver/Gateway.
- Revoke/change owner: exact replay denies; restore current authority: exact
  replay returns the same original receipt.

### Gateway / persistence

- Exact tuple returns the exact stored receipt/result IDs, with unchanged
  receipt bytes and no new attempt, Event, Verification, Execution or spawn.
- Each changed tuple component takes existing conflict behavior before
  corrupt historical result/error JSON is decoded; raw JSON, sentinel and
  fingerprint remain undisclosed; receipt bytes/attempt/Event stay unchanged.
- Origin exists but receipt is missing: typed safe corruption/unavailable,
  zero handler invocation and zero writes.
- Origin row malformed, duplicate, contradictory or FK-broken: typed safe
  disposition; no receipt/result disclosure or repair.
- Two synchronized same-command submissions create one origin/receipt and one
  P8 successor chain.

### Migration / retention / crash

- Fresh and ordered upgrade fixtures create the origin/disposition relations;
  FK checks and uniqueness/immutability tests pass. Reapplying a committed
  migration is a no-op; interrupted migration rolls back completely and can
  be resumed through the ordered runner.
- Evidence-gated legacy positive backfill; negatives for absent/pruned events,
  wrong project/actor, duplicate event pair, source/successor mismatch, wrong
  result shape, incomplete verifier binding and missing receipt. Unprovable
  recognized successful receipt becomes exactly one UnboundLegacy disposition
  plus one queryable Inbox item; receipt bytes are preserved.
- Crash immediately before and after commit proves the source conclusion,
  successor, spawn intent, origin, Inbox disposition when applicable, and
  receipt are atomic.
- Prune the source event pair after its configured retention horizon; the
  permanent origin still supports exact authorized replay and cannot be
  pruned with Events. No retention-window-only evidence is sufficient.

### Public-process qualification

Real production daemon/public `/commands` journey: first retry commits; exact
authorized replay returns the same receipt and successor IDs; changed tuple
returns Gateway conflict; changed source/project/actor and unauthorized
caller get generic pre-Gateway denial; arbitrary CommandId gets no replay
authority; missing receipt with origin returns safe corruption; no replay
duplicates canonical state or spawn. Run P8 handler, Resolver, Gateway,
transport and existing P1 exact-tuple corruption cases together.

## 5. Owning-document changes required before implementation

This is not an implementation-only seam. The following owners must explicitly
accept the narrowed contract and permanent origin:

- **P8 `01` §3A and P8 `06` Story H:** narrow “exact replay returns” to
  “current-authorized exact replay”; define changed-tuple routing, durable
  origin, and UnboundLegacy disposition/Inbox behavior. This changes the
  currently unqualified replay promise and P8's current no-Attention/no-new-
  surface boundary must be reviewed (proposal recommends Governance Inbox,
  not P10 Attention).
- **P1 `01` §3 / §3A and P1 `03` §3.1:** define replay-only authority with
  missing receipt as safe `PersistenceCorruption<CommandStore>`, and preserve
  sole Gateway tuple lookup/linearization and mismatch-before-decode order.
- **P1 `04` §6 and migration owner:** define origin/disposition storage,
  deferred FK/immutability, no-prune lifetime, migration ordering/idempotence,
  backfill and UnboundLegacy legacy policy. Migration id remains TBD.
- **P12 `02` §2 and P12 `10` §3:** authorize the narrow non-receipt origin
  read and current visibility/actor/source checks; resolver never reads
  CommandStore and never compares fingerprint/schema/algorithm.
- **P6 `02` Communication Protocol plus P8 owner:** define the route-specific,
  human-only durable Governance Inbox entry for UnboundLegacy and its stable
  key/recipient/consumption/rebuild semantics. If P10 Attention is chosen
  instead, P10 `02`/`04`/`07` and `00` must separately accept a new source;
  this proposal does not choose or authorize that alternative.

Until those owner changes are accepted and landed, preserve the current
bee70f2 Resolver-before-Gateway behavior and keep the RED test isolated. Do
not add a state-only replay authority, event-retention-window workaround,
unregistered migration, production code, or online upgrade. The token at the
top accepts only the named owning-document landing and independent
consistency review. Production code, DDL, migration registration/execution,
and test implementation require separate authorization after that landing.
