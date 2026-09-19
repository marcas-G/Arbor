# P1-DG-03 — Idempotency identity: payload_hash vs semanticRequestFingerprint

## Status

RESOLVED — DID v1.5.

## Resolution

DID §9.9 unifies the persisted column to `semantic_request_fingerprint`
(with `schema_version` and `fingerprint_algorithm_version`); DID §4.1 defers
the concrete canonical serialization/hash algorithm to the P1 phase
contract; the P0 32-bit FNV-1a is marked interim.

Authority: DID v1.5 §4.1, §9.9.


## Owning design document

`docs/design/03-detailed-implementation-design.md` §4.1, §9.9;
P0 artifact `packages/domain/src/command.ts`.

## Symptom

`§9.9:2885` names the persisted column `payload_hash`; `§4.1:1095` /
`§12.5:3406` define `semanticRequestFingerprint` covering at least
`commandType, projectId, declared actor, schemaVersion, semantic payload`.
The DID never equates them. A payload-only digest cannot detect a changed
`commandType`/actor/schema under the same `commandId`, which §4.1 requires
to be `IdempotencyConflict`.

P0's fingerprint is an **unversioned 32-bit FNV-1a** over a bespoke
`canonicalize` (null/number/boolean/string/array/object only). Persisted
idempotency identity depends on byte-stable serialization across processes
and releases; a 32-bit hash also carries collision risk for durable identity.

## Evidence

```text
DID §9.9:2885   payload_hash
DID §9.9:2893   same command_id, hash mismatch → IdempotencyConflict
DID §4.1:1095   semanticRequestFingerprint covers commandType/projectId/actor/schemaVersion/payload
DID §12.5:3406  same id + same fingerprint / different fingerprint
packages/domain/src/command.ts  canonicalize + fnv1a (unversioned, 32-bit)
```

## Why planning cannot decide this

The stored idempotency key's semantics, canonical serialization contract,
hash algorithm, versioning, and collision policy are **identity semantics**.

## Required resolution

Freeze: column name/semantics (fingerprint, not raw payload digest);
canonicalization contract; hash algorithm + width; an algorithm version
stored alongside; and collision/version-migration policy.

## Affected P1 areas

`commands` DDL, idempotency flow, command contracts.
