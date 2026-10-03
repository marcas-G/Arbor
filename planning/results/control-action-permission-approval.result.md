# Control Action Permission & Approval Result

**Date:** 2026-10-03
**Governance:** `ACCEPT_CONTROL_ACTION_PERMISSION_APPROVAL_ARCHITECTURE`
**Accepted proposal SHA-256:** `74C0A20BCED0C7800B2EB21933967810AAB73423132D9FE06E86A7E56EA26FB9`
**Status:** COMPLETE

## Implemented

- PermissionGrant v2: explicit HumanPrincipal / WorkspaceAgent / Execution
  subject, stable capability, target, validFrom/expiresAt and revision.
- migration 0029 revokes legacy unbound grants and adds subject indexes.
- ControlActionAuthorizer centralizes intrinsic policy, standing grants,
  Deny/Ask/AllowWithinGrant and exact action/ControlBasis digests.
- migration 0030 + ControlApprovalStore persist Pending/Approved/Rejected/
  Consumed/Expired exact approvals with CAS decision and consumption.
- ApprovalRequired happens before handler invocation. Execution stays Active,
  lease releases, AgentLoopStep action remains Pending.
- ResolveControlApproval is human-actionable and consumes the exact Queue row.
- daemon resumes Approved, Rejected and Expired decisions on the same
  Execution; settled Provider output is replayed instead of sampled again.
- approval is consumed after successful canonical handler execution; command
  idempotency closes the crash window.
- Queue UI renders exact control approvals and Approve/Reject actions.
- Governance Inbox entries remain outside Agent Session promotion.

## Mechanical evidence

- wrong subject/target, expiry, revoke and legacy-unbound denial tests;
- migration 0029 legacy revocation and bound-grant round trip;
- migration 0030 approve/consume, concurrent-decision CAS and expiry tests;
- AssignWork full flow: no Work before approval, same Execution resumes,
  exactly one Work created, approval Consumed;
- rejection flow: no Work created, typed ControlResult returned;
- architecture tests pin ordering before handler and same-Execution resume.

## Remaining product gap

PermissionGrant inventory/revocation UI remains the existing deferred G2
product surface. New grants can be subject-bound through Settings; runtime
authorization and approvals do not depend on browser inventory.

## Final verification

```text
pnpm lint          PASS — 868 files
pnpm typecheck     PASS
pnpm architecture  PASS — 27 files / 147 tests
pnpm test          PASS — 293 files / 1650 passed / 1 skipped
web typecheck      PASS
web build          PASS (existing >500 kB chunk warning only)
web test           PASS — 31 files / 216 tests
```

Real service closure:

```text
database user_version = 30
legacy unbound grants = 2, both Revoked
control_action_approvals table = present
PRAGMA foreign_key_check = []
service = running on 127.0.0.1:8787
```

Before migration the database was copied to
`C:/Arbor/arbor-slice.pre-capa29.backup.db`. Browser verification confirmed
the Settings form exposes explicit subject kind/ref, capability, target and
expiry. Automated Queue tests cover exact approval rendering/submission; the
same-Execution Approve and Reject paths are covered by the production
composition integration suite.
