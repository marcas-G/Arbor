# F18 Verification v2 Consumer and Read-model Convergence — Governance Draft

Status: **DESIGN GAP / manual decision required**  
Date: 2026-10-21  
Reproduction baseline: `fcc2e64287ef2be73301631e0d4322cd3c9e8c9b`

## 1. Observed failure

The public F18 journey creates a child Workspace with an initial Work, lets the
child claim completion, runs an independent Verifier, and expects the Parent to
receive and accept the verified child result.

The production-process reproduction proves all facts before delivery are
correct:

- the child owns the expected `FileTree` boundary;
- the Verifier `read` invocation resolves that boundary and reads
  `proof.txt` as `FUNCTIONAL_VERIFIED`;
- one ToolObservation Evidence row is committed against the exact terminal
  invocation/result;
- the canonical Verification concludes `Pass`;
- `verifications.criteria_results` contains the complete required criterion
  with verdict `Pass` and the exact Evidence ID;
- the `VerificationConcluded` v2 event contains the same mission, ordered
  criterion result, verdict, evidence and `Available` snapshot status.

Nevertheless, no `child-result:<verificationId>:<revision>` Parent Inbox entry
is admitted. F18 times out before Parent Acceptance.

## 2. Common root cause

The accepted VCS contract (DID v1.48; P8 `01` / `04`) requires every new
ordinary Verification conclusion to emit `VerificationConcluded` event version
2. The older frozen P1 `05` section 3 still says the reader ceiling is globally
version 1. Production `packages/application/src/consumer-loop.ts` implements
that older global ceiling literally.

As a result, every generic consumer quarantines the valid event before its
event-type handler runs. In the reproduction, the `workflow-signals` consumer
advances past the event and writes:

```text
consumer_id = workflow-signals
sequence    = <VerificationConcluded sequence>
reason      = unsupported eventVersion 2
```

The same sequence is quarantined by the other generic consumers. The workflow
consumer therefore never executes its already-correct
`deliverVerificationConcluded` path and cannot admit or wake the Parent.

A second stale implementation is visible on the same journey:
`packages/projection-runtime/src/views/verification.ts` still hard-codes every
criterion verdict to `Unknown`, based on the superseded assumption that P8 did
not persist criterion snapshots. P46 and the accepted P8 contract now do
persist them. Thus the public view reports aggregate `Pass` with required
criterion `Unknown`, even though canonical storage proves criterion `Pass`.

This is not a Verifier, resource-boundary, sandbox, provider, or fixture
failure. Treating `Unknown` as `Pass`, skipping the criterion, or weakening
Acceptance would conceal the defect and is prohibited.

## 3. Design contradiction requiring governance

Two frozen statements cannot both govern new writes:

1. P1 `05` section 3: the reader supports only `eventVersion <= 1`, and any
   higher version is poison.
2. DID v1.48 / P8 `01`: new `VerificationConcluded` writes are exactly event
   version 2 and must drive downstream delivery/recovery.

Raising one global integer ceiling to 2 is unsafe: it would silently accept
version 2 of every event type, including types for which no v2 decoder or
semantics exist. Keeping the ceiling at 1 makes every valid new Verification
conclusion undeliverable. The owning P1 event-reader contract therefore needs
an explicit event-type/version capability rule.

## 4. Recommended fixed decision (Option A)

### F18-V2-1 — exact event-type/version support

Replace the single global reader ceiling with an exact support predicate:

```text
VerificationConcluded: versions 1 and 2
all other currently registered event types: existing version-1 support only
unknown event type/version pairs: poison, quarantine + offset advance
```

This is a decoding/admission table, not an instruction to infer fields or
upcast bytes. `VerificationConcluded` v1 remains strict historical input.
Version 2 is strictly decoded according to the accepted VCS snapshot contract.
No other v2 pair becomes readable merely because its numeric version is 2.

The same predicate must govern every ordinary event-reader implementation,
including the Application consumer loop and the SQLite generic consumer
runner. CC-3 remains unchanged for unsupported pairs.

### F18-V2-2 — handler payload ceiling remains narrow

Consumers that do not own `VerificationConcluded` semantics may ignore the
supported event after the common journal/projection apply, as they already do
for unrelated supported v1 events. The workflow-signal consumer alone uses its
existing minimal tuple (`verificationId`, `workId`, target revision, verdict)
to deliver the wake/Inbox fact. Criterion snapshot bytes grant no new
authority.

