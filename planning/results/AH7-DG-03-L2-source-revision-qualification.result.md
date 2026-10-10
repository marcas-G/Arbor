# AH7-DG-03 L2 source-revision qualification result

Status: **L2 qualification additions PASS; AH7-DG-03 remains open.**

Follow-up to `7b30b4d0a3e4851e48b94858d86de0fcec3332e3`, confined to the
independent `ah7-approval-atomicity` worktree. No production code or design
document changed in this follow-up; only tests were tightened.

## RED → GREEN

The file-backed two-connection source-revision barrier now parameterizes three
post-snapshot mutations:

- revoke an active PermissionGrant;
- advance `workspace_policy_revision` while changing workspace policy;
- bind the Execution to a Verification after the snapshot.

With the in-transaction source revision comparison disabled, both the policy
revision and verifier-binding cases were independently RED: stale snapshots
received `Admitted`. The grant-revocation case was independently RED in the
preceding follow-up. With the gate check enabled, all three return typed
`Denied(InvocationAuthorityDenied)` without changing `NotAdmitted`; the caller
then records `Denied(ApprovalNoLongerAuthorized)`, and the approval remains
consumed by the exact invocation.

The P12 acceptance story-12 fixture fake now implements the expanded P4 store
methods. The original business assertion remains: `list` completes through the
ToolRuntime pipeline and returns the expected file entries.

## Verification

- Targeted store barrier variants + P12 acceptance story 12: **2 files / 4
  tests PASS** (22 unrelated cases skipped by the test-name filter).
- `@arbor/ports`, `@arbor/persistence-sqlite`, `@arbor/tool-runtime`,
  `@arbor/agent-runtime`, and `@arbor/single-workspace` builds PASS.
- Targeted Biome and `git diff --check` PASS.

No full suite, P9 real-process/crash matrix, L3 AgentLoop qualification, push,
or merge was run.
