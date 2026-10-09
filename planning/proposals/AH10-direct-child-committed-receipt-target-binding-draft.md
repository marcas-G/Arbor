# Draft — AH10 Direct-child Committed Receipt Exact Target Binding

Date: 2026-10-09

Status: **OPEN DESIGN GAP — proposal only; no governance decision or
implementation authorization.**

## Problem

P1 `07` §2 requires a prior Committed receipt to converge the LogicalAction
without another Command. MAC-P2 requires exact target binding for
`assign_work.targetWorkspaceRef`, while stale, foreign, and retired placement
references fail closed. Those rules do not define how recovery proves that a
Committed receipt belongs to the Workspace denoted by a now-stale opaque ref.

## Crash counterexample

1. The pinned AssignWork action names direct-child A with the opaque ref
   `wref_A`; the exact ref is also the CAPA PermissionGrant target.
2. Gen0 resolves the ref, commits one AssignWork Command, one Work in A, and
   one WorkAssigned event. It crashes before the AgentLoop Action becomes
   Applied or its Observation is persisted.
3. AssignWork changes the placement revision, so the old `wref_A` is stale.
   Gen1 must recover the same LogicalAction without repeating the canonical
   effect.
4. If recovery accepts a same-Project Committed receipt and Work for direct
   child B, the available canonical facts can agree on WorkId, B, Parent
   provenance, and a valid direct-child relationship while the pinned action
   and Grant still name A. They do not prove `A = B`.

The current process reproduction demonstrates the legitimate crash state and
the conservative outcome: gen1 returns `action/target-unavailable`; the
committed Child Work remains unique, while the Action remains Pending and has
no Observation. Provider inference is not repeated. The reproduction is
isolated under `tests/functional/pending/` and excluded from default green
gates.

## Evidence available and missing

Persisted evidence currently includes:

- the pinned ProviderTurnCall arguments, including the exact
  `targetWorkspaceRef`;
- the CAPA PermissionGrant target, which is the same opaque ref;
- the generation-scoped Command receipt with ProjectId, semantic request
  fingerprint and result;
- the deterministic WorkId, result WorkspaceId, canonical Work row and
  WorkAssigned event.

There is no durable `targetWorkspaceRef → WorkspaceId` binding. The current
implementation derives `wref_` as a SHA-256 digest of
`{rootWorkspaceId, childWorkspaceId, workspace.revision}`; the revision used
to create the ref is not stored with the Command receipt, Grant, Work, or
Action. The Command row stores the fingerprint, not the canonical request
payload. Work provenance stores the Parent Work and reason, not the opaque
target ref. The WorkspaceId in the receipt/Work proves where the effect
landed, but does not itself prove that this is the exact child selected by the
pinned ref.

The current deterministic hash formula suggests a possible derivation: for a
candidate WorkspaceId, recompute refs over revisions from zero through the
current revision and compare the pinned ref. The formula is implementation
code, however; no frozen contract authorizes historical-revision enumeration,
defines its version/retention bounds, or guarantees that all prior revisions
are enumerable after import/migration. This remains a candidate contract
direction rather than proof available to the current replay path.

The RED was reproduced against the pre-change production behavior. A proposed
early-receipt bypass was then exercised and withdrawn: checking only the
receipt WorkId, ProjectId, and same-direct-child relationship could accept B
when the pinned ref identifies A. No production change for this bypass is
retained.

## Candidate contract directions for manual decision

These are alternatives for governance review, not accepted semantics:

1. **Persist a binding at first resolution.** Durably bind
   `(ExecutionId, LogicalActionId, targetWorkspaceRef)` to the resolved
   `WorkspaceId` and placement revision. Define its atomic relationship to the
   AssignWork Command receipt and its replay/retention rules.
2. **Make the canonical receipt carry exact target evidence.** Extend the
   immutable AssignWork receipt/result or a dedicated receipt-side record with
   enough data to verify the original ref-to-Workspace binding after the
   Workspace revision changes. Define which fields are fingerprinted and
   which are trusted Runtime evidence.
3. **Fail closed when exact binding is unavailable.** Preserve the committed
   Work and never resubmit the action, but define the durable recovery state,
   Attention/repair path, and how the user can resolve the Pending Action.
4. **Authorize deterministic historical-ref derivation.** Freeze the ref hash
   inputs/version, revision monotonicity and starting point, the candidate
   revision range, uniqueness requirements, computational bounds, and
   fail-closed behavior when no single match exists. Require an A-vs-B
   direct-child test across placement revisions and restart.

## Decisions requested

Manual governance must decide:

- which owning contract defines durable opaque-reference binding and
  Committed-receipt recovery (System Design placement/authority or DID command
  and receipt contract);
- which evidence is authoritative after a placement revision changes;
- whether the binding must be atomic with Command commit and CAPA
  authorization, and how it is retained/migrated;
- what durable user-visible outcome applies when a Committed effect exists but
  exact target binding cannot be proven;
- the resulting implementation authorization and acceptance tests, including
  A-vs-B direct-child, restart, exact Grant target, one effect, no inference
  replay, and fail-closed corruption cases.

No `docs/design/**` file is changed by this draft. No implementation
authorization is inferred from the existing AH10/P1 authorization.
