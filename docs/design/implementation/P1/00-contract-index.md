# P1 — Contract Index

**Authority:** DID v1.6 (phase-scoped closure). These documents are **not** a
fifth design layer; they are the P1-owned implementation contracts authorized
by DID §13.

```text
Detailed Implementation Design v1.6 (frozen)
        ↓ delegates phase-scoped closure
docs/design/implementation/P1/**   (these contracts)
```

DID §13 now points at `docs/design/implementation/P1/**`; a conflict resolves
in favor of the DID.

## Documents

| Doc | Owns |
|---|---|
| `03-transaction-model.md` | `TransactionScope` service, single-transaction command resolution, fingerprint comparison, concurrent duplicate protocol, fence/stop split |
| `01-command-contracts.md` | failure vocabulary, generic pipeline, fingerprint algorithm, P1 command payload/result/rejection/event |
| `02-port-contracts.md` | P1 repository/port method sets, Effect A/E/R, transaction participation |
| `05-event-journal.md` | sequence scope + durable counter, `eventVersion`, offset/projection boundary, poison handling |
| `04-sqlite-schema.md` | DDL, cyclic FKs, indexes, resource-region encoding, migration, retention |
| `06-recovery-matrix.md` | crash-point matrix, durability, attempt recording |
| `07-agent-loop-step-command-identity.md` | DID v1.20 LogicalActionId/LogicalSettlementId、generation-scoped CommandId、receipt-first takeover eligibility |
| `00-contract-index.md` | this index |

## Gap closure mapping

| Gap | Status | Closed by |
|---|---|---|
| P1-DG-01 | RESOLVED (DID v1.5) | DID §6A.15 |
| P1-DG-02 | RESOLVED (DID v1.5) | DID §9.9; implemented by 01/03/04 |
| P1-DG-03 | RESOLVED (DID v1.5) | algorithm frozen in 01 §4 |
| P1-DG-04 | RESOLVED (DID v1.5) | DID §9.7; implemented by 03/04 |
| P1-DG-05 | RESOLVED (DID v1.5) | DID §12.11; implemented by 01 |
| P1-DG-06 | **RESOLVED** (phase-scoped) | 05 (+ 04 sequence table) |
| P1-DG-07 | **RESOLVED** (phase-scoped) | 04 |
| P1-DG-08 | **RESOLVED** (phase-scoped) | 04 (+ 02) |
| P1-DG-09 | **RESOLVED** (phase-scoped) | 04 (+ 06) |
| P1-DG-10 | RESOLVED (DID v1.5, port classification) | sub-items closed by 01 (AssignWork, child-workspace, ID generation) and 02 (port ownership) |
| P1-DG-11 | **RESOLVED** (phase-scoped, authority-as-input-fact) | 01 §2A (VerifiedCommandAuthority + exact-match), 03 §3.1 (replay before authority), 02 §4A (boundary input) |

## P1 command set

`CreateProject`, `CreateChildWorkspace`, `AssignWork` (DID §11).

## Status

FROZEN (contracts) — 4-way review rounds 1–4 complete, **Blocking = 0**.
All P1-DG-01…11 are RESOLVED. **P1-DG-11** was resolved by manual governance as
"authority as a trusted Application input fact" (`01` §2A): P1 defines only the
`VerifiedCommandAuthority` shape and a deterministic exact-match rule; it does
not implement a Permission/RBAC/Authority Resolver and has no default-allow.
No frozen DID document was modified while producing these contracts (DID v1.6
was a separate governance patch).

**v1.20 successor:** `07` is an additive cross-phase design contract. It does
not reopen P1 completion and does not authorize AgentLoopStep implementation.

## Native OS Sandbox governance addendum

`ACCEPT_NATIVE_OS_SANDBOX_CONVERGENCE_V1` and
`ACCEPT_NATIVE_OS_SANDBOX_COMMAND_AUTHORITY_AMENDMENT_V3` add the exact
`DecideSandboxPolicy`/`GrantPermission` authority and persistence contracts
to `01`–`06`. P1 owns the command receipts, immutable policy decision,
issuer-provenance row, migration contract, two versioned events and recovery
atomicity. See the landing record for accepted hashes and the file manifest.
The current-main acceptance and schema-48 rebase are recorded in
`planning/results/native-os-sandbox-schema48-design-landing-acceptance.record.md`
and its companion manifest.