### F18-V2-3 — already-quarantined v2 recovery

Changing the reader table does not repair databases whose consumer offset has
already advanced past a valid v2 event. Startup recovery must perform an
idempotent, bounded workflow-signal reconciliation for an exact historical
quarantine:

1. select only `workflow-signals` dead letters whose reason is exactly
   `unsupported eventVersion 2` and whose journal row is exactly
   `VerificationConcluded` v2;
2. strictly decode the v2 event and reread the canonical Verification, Work,
   owner Workspace and Parent Workspace;
3. require exact event/row identity, revision, verdict, snapshot status and
   criterion snapshot equality under the VCS contract;
4. for `Pass` with a current Parent, admit the same deterministic
   `child-result:<verificationId>:<targetWorkRevision>` Inbox key and deliver
   the same idempotent wake as the live handler;
5. if that Inbox key already exists (consumed or unconsumed), do not re-admit
   or re-wake it;
6. retain the original dead-letter row as audit evidence and record a durable
   reconciliation disposition so restart does not repeat work;
7. malformed, ambiguous or non-matching evidence fails closed and becomes
   operator Attention; it is never reconstructed from current Work text.

Other consumers have no owned side effect for this event and need no invented
replay. Their historical dead-letter rows remain audit facts.

The physical table/columns for the reconciliation disposition and the next
migration number require a separately reviewed implementation package. No
existing database may be mutated before that package is accepted and
authorized.

### F18-V2-4 — public Verification criterion projection

The Verification read model must project canonical snapshot availability
without inference:

| Canonical snapshot status | Public `criteriaResults` |
|---|---|
| `Pending` | mission criteria with verdict `Unknown` |
| `Available` | exact stored `criteriaResults` verdicts, preserving mission order |
| `NotApplicableOrphaned` | exact stored empty list |
| `UnavailableLegacy` | mission criteria with verdict `Unknown` |

For `Available`, the read model must verify that stored results are non-null,
complete, ordered and criterion-identical before projecting. Corrupt state is
a typed read failure, not an `Unknown` fallback. Evidence IDs remain exposed by
the existing evidence surface; the read model does not synthesize them.

This rule applies to the per-Work Verification view and every concluded
Verification rendering. An Open Workspace-detail Verification remains
`Pending` and therefore continues to show `Unknown` criteria.

### F18-V2-5 — Acceptance semantics remain unchanged

Parent Acceptance still requires the exact canonical current-revision
Verification `Pass` and its established result reference. Public display does
not grant completion authority. A required `Unknown` criterion continues to
aggregate to `Unknown`; this package never coerces it to `Pass`.

## 5. Required implementation evidence after acceptance

1. Unit tests for the exact event-type/version support table:
   `VerificationConcluded` v1/v2 accepted; arbitrary or unknown v2 rejected;
   version 3 rejected.
2. Consumer-loop tests proving v2 reaches workflow delivery while unrelated
   v2 remains an atomic CC-3 quarantine.
3. Projection tests for all four snapshot statuses plus malformed/corrupt
   `Available` fail-closed behavior.
4. Existing-database recovery tests with the offset already beyond a
   quarantined v2 event: pre/post reconciliation crash, restart, unique Inbox
   entry/wake, durable disposition, and no replay of a consumed result.
5. The real public F18 journey: exact criterion `Pass`, Parent ready-result
   Inbox, Parent `accept_result`, Acceptance and child Work completion.
6. Adjacent Verification/Acceptance, `pnpm typecheck`, Biome, and architecture
   qualification.

## 6. Explicit non-solutions

- Do not raise a global numeric ceiling to 2.
- Do not treat `Unknown` as `Pass` or hide the criterion.
- Do not infer criterion verdicts from the aggregate verdict or Evidence
  existence.
- Do not reset all consumer offsets or delete dead letters without an accepted
  migration/recovery contract.
- Do not re-run Provider or Verifier work to compensate for a delivery-reader
  defect.
- Do not edit `docs/design/**` before manual acceptance of a fixed landing
  package.

## 7. Requested decision token

```text
ACCEPT_F18_VERIFICATION_V2_CONSUMER_AND_READMODEL_CONVERGENCE_OPTION_A
```

Acceptance authorizes only exact design landing and post-landing review. Code,
migration, existing-database reconciliation and release qualification require
a separate implementation authorization.
