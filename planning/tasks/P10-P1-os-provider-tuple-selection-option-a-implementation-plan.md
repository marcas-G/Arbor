# P10 → P1 Option A — Implementation Plan

Status: **PLAN ONLY — production implementation is not authorized.**

## Fixed governance inputs

This plan is pinned to the accepted Option A owner contract:

- Acceptance token: `ACCEPT_P10_P1_OS_PROVIDER_TUPLE_SELECTION_OPTION_A`
- Accepted proposal:
  `planning/proposals/P10-P1-os-provider-tuple-selection-binding-draft.md`
- Proposal canonical LF UTF-8 SHA-256:
  `02D2687AA87D6E2B08D06090F293961CCBCFDFF884B6348872D42AFAA59B3013`
- Owner landing: `9a084f82450a6f61bb1920da6050117e2caee3bf`
- Corrected KAT: `3ddd687fe08170f6a73323655a4182a7f64bbefe`
- Post-landing review record/closure:
  `feaa83b1d61c142fdbd0ecf69720782ddf50d978`
- Review result: B0=0, B1=0, B2=0.

The owner documents and manifest are the implementation source of truth. If
the owner landing is amended after this plan's SHA is pinned, this plan is
stale and must be re-reviewed before any implementation is considered.

## Scope and hard boundaries

Implement only the accepted explicit provider-tuple selector:

1. P1 OsEnforced command payload requires exact `providerVersion` and
   positive-safe-integer `capabilityRevision`; the handler uses schema 2,
   with schema 1 allowed only for exact prior-receipt replay.
2. P10 exposes `SandboxPolicyCandidateReadV2` / `SandboxPolicyCandidateV2`,
   adds capabilityRevision to each OsEnforced candidate and to the accepted
   candidate-ID preimage/KAT, and preserves presentation-only candidate IDs.
3. P1 preparation matches exactly one Supported row from the already
   validated P5 V2 snapshot using the accepted exact tuple and existing
   full-bundle/registry/CAS behavior.
4. P13 renders and maps the deliberate candidate's providerId,
   providerVersion and capabilityRevision to P1 without candidateId or
   inferred/default selection.

No migration or DDL change is in scope. P5 bundle/registry/high-water codecs,
Supported qualification, operator provisioning, P1 internal result bytes,
decision/event/receipt transaction, P4 snapshot codec, TrustedLocal semantics,
T2/T3 providers, provider registry contents and Web route/ViewId remain
unchanged. A test-only Supported row proves selector behavior only; it cannot
be represented as a real Supported host qualification. No code may start an
OS provider during selection/qualification tests, and an OS failure may never
fall back to TrustedLocal.

## Implementation DAG (RED before GREEN)

### A — Closed DTO/codecs and KAT

Likely owner files:

- `packages/domain/src/sandbox-policy-candidate.ts` and its focused tests.
- `packages/api-contracts/src/views.ts`.
- `packages/projection-runtime/src/views/workspace-detail.ts`.
- Any exact P10 serialization/codec fixtures mechanically consuming the V1
  candidate type.

Add failing tests first for exact Candidate V2 closed keys/order, safe integer
capabilityRevision, trusted-host omission, P10 candidate ordering, and the
candidate ID. Required OsEnforced KAT: tuple strings
`sandbox.provider.test,1.0.0,7,ReadOnly,Disabled,3,` plus 64 lowercase `a`
hex characters, variant byte `0x01`, existing domain
`arbor:sandbox-policy-candidate:v2\0`, and ID
`spc2_fe70c74f7f7674ad4b09b636e21dabc47ae99af2080a6a7a68d15960a8603094`.
The existing TrustedLocal KAT remains byte-identical. Two candidates differing
only in capabilityRevision must have distinct IDs; no P1 payload accepts
candidateId.

### B — P1 command schema and old receipt compatibility

Likely owner files:

- `packages/application/src/commands/decide-sandbox-policy.ts` and focused
  application tests.
- `packages/application/src/external-command-codec.ts` and codec registry /
  descriptor tests.
- `packages/application/src/command-result-codec.ts` and receipt codec tests.
- `packages/application/src/gateway.ts`/gateway tests only as required by its
  existing `priorReceiptSchemaVersions` compatibility contract.

RED cases: OsEnforced with both selector fields succeeds in strict decoding;
missing both under the current handler and partial pair fail closed to the
specified semantic outcomes; wrong primitive, noncanonical/empty version or
invalid capability revision cannot proceed. TrustedLocal rejects either
OS-only field. Preserve result `SandboxPolicyDecisionCommittedInternalV1`
and its bytes; register its existing strict decoder for current handler
schema 2 and historical schema 1.

Receipt compatibility tests must prove: an exact stored schema-1 receipt
with the exact legacy payload replays before preparation using the existing
stored-version fingerprint/result decoder; a changed old tuple is
`IdempotencyConflict`; and a legacy-shaped request without a matching
receipt does not write a schema-1 receipt, instead commits the current
schema-2 `SandboxAuthorityUnavailable` rejection with no decision/event.
No old schema is chosen from request shape and no row/result is rewritten.

### C — Exact P5 row selection and P10 candidate production

Likely owner files:

- `apps/single-workspace/src/sandbox-policy-decision-preparation.ts`.
- `apps/single-workspace/src/sandbox-policy-candidate-read.ts`.
- Existing P5 V2 authority bundle/snapshot ports are consumers; change their
  wire/storage codecs only if a focused test proves the accepted contract
  requires it (current accepted design says they do not change).