## Accepted Native OS Sandbox schema-48 storage amendment

P1 `04` owns migrations `0049_sandbox_policy_and_grant_provenance`
(requires schema 48; exact durable decision/provenance storage) and
`0050_sandbox_provider_unavailable_fact` (requires schema 49; V5 fact,
queue and marker storage). P1 `05` owns the
`SandboxProviderUnavailable(v1)` wake event. P9 owns the immutable source
fact and P10 the retained admission queue/Attention marker. These migrations
are design-only: neither is registered nor activated, and no database is
upgraded.

## V21 RecoveryBinding Attention compatibility note

P1 `01`/`03`/`04`/`05`/`06` own the complete human wire/CAS/fingerprint,
linearized result/receipt/decision/event join, unchanged DDL, and restart
matrix. `executions.episode_revision` is the already existing P2/EGP CAS
source. P1 owns no new RecoveryBinding fact/event/table/schema; the V21
SandboxRecoveryBindingFailure is a non-persisted P10 projection.

## Accepted Native Sandbox producer mapping closure (V3)

P1 `01`/`03` consume the exact P5 SandboxAuthorityBundleV2 and P11 complete
ResourceBoundary producer, bind the existing operatorConfig revision/digest,
and accept only bounded stable audit refs. The established
DecideSandboxPolicy CAS, receipt-first replay, result/digest join and
transaction boundary remain unchanged; no new payload field, fingerprint
input, event or DDL is introduced. Details are in `01`/`03` and the V3
acceptance record/manifest.

## Accepted Sandbox Policy Candidate Read Model V5

P1/01 accepts only the existing DecideSandboxPolicy payload and common full
authority-bundle CAS for both variants; candidate IDs/list/reason are not
command fields. OsEnforced alone retains the registry branch precondition.
Candidate read is P10 projection data, not P1 authority or fingerprint
input. See P1/01 and the V5 acceptance record.

Accepted pre-intent CandidateRead binds its exact P3 Action and P4 Pending
Executable approval through read-only preparation and P1's final
transaction-scoped CAS. Source drift uses the two additive existing-tag stale
safe fields `ActionRevision` and `ExecutableApprovalRevision`; the latter
also covers trusted-time expiry. P1 wire, semantic fingerprint, handler
schema 2, receipt-first replay and SQLite schema remain unchanged. See
P1/01/03/04/06 and the accepted bootstrap manifest.

The internal P4 `SandboxPolicyPreIntentRequirementV1` source tuple is compared
structurally field-by-field and is not serialized, hashed, persisted or added
to the command fingerprint. P1 resolves the pinned action through existing
P11 rules outside the transaction and rechecks only the existing
Workspace/ResourceBoundary/selected-profile handle and P5 source CAS inside;
no target digest is added. See P4/06, P1/03 and the source-proof correction
decision.

## Accepted candidate profile binding digest V6

P1/01 keeps the existing profile-specific
`expectedSandboxHandleBindingDigest` CAS. P13 maps only the selected P10
candidate's digest to that field; candidate ID remains presentation-only.
No P1 wire or persistence contract changes. See the V6 acceptance record.

## Accepted Option A exact provider selector (2026-10-20)

P1/01 adds required OsEnforced `providerVersion` and
`capabilityRevision`, advances only the DecideSandboxPolicy handler schema
to 2, and retains schema 1 for exact prior-receipt replay. P1/03 binds those
fields to one exact Supported row in the verified P5 V2 snapshot; the
existing full-bundle/registry/boundary CAS and schema-50 storage remain
unchanged. No new result version, SQL object, migration, event, rejection
tag, or implementation authorization is introduced. Accepted proposal SHA-256
`02D2687AA87D6E2B08D06090F293961CCBCFDFF884B6348872D42AFAA59B3013`.
