# MAC-P4 — Optional Subagent and Final Convergence Result

**Date:** 2026-10-04
**Status:** COMPLETE / FORMALLY CLOSED
**Disposition:** OPTIONAL SUBAGENT DISABLED BY ACCEPTED STOP CONDITION
**Phase:** `planning/phases/MAC-P4-optional-subagent-and-final-convergence.md`

## Outcome

Arbor v1 does not add a fifth product/domain concept and does not ship a
partially safe collaboration subsystem:

```text
Workspace / Work / Execution / LocalPlan
→ single Main Agent correctness
→ no active spawn_specialist or spawn_agent surface
→ historical Specialist evidence remains replay/audit-only
```

The phase contract explicitly allows disable/removal when parallelism has no
proven benefit greater than its complexity and cost. No positive evidence
exists for the proposed bounded context handoff, least-privilege inheritance,
resource-conflict arbitration, parent mailbox and restart-safe result delivery
as one coherent subsystem. Claiming that benefit or exposing only the old
spawn primitive would violate the accepted safety bar. The optional path is
therefore disabled, not simulated.

## Task disposition

| Task | Disposition | Evidence |
|---|---|---|
| MAC4-001 no new-write Specialist vocabulary | COMPLETE | production handler registration removed; new TurnProfiles never advertise legacy names |
| MAC4-002 bounded typed handoff | NOT ENTERED | capability disabled; no transcript fork or partial handoff contract shipped |
| MAC4-003 explicit child purpose/lifecycle | NOT ENTERED | capability disabled; verifier remains independently typed |
| MAC4-004 least-privilege subset | NOT ENTERED | capability disabled; no child can acquire a surface |
| MAC4-005 collaboration controls | NOT ENTERED | no spawn/list/message/follow-up/interrupt subagent controls advertised |
| MAC4-006 AgentResult/mailbox/wait | NOT ENTERED | no partial result-delivery path shipped |
| MAC4-007 concurrency/resource/recovery | NOT ENTERED | no concurrent subagent mutation admitted |
| MAC4-008 legacy isolation + shared approvals | COMPLETE | architecture suite + migration 0032 suite |
| MAC4-009 optionality/final qualification | COMPLETE | disabled-mode real DeepSeek B08 + full local gates |

`NOT ENTERED` is intentional absence under the accepted stop condition, not a
hidden implementation claim. Re-enabling subagents later requires a new
governed phase and the complete MAC4-002…007 safety matrix; the legacy
Specialist primitive is not a shortcut.

## ActionApproval physical convergence

Migration `0032_action_approval_convergence` now owns one physical ledger:

```text
action_approvals
  route_kind: Control | Executable
  subject_ref
  stable_action_id + action_version
  side_effect_semantics
  action_digest + target + ControlBasis
  Pending | Approved | Rejected | Consumed | Expired
  revision + expiry + single consumer
```

- current control writes bind the requesting Execution as subject;
- unprovable legacy pending/approved rows migrate fail-closed as `Expired`,
  retaining `source_state` for audit;
- the old `control_action_approvals` and `invocation_approvals` tables are
  removed after migration;
- current adapters read/write the unified ledger;
- executable approval consumption is an atomic state/revision transition and
  succeeds at most once;
- migration is re-entrant.

Primary proof:

```text
adapters/persistence-sqlite/test/mac-p4-action-approval-migration.test.ts
tests/architecture/mac-p4-convergence.test.ts
```

## Legacy isolation proof

- `composition.ts` and `production.ts` import no legacy directive handler;
- `makeSingleWorkspaceControlActionHandlers` registers no
  `SpawnSpecialist` handler;
- the runtime registry therefore excludes both `spawn_specialist` and its
  historical alias from new model turns;
- explicit legacy codecs/fixtures remain available only for historical replay
  and audit;
- `LegacyAmbiguousEpisode` remains fail-closed in the Agent driver.

## Verification

```text
Biome              888 files PASS
TypeScript         PASS
Architecture       29 files / 152 tests PASS
Core               306 files / 1669 passed / 3 skipped
Web typecheck      PASS
Web build          PASS; existing >500KB warning only
Web                 31 files / 216 tests PASS
SQLite baseline    user_version 32
```

Real-provider final evidence:

```text
planning/testing/core-capability/reports/capability-real-provider-2026-10-03T20-10-35.190Z-ae5483d4-4952-4a31-9f4e-62b13935c5fc.md
```

B08 L1/L2/L3 are PASS. The stability oracle executed the real DeepSeek case
three times. Across the runs, `spawn_specialist` was absent from advertised
tools, no ExecutionBound child or Workspace was created, and the Main Agent
continued with ordinary plan/wait behavior. Read-only `list/read` observations
are allowed; mutating executable actions are rejected by the oracle.

## Closure

Blocking = 0. Optional parallelism performance is not claimed. Core
correctness, legacy isolation and approval convergence are complete.
