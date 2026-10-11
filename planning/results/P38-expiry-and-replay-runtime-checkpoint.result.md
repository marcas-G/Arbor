# P38 Expiry and Replay Runtime Checkpoint

Date: 2026-10-11
Status: **Static implementation checkpoint committed; runtime qualification open**

## Identity and baseline

- Managed worktree: `C:\Users\ThinkPad\.codex\worktrees\p38-executable-approval-runtime\Arbor`
- Branch: `codex/p38-executable-approval-runtime`
- Base: P37 L2+L3 stable checkpoint
  `80f10551cb11825cd207131fcd9f0ab665c38a62`, containing P36 `ba0e295` and
  the registered 0037 migration.
- P38 runtime integration: `a92da79e83ade09c01c719c206138b302ff651bf`.
- Expiry/replay and typed denial corrections:
  `88e3cb30151d59851a1685b1c6e01f703d2cd468`.
- No `docs/design/**` files were modified. Migration 0038 remains cumulative
  after 0037.

## Implemented contract paths

- `ExecutableApprovalStore.expireDue` scans a bounded batch of due
  `Pending|Approved` rows. Each transition is a CAS on approval ID, exact
  revision, current state, `expires_at <= now`, and unconsumed binding. It
  commits `Expired`, consumes the original unconsumed revision-0 `eap:` Inbox
  row for Pending requests, appends `ExecutableApprovalResolved(TTLExpired)`
  and its same-Execution wake fact atomically. Approved rows retain their
  already-consumed Inbox history and still append the Expired resolution.
- P1 human Approve/Reject uses the injected runtime Clock. Its store CAS
  applies the same TTL rule: an exact Pending request whose expiry is reached
  commits `Expired`; otherwise it commits Approved/Rejected. Stop cancellation
  and expiry compete on the same revision/state CAS; if another terminal
  resolution already won, Stop keeps its stop transaction and does not emit a
  duplicate resolution.
- Production startup expires due rows before `startupRecovery`; every recovery
  sweep scans the next bounded batch. The one-workspace `runOnce` helper also
  scans after migrations and before recovery. The P2 scheduler therefore sees
  expired Pending rows as terminal and replays the same active Execution/Step,
  where P4 returns `ApprovalExpired` without invoking the Executor.
- P12 decision authority binds the supplied `expectedRevision`, authenticated
  human or directly authorized parent, exact approval/project/workspace, and
  active matching Execution. P1/Gateway retains exact-revision conflict
  behavior.
- The internal `ToolIntent.approvalId` is populated from the Runtime's exact
  ActionApproval row on re-entry, never from model output. P4 requires it to
  match the P4 context's Runtime approval ID. The P4 same-intent replay check
  therefore retains identity after a crash following intent/approval commit
  and before effect admission.
- P4 uses the accepted typed `ApprovalRejected` no-effect denial for Reject
  and `ApprovalExpired` for expiry. Rejected/Expired actions terminalize the
  same pending P3 action; Stop cancellation remains Interrupted.
- Added unrun test source for Pending expiry CAS + exact Inbox/wake + replay,
  human decision racing after TTL, already-Approved expiry, and the P4
  claim-committed/effect-not-admitted same-ToolInvocation replay window.

## Static verification and limits

- `pnpm typecheck`: PASS (production TypeScript and test-source compilation).
- Targeted Biome on 22 changed implementation/test files: PASS.
- `git diff --check`: PASS.
- No Vitest, daemon, migration execution, browser journey, full gate, or
  two-daemon process qualification was run.
- P38 remains open pending centralized tests, real 0036→0037→0038 migration
  and FK fixture qualification, public Approve/Reject/TTL journeys, expiry vs
  Stop and human-decision process-crash races, and same-Step double-daemon
  takeover qualification.
- P39 must persist the exported `ExecutableApprovalConsumptionReceipt`
  (`preConsumeRevision`, `consumedRevision`, binding digest, expiry, and
  `consumedBy`) into RecoveryBinding in the same claim/consume transaction.
- `planning/results/P38-executable-approval-runtime-integration-checkpoint.result.md`
  is the earlier implementation-only checkpoint; this record supersedes its
  noted TTL-producer and `ApprovalRejected` gaps.
