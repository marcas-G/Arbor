# P38 Executable Approval Runtime Integration Checkpoint

Date: 2026-10-11
Status: **Runtime closure implementation checkpoint committed; qualification open**

## Baseline and scope

- Managed worktree: `C:\Users\ThinkPad\.codex\worktrees\p38-executable-approval-runtime\Arbor`
- Branch: `codex/p38-executable-approval-runtime`
- Base: P37 L2+L3 stable checkpoint
  `80f10551cb11825cd207131fcd9f0ab665c38a62`, whose parent chain includes
  P36 `ba0e295` and the registered migration 0037.
- Implementation: `a92da79e83ade09c01c719c206138b302ff651bf`
  (`feat(p38): wire executable approval runtime loop`).
- No `docs/design/**` files were modified. No migration was applied to a
  preserved database; migration 0038 is registered only as the cumulative
  P38 prefix following P37/0037.

## Implemented path

- P4 returns typed nonterminal `ApprovalRequired` after resource resolution
  and current authority resolution, with no ToolInvocation intent,
  settlement, `Denied(ApprovalRequired)`, Resource Admission, or executable
  effect on that first request.
- Agent Runtime passes the exact durable P3 Step/action identity and current
  Worker fence to the Executable handler. Application binds those fields to
  the Runtime-derived ToolInvocationId, obtains the first candidate through
  the P12 resolver, and atomically persists the proven ActionApproval,
  revision-0 `eap:` Inbox entry, request event, and wake source. Existing
  logical-action rows are looked up before the lazy candidate resolver, so
  replay retains the first ApprovalId and TTL.
- The same AgentLoopStep remains `ActionsInProgress` with the action Pending.
  The active Execution releases its lease on the existing ApprovalRequired
  path. After human Approve, the same provider/action identity re-enters P4;
  the exact Approved revision is matched and consumed with ToolInvocation
  intent under one fenced transaction. Reject produces a no-effect terminal
  denial for the same action; an already-Expired row also denies, while the
  automatic expiry producer is not implemented in this checkpoint. Cancelled
  produces interruption.
- Added the separate external `ResolveExecutableApproval` P1/P12 route.
  It is human-authorized, revision-bound, and excludes Control/CAPA approval
  rows. Decision CAS, exact Inbox consumption and `ExecutableApprovalResolved`
  are committed in the Gateway transaction; the daemon's durable resolution
  event/active-execution poll wakes the same Execution.
- Added `ExecutableApprovalConsumptionReceipt` to the P38 store operation:
  exact pre-consume and consumed revisions, immutable binding, expiry,
  `consumedBy`, and an approval snapshot digest. This satisfies the already
  accepted P4/P39 RecoveryBinding source contract without changing design.
  P39 still needs to persist this receipt into its claim/attempt RecoveryBinding
  in the same transaction.
- Production migration prefix advances to `P38_MIGRATIONS = P37_MIGRATIONS +
  0038`; existing P36/P37 migration slots and Stop/CloseProject cancellation
  composition remain intact.

## Static verification

- `pnpm typecheck`: PASS (production TypeScript and test-source compilation).
- Targeted `pnpm exec biome check` on the 26 changed source/test files: PASS.
- `git diff --check`: PASS.
- Vitest, functional daemon journeys, browser tests, migrations, two-daemon
  process tests, and full repository gates were not run in this checkpoint.

## Open qualification and dependencies

- P38 is **not closed**. The following evidence remains required:
  - real P37→P38 migration execution and legacy ActionApproval/FK fixture
    verification;
  - public-process/browser qualification for Inbox decision, same-Step
    Approve resume, Reject terminalization, and no effect before decision;
  - automatic TTL expiration that transitions the exact pending approval,
    consumes its Inbox entry, journals the resolution fact, and wakes the same
    Execution;
  - two-daemon kill/restart coverage around request admission, decision, P4
    claim/consume, and same-Step resume, including unique single consumption;
  - P39 integration of the typed consumption receipt into durable
    RecoveryBinding and reconciliation gates;
  - the coordinated functional and release qualification batch.
- Implementation commit parent is the frozen P37 combined checkpoint above;
  later P38/P39 work must branch or cherry-pick from the exact commits and
  preserve migration order 0036→0037→0038.
