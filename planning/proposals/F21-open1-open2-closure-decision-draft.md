# F21 OPEN-1 / OPEN-2 Closure Decision Draft

Status: **DRAFT; requires manual governance acceptance. No `docs/design/**`,
production code, migration, or behavior change is authorized by this draft.**

Baseline: FT-DG-01 v3 functional-scope contract, accepted owner landing, and
FT-DG-01 v3 pre-acceptance decision note. This proposal addresses only durable
Profile attribution (OPEN-1) and historical CreateProject v1 same-ID replay
(OPEN-2). It does not reopen OPEN-3 activation recovery, FT-DG-03 wire/auth/
tuple ordering, or the CreateProject v2 resource-admission boundary.

Suggested decision tokens:

- `ACCEPT_FT_DG_01_PROFILE_SOURCE_AUDIT`
- `ACCEPT_FT_DG_01_V1_RECEIPT_PRESERVE_ONLY`

The governor may accept both decisions as one package or accept neither. A
partial acceptance must identify which token is accepted; silence or a green
F21 functional journey is not acceptance.

## OPEN-1 — durable Profile source attribution

### Recommended decision

Record the selected CreateProject resource source on the durable Project and
make that source available through the Project-owned read surface. The source
is a closed value:

```text
Profile { resourceProfileRef, version }
ConversationOnly
LegacyUnknown
```

`Profile` records which host-registered choice the creator selected;
Workspace `ResourceBoundary` remains the authority for the canonical resource
actually used. Profile references remain identifiers, not capabilities, and
the audit view must not expose a filesystem path. A missing, renamed, or
retired host Profile does not erase the historical source value or change the
Workspace boundary.

The owning implementation package, if accepted, is:

- P1 Project/`CreateProject` contracts: persist `Profile(ref, version)` or
  `ConversationOnly` with the Project in the existing atomic transaction.
- P1 SQLite schema: add a forward-only migration for the closed source value.
  Existing Projects become `LegacyUnknown`; do not infer a Profile from a
  Workspace path, event payload, or surviving Command receipt.
- Project read port/view: return the non-path source discriminator and
  Profile identity/version to an authorized Project-detail consumer. Catalog
  availability is separate from historical attribution.
- Preserve existing `ProjectCreated` EventVersion 1 and its payload. Do not
  add EventVersion 2 or increase reader ceilings in this package.

This choice uses the Project as the stable lookup anchor. Receipt-only
attribution is rejected as incomplete because `CommandStore` is indexed by
CommandId and does not currently provide a retained Project-to-CreateProject
receipt query after event retention. EventVersion 2 is rejected from this
package because P1 readers currently quarantine newer versions. Either choice
could be reconsidered only through a separately reviewed owner package.

### Required evidence after acceptance

The implementation must prove Profile and ConversationOnly sources commit
atomically with Project creation; the Project read surface returns the exact
source without a host path; old Projects migrate to `LegacyUnknown`; changing
the host catalog does not rewrite historical attribution; and access to the
source read surface follows existing Project authorization. Rejection and
transaction-failure cases must leave Project/source state unchanged.

F21's existing Profile browser journey proves resource use from the durable
Workspace boundary, but does not prove this attribution read contract.

## OPEN-2 — historical CreateProject v1 same-ID replay

### Recommended decision

Historical CreateProject v1 payloads and receipts remain preserve-only. Arbor
does not promise successful replay of an old v1 CreateProject request after
the CreateProject v2 rollout, including when the old CommandId belongs to
`user:local` and the host still exposes the same directory.

The observable rules remain:

- A raw-address v1 payload is rejected by the current strict external
  Command codec before receipt lookup. It produces no attempt, event,
  canonical mutation, or receipt change.
- A current, valid v2 request that reuses a CommandId whose stored row has the
  v1 schema reaches only the normal Gateway tuple comparison after current
  authentication, Actor binding, and Resolver visibility. The schema mismatch
  returns `IdempotencyConflict`; the old row remains byte-for-byte unchanged.
- No Composition, shell, Profile catalog, or resolver path may pre-read a
  CommandId. No stored-schema decoder, old fingerprint recomputation, or
  v1-to-v2 receipt migration is added.
- The user can create a new v2 request using a new CommandId. It binds only the
  currently selected Profile/ConversationOnly value and does not reconstruct
  the historical v1 request.

This decision explicitly makes successful historical replay a compatibility
non-goal for the v1-to-v2 upgrade. If a product requirement instead mandates
successful old-v1 replay, this token must be rejected and a separate F23
compatibility contract must specify how it preserves the accepted strict
codec, authority-visibility, and exact-tuple ordering. No compatibility
exception is implied by this draft.

### Required evidence after acceptance

Use a real public-process fixture with a preserved v1 Command row. Verify the
old raw-address payload is rejected without receipt mutation or side effects,
and separately verify a valid current v2 request using that CommandId is
rejected by the tuple/schema mismatch without disclosing old result/error
content. Cover authorized and Resolver-denied callers to prove the receipt is
not disclosed before visibility. Keep the normal exact v2 receipt replay and
same-ID changed-selection conflict cases.

## Explicit boundaries

- This draft does not claim F21 or FT-DG-01 closure.
- It does not change the accepted CreateProject v2 external wire contract,
  host Profile resolution, ownership activation, or P10 OPEN-3 contract.
- It does not define a generic CommandStore corruption Attention source.
- It does not authorize implementation before the exact proposal package is
  manually accepted and its owner landing reviewed.
