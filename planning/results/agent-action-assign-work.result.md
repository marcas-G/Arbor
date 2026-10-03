# Agent Action AssignWork Result

**Date:** 2026-10-03
**Authority:** DID v1.18/v1.19 Agent Control implementation authorization +
DID v1.26 VDC-5 field-source closure
**Status:** INTERNAL PATH COMPLETE / WORK-PROFILE EXPOSURE VIA CAPA APPROVAL

## Outcome

The frozen ACTIVE `AssignWork` action is now present in the provider-neutral
control path.

- model supplies objective, why, constraints, completion expectation, a valid
  VerificationMission, and the human-readable provenance reason;
- Runtime generates Work/Command identities, binds Work revision 0, reads the
  exact target Workspace revision, and binds predecessorWorkId from the
  current parent Work execution;
- target omission means the current Workspace; an explicit target is accepted
  only when it is the current Workspace or an active direct child in the same
  Project;
- the effect crosses the canonical P1 `AssignWork` CommandGateway boundary;
- successful assignment returns a bounded Observation and the normal
  WorkAssigned consumer/scheduler path remains authoritative;
- `assign_work` is visible only in WorkspaceWork and is intercepted by the
  CAPA authority/approval plane before its handler; RootConversation remains
  blocked by `RGI-DG-01`.

## Evidence

- codec tests reject malformed VerificationMission and prove Runtime facts are
  absent from model input;
- Wave 2 integration persists a second Work with exact predecessor provenance
  and VerificationMission;
- TurnProfile tests prove disjoint Root/Work/Inbox/Decision/Specialist/Verifier
  surfaces;
- architecture tests pin the command/authority/provenance boundary.

## Remaining exposure boundary

This implementation does not silently expand any model tool surface. Audit
found that Control Action handlers can synthesize authority directly and the
current PermissionGrant shape has no grantee identity. `CAPA-DG-01` therefore
blocks WorkspaceWork and RootConversation exposure until permission,
approval-interruption and same-Episode resume are closed.

## Final verification

```text
pnpm lint          PASS — 858 files
pnpm typecheck     PASS
pnpm architecture  PASS — 26 files / 144 tests
pnpm test          PASS — 289 files / 1640 passed / 1 skipped
web typecheck      PASS
web build          PASS (existing >500 kB chunk warning only)
web test           PASS — 31 files / 214 tests
```
