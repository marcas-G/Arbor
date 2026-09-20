# P1-DG-11 — Authority predicate undefined for P1 commands

## Status

OPEN — awaiting manual governance.

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
unactionable, while `planning/phases/P1.md` claims `Design Gaps: 0`.

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
