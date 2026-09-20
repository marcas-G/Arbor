# P1-DG-11 — Authority predicate undefined for P1 commands

## Status

**RESOLVED** — manual governance, "authority as a trusted Application input
fact". Resolved by updating the P1 phase contracts only; DID v1.6 / System
Design are unchanged.

## Resolution

P1 does not resolve authority (no `PermissionGrant` lookup, RBAC/ABAC/ACL,
principal hierarchy, admin/root flag, no default-allow, no
`AuthorityRepository`, no Authority Resolver). The Application boundary
receives a pre-verified fact and performs deterministic exact-match validation:

- `docs/design/implementation/P1/01-command-contracts.md` §2A — defines
  Application-owned `VerifiedCommandAuthority` (tagged union binding
  `principal`, `commandId`, `semanticRequestFingerprint`, `projectId`, and the
  governance target) and the exact-match rule for `CreateProject`,
  `CreateChildWorkspace`, `AssignWork`; states that authority is not part of
  `semanticRequestFingerprint` and that a durable terminal `AuthorityDenied`
  requires a new `commandId`.
- `docs/design/implementation/P1/01-command-contracts.md` §3 — pipeline is
  `execute(envelope, submissionContext, verifiedCommandAuthority)` with
  authority exact-match after the idempotency replay check.
- `docs/design/implementation/P1/01-command-contracts.md` §9 — Must Not Decide
  list for authority.
- `docs/design/implementation/P1/02-port-contracts.md` §4A — the fact is an
  Application boundary input, not a port/repository.
- `docs/design/implementation/P1/03-transaction-model.md` §3.1 — existing
  authoritative resolution replays **before** any authority validation.
- `docs/design/implementation/P1/00-contract-index.md` — DG-11 marked RESOLVED.

A later phase owns the Authority Resolver
(`Canonical facts + PermissionGrant + Parent/User governance + authenticated
Principal → Authority Resolver → VerifiedCommandAuthority`); P1 handlers need
no change when it arrives.

Implementation: `packages/application` (`authority.ts`, `gateway.ts`) patched
under P1-009; unblocks P1-010/011/012 → P1-014 → P1-016.

## Owning design document

`docs/design/03-detailed-implementation-design.md` §8 (Authority model),
§6.2 (L2 enforcement), §12.10 (C9 capability ownership), §4.1
(`CommandSubmissionContext`); P1 contracts `01-command-contracts.md`,
`02-port-contracts.md`.

## Symptom

The P1 contracts freeze the **rejections** (`DomainError.AuthorityDenied` with
reasons such as "work outside responsibility scope") but no rule or function
that decides authority from `CommandSubmissionContext` / principal. There is
no permission store in P1 (`02-port-contracts.md` §4 has no
`PermissionGrantRepository`), and P0 `packages/domain/src/authority.ts` has no
`authorize()` predicate. The domain transitions take authority as a
pre-computed boolean (`work.ts`, `workspace.ts`) or omit it (`project.ts`).

P1-010/011/012 acceptance ("missing authority rejected") is therefore
unactionable. `planning/phases/P1.md` now records this gap (`Design Gaps:
1 OPEN`).

## Evidence

```text
P1 01 §5-§7   rejections AuthorityDenied (reasons) but no authority rule
P1 02 §4      no PermissionGrantRepository / authority service
P0 authority.ts  no authorize(); domain takes authorized: boolean
DID §8.1-§8.5    authority model / capability ceiling (not yet phased)
DID §6.2      Parent/Sibling authority, Tool authority chain (L2)
```

## Why planning cannot decide this

Who is allowed to issue `CreateProject` / `CreateChildWorkspace` /
`AssignWork` (bootstrap principal? governance capability? parent authority?)
is **authority / permission semantics**.

## Required resolution

Freeze either:

1. a minimal P1 authority rule (e.g. `CommandSubmissionContext.External`
   principal carrying a governance/bootstrap capability, evaluated by a pure
   predicate with explicit inputs), plus the owning package; or
2. an explicit statement that P1 authority is supplied as an application-layer
   input fact (with a defined source) and `PermissionGrant` evaluation is a
   later phase — and adjust the P1 acceptance accordingly.

## Affected planning tasks

- P1-010, P1-011, P1-012 (command handlers).
