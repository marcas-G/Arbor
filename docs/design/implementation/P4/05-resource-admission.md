# P4 — 05 Resource Admission

**Authority:** DID v1.8 §1.5, G4; SD v1.3 §4.4/§6.5; P1/P2 resource contracts.
**Status:** DRAFT (first draft for contract review).

## 1. Boundary (G4)

Tool **Resource Admission is validate-only**: it checks
`ResourceOwnership ⊆ ResourceBoundary` for the resolved regions. It **never**
acquires or releases ownership claims. Ownership changes remain governance
Commands (application-owned `UpdateResourceBoundary`).

## 2. Canonical resource resolution

```text
ToolIntent resource arguments (ResourceAddress[])
        ↓ ProjectEnvironmentPort.resolve
CanonicalResourceRegion[]
```

- Uses the P1/P2 `ProjectEnvironmentPort` resolver; alias resolution happens
  there (DID §1.5).
- Resolution happens **before** admission and outside the execution sandbox.

## 3. Admission check

```ts
interface ResourceAdmissionService {
  readonly admit: (input: {
    readonly workspaceId: WorkspaceId;
    readonly regions: ReadonlyArray<CanonicalResourceRegion>;
  }) => Effect.Effect<AdmissionResult, ResourceAdmissionError, TransactionScope>;
}

type AdmissionResult =
  | { readonly _tag: "Admitted" }
  | { readonly _tag: "Denied"; readonly reason: string };
```

Rule:

```text
for each region:
  region ⊆ ResourceBoundary(workspace, current responsibility revision)
  AND region ⊆ active ResourceOwnershipClaim regions of the workspace
else -> Denied
```

- Uses the frozen `contains/overlaps` algebra (`domain/resources.ts`).
- Read-only tools still require the region to be inside the boundary; write
  tools additionally require an active ownership claim.
- No SQL string-prefix overlap approximation (P1 rule).

## 4. Transaction participation

- The admission read runs in a short `TransactionScope`; it does not open its
  own connection.
- Admission never mutates `resource_ownership`.

## 5. Must Not Decide

- No ownership claim/release (governance Command).
- No ResourceBoundary mutation.
- No environment change handling (P11).