- `apps/single-workspace/test/sandbox-policy-decision-preparation.test.ts`,
  `sandbox-policy-candidate-read.test.ts`, and existing boundary/materializer
  tests.

Use one immutable verified P5 V2 snapshot and trusted process-local
currentHost. Exact selection binds providerId, providerVersion,
capabilityRevision, osFamily/osBuild, selected profile, NetworkPolicy mode,
codec version 1 and canonical enforcementRuleSetDigest. Accept only one
exact `Supported` row with valid required evidence; absent, Experimental,
Unavailable, wrong-host/build, wrong version/capability/profile/mode,
missing/mismatched evidence/ruleset or ambiguity is fail-closed. Existing
provider-registry and full-bundle CAS retain their semantics. No row ordering,
highest-version choice, Cartesian product, candidateId or handle digest may
select a row.

Evidence-binding RED cases must also prove that the referenced accepted
evidence binds the same providerId/version/capabilityRevision/host/profile/
network/rule-set tuple, all six configured limits, and the exact current
operator-config revision/digest (which binds its environment allowlist).
Use the existing evidence verifier and its P5 Supported-admission/source
boundary, including
`adapters/sandbox-windows/src/qualification-manifest.ts`,
`adapters/sandbox-windows/test/windows-qualification-manifest.test.ts`,
`apps/single-workspace/src/sandbox-authority-bundle.ts` and
`apps/single-workspace/test/sandbox-authority-bundle-v2.test.ts` as applicable.
If P1 preparation does not read evidence contents, establish that P5's
existing validated Supported/admission boundary rejects each mismatch; a
nonempty ref alone is insufficient. If no existing enforcement point can
prove the accepted binding without inventing a new source/semantic contract,
stop and raise a design gap before implementation rather than relaxing the
test or marking the row Supported.

Candidate production copies version and capability revision from that row,
sorts by the accepted tuple, collapses only exact duplicates, and emits no
partial list for conflict/ambiguity. It never probes or qualifies a provider.
The P10 read remains read-only, uses the existing P4/P11 barrier, and exposes
no evidence, current host, paths or provider diagnostics.

### D — P13 deliberate selection mapping

Likely owner files:

- `apps/web/src/commands/sandbox-policy-selection.ts` and its focused test.
- `apps/web/src/views/WorkspaceDetailView.tsx`,
  `apps/web/src/commands/forms/DecideSandboxPolicyForm.tsx`, and existing
  Web sandbox selection tests only for the safe capabilityRevision display
  and exact form/payload mapping.

Select one candidate by current read membership, display provider version and
capability revision so otherwise identical tuples are distinguishable, and
copy the exact providerId/providerVersion/capabilityRevision plus existing
profile, matching network policy, registry pair, common preconditions and
selected boundary digest. Never transmit candidateId, list/reason, current
host, evidence ref or diagnostics. Preserve explicit TrustedLocal confirmation,
stale receipt behavior, whole-list refetch, and no auto-select/poll/retry.

### E — P1 real schema-50 transaction and P2/P4/P9 successor qualification

Use only fresh/disposable schema-50 test databases. Extend the existing real
SQLite Gateway tests at
`apps/single-workspace/test/sandbox-policy-decision-gateway.atomic.test.ts`
and crash-child matrix as needed. Prove exact commit/replay, changed tuple
conflict, current-schema legacy rejection, unsupported/ambiguous no-decision,
stale registry/full-bundle CAS receipt, stale handle-binding CAS with the
stable `SandboxHandleBindingDigest` field/no decision/event, and atomic
decision/result/receipt/event invariants. Run synchronized same-CommandId
submissions through independent SQLite connections/processes: exactly one
decision/event/receipt may commit, and the loser must return the exact replay
or existing tuple conflict according to its semantic fingerprint. No schema
migration or online database is touched.

For accepted V6-E qualification, first establish a fresh explicit current
Supported test tuple and commit the fresh P1 policy, then commit the exact P4
NotAdmitted intent/RecoveryBinding. Stop/quiesce the daemon before changing
P5 configuration. With the daemon stopped, update only registry semantic
contents and required revisions/digests: child revision/digest, enclosing
bundle revision/digest, source persisted/verified first, then protected
high-water commit using existing P5 order. Restart against the same
schema-50 database. Verify the same action/invocation/binding survives,
P2 `PreDispatchLeaseCheck` is false before any lease/dispatch/effect/Provider,
and submitting the stale old selector under a fresh CommandId yields the
stable durable stale receipt with no new decision/event (the original
CommandId continues to replay its exact committed receipt). No provider
process is called and no real host Support is claimed.

## Gate order and stop conditions

For each layer, add one failing focused assertion before its implementation,
then run only the owning focused test. Progress in DAG order. Before each
commit run the directly affected build/typecheck, Biome and architecture
guards plus `git diff --check`; retain exact counts and command results in the
implementation result. Do not run the full repository suite until the
focused layers are green and explicitly scheduled.

Stop and request design governance if implementation requires changing any
accepted payload fields/order, candidate ID domain/order beyond the fixed
preimage, supported-row uniqueness, stable rejection/staleness mapping,
P5 high-water operation, receipt compatibility, P4/T3 evidence, SQL schema,
TrustedLocal behavior, or any unsupported fallback. Do not resolve such a gap
by code, migration, optional field, coercion, or hidden default.

## Authorization

This document is an implementation plan, not implementation authorization.
It authorizes no source edit, migration, database upgrade, provider
qualification, Supported-state change, deployment or release. Wait for a
separate explicit implementation token before starting code work.
