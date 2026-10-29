# Sandbox Policy Candidate Readmodel V6-E1 — Pending Action Fixture

Status: **E1 P3/P4 fixture foundation complete; V6-E remains open.**

## Implemented

- Added a disposable schema-50 fixture builder for an active WorkEpisode
  Execution with one durable current AgentLoopStep and one Pending executable
  `shell` Action at cursor 0.
- The circular Project/root-Workspace/Session/Work/Execution substrate is
  inserted only into a fresh test database. P3 AgentLoopStep and P4 invocation
  data are created through the production AgentLoopStepStore,
  ToolInvocationStore and P39RecoveryEvidenceStore.
- The fixture writes a canonical ProviderTurn success/link and ModelOutput
  source, then binds the exact Action identity to a verified RecoveryBinding
  and an attempt-0 NotAdmitted invocation.
- Production SandboxPolicyRequirementReadPort readback proves that the exact
  action is the active sandbox-policy requirement. Additional durable readback
  verifies one Pending Action, one NotAdmitted invocation, one RecoveryBinding,
  and the temporary setup lease. The temporary lease is removed after store
  setup so a daemon must perform its ordinary admission path.

## Verification

- `apps/single-workspace/test/sandbox-policy-pending-action-fixture.test.ts`:
  PASS, 1/1 against a fresh schema-50 disposable database.
- The helper's package imports now use the same built package modules as the
  SQLite adapters, and its execution/turn/lease identities and step state are
  typed with domain constructors/records; `pnpm typecheck` passes.
- Biome check on the fixture and test: PASS.
- `git diff --check`: PASS.

## Explicitly not claimed

This foundation does not yet seed a committed P1 policy or protected V2
source/high-water pair, exercise the P2 pre-dispatch gate in a process, or
qualify stale P1 rejection, reapproval crash boundaries, P10 refreshed
candidate digests, zero provider/dispatch counts, or daemon restart
convergence. Those remain required V6-E work.
