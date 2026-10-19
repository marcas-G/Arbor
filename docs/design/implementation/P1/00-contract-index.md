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

P1 `01`–`06` retain the existing command fingerprint/receipt, transaction,
schema, event and recovery contracts. The V21 derived
`SandboxRecoveryBindingFailure` Attention adds no P1 command, persisted enum,
event, marker, table, column, migration or schema change; P1 remains the
owner of the unchanged immutable RecoveryBinding bytes/hash.
