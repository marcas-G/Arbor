# P1-DG-10 — Port ownership, ID generation, AssignWork errors, child-workspace phase

## Status

RESOLVED — DID v1.5.

## Resolution

DID Appendix B is aligned to §7.2: `TransactionPort`, `CommandStore`,
`DomainEventJournal` are Persistence ports; `CommandGateway` is an
Application service that uses them. The remaining sub-items (ID-generation
ownership, `AssignWork` rejection set, `CreateChildWorkspace` P1-vs-P6
ownership) are P1 phase-scoped closures.

Authority: DID v1.5 §7.2, Appendix B.


## Owning design document

`docs/design/03-detailed-implementation-design.md` §7.2, Appendix B, §0A.1,
§10.4.1, §11, §12.10.

## Symptom

Four smaller P1-facing ambiguities:

1. **Port vs Application classification.** `TransactionPort`,
   `CommandStore`, `DomainEventJournal` are listed as Persistence **ports**
   (§7.2:1830-1833) and also as Application Effect services
   (Appendix B:3986-3990). §10.4.1 fixes package edges, so this determines
   package placement and architecture tests.
2. **ID generation ownership.** `IdGenerator` is a port (§7.2:1853), but
   §0A.1:167-172 omits it from `AssignWork`'s `R`, and P0 carries explicit
   IDs. Which IDs are payload-supplied vs handler-generated (and its effect
   on the fingerprint) is unstated.
3. **`AssignWork` rejection set.** §0A.1:158-173 lists
   `WorkspaceNotFound | ProjectClosed | AuthorityDenied |
   ResponsibilityViolation | RevisionConflict`; P0 has none of
   `WorkspaceNotFound`, `ProjectClosed`, `ResponsibilityViolation`.
4. **`CreateChildWorkspace` phase ownership.** §11:3175 puts "Workspace
   commands" in P1; §11:3224 puts `CreateChildWorkspace` in P6. Whether P1
   builds it (and whether it atomically creates a `WorkspacePrimary`
   Session, since `Workspace.primarySessionId` is non-nullable) is unclear.

## Evidence

```text
DID §7.2:1830   TransactionPort / CommandStore / DomainEventJournal (Persistence)
DID Appendix B  same three under Application (Effect services)
DID §10.4.1     allowed package edges
DID §7.2:1853   IdGenerator port
DID §0A.1:158   AssignWork signature + rejection set
DID §11:3175    P1 CreateProject/Workspace/Work commands
DID §11:3224    P6 CreateChildWorkspace
DID §3.2:841    Workspace.primarySessionId non-nullable
```

## Why planning cannot decide this

Package ownership, ID-generation authority, the canonical command rejection
set, and phase ownership are **architecture/scope semantics**.

## Required resolution

Freeze: owning package for the three services; ID generation ownership;
the `AssignWork` rejection set; and P1-vs-P6 ownership of
`CreateChildWorkspace` (+ child Primary Session atomicity).

## Affected P1 areas

Port contracts, command contracts, package layout, planning scope.
