# AH7-DG-02 — Reconciliation qualification matrix (proposal only)

State: **planning proposal; implementation not authorized**. Baseline:
`db929654128b8e864d3733b95088f4edda0e4c43`.

The existing real-process reproduction is
`tests/functional/process/agent-action-ah7-reconcilable.functional.test.ts`:
it commits a P4 intent, performs a real append, kills the daemon before
settlement, then observes one marker and fail-closed `OutcomeUnknown` /
`ReconciliationPending` after restart. It is valid evidence for “do not blindly
replay,” but **not** evidence that external reality was reconciled. Do not run
it as part of proposal drafting. No test in this matrix has been run here.

## Evidence-state / crash matrix

| Case | Durable pre-crash state | Required external evidence | Recovery action | Required durable convergence |
|---|---|---|---|---|
| Generic shell v3, no profile | P4 `MayHaveStarted`; effect may have occurred | None available by contract | Never re-execute; `StillUnknown(ProfileUnavailable)` | P9 Attention/fact, OutcomeUnknown gate; one typed ToolResult/Action source if projected; no second marker |
| Historical shell v2, no persisted profile/effect key | Stored `Reconcilable`, profile absent | No valid retrospective proof | Never reinterpret under new catalog; `StillUnknown(LegacyProfileUnavailable)` | Original ToolInvocation stays auditable; P9 Attention; no executor |
| Registered profile, crash after admission but before executor | attempt N `MayHaveStarted` | Exact final `NotOccurred` proof; old attempt externally fenced/quiescent | Revalidate exact binding; at most one attempt N+1 if authority/resource/approval unchanged and not stopping | Same invocation/callRef/ProviderTurn; one effect key; append-only proof fact |
| Registered profile, effect occurred before P4 settlement | attempt N `MayHaveStarted` | Exact terminal `Occurred` proof plus reconstructable settlement/observation/result ref | Do not execute again; settle from proof | P4 settlement + fact; one P3 ToolResult with observationRef equal Action/Session source |
| Positive effect proof, result/output cannot be reconstructed | attempt N `MayHaveStarted` | Occurred is known, canonical outcome is not | `StillUnknown(ResultEvidenceUnavailable)` | Attention/OutcomeUnknown; no fake Success, no result fabrication, no replay |
| Lookup timeout, eventually-consistent negative, stale watermark, mismatched effect key/profile | attempt N `MayHaveStarted` | Proof is incomplete or unbound | `StillUnknown` with the exact closed reason code | No executor; P9 fact; retain unresolved-side-effect gate |
| Authoritative NotOccurred, but permission/grant/policy/approval snapshot changed | attempt N `MayHaveStarted` | Bound NotOccurred proof; current replay gate fails | No retry; terminal `ReconciledNoEffect` with closed suppression reason | Preserve consumed approval binding; no executor; typed ToolResult/action disposition |
| Authoritative NotOccurred, ResourceBoundary / region / environment revision changed | attempt N `MayHaveStarted` | Bound NotOccurred proof; current target no longer exact | No retry; `ReconciledNoEffect(ResourceSnapshotChanged)` | No widened target; no executor |
| StopExecution after MayHaveStarted; reconcile proves NotOccurred | attempt N `MayHaveStarted`, stop requested | Bound terminal NotOccurred proof | No replay during quiescence; `ReconciledNoEffect(StopRequested)` → existing Interrupted projection | No effect, one cursor convergence, no new executor |
| Attempt 1 also proves NotOccurred | two attempts, same invocation/effectKey | Finality proof for attempt 1 | Stop automatic retries at v1 limit; `ReconciledNoEffect(ReplayLimitReached)` | No retry loop; next human/model decision uses a new logical invocation |
| Old daemon can still complete external I/O after negative query | attempt N unresolved | No cancellation/fence/finality proof | `StillUnknown(AttemptNotFinal)` | New daemon must not replay even if current query says “absent” |
| P4 settlement committed, P3 ToolResult/action/cursor missing | terminal P4 result + fact | No new external lookup required | Rebuild P3 projection only | Same resultRef/fact; unique ToolResult observationRef == Action source == Session source |
| P3 ToolResult/Action/cursor COMMIT before/after crash | P4 result/fact already durable | Existing canonical result only | Before commit rolls back all P3 facts; after commit idempotently replays | Same Action/cursor, exactly one ToolResult and one observation source |

The same checks are parameterized by replay-time `PermissionGrant` revision,
subject/capability/target, workspace/project policy revision, approval
expiry/revocation/consumer, resource-boundary revision, region/address,
profile hash and Worker lease generation. Any mismatch blocks replay; it is not
resolved by treating a similar current grant/profile as equivalent.

## Ordered qualification waves after separate governance acceptance

1. **Deterministic RED / contract unit.** Reuse the current crash reproduction as
   the fail-closed baseline. Add memory-only profile fixtures for all three
   statuses, proof expiry/source mismatch, missing result evidence, permission
   revoke, resource revision change, stop and one-retry cap. Assert stale or
   incomplete negative evidence becomes `StillUnknown`; no real daemon.
2. **P4 schema/store.** Implement migration for immutable RecoveryBinding,
   per-attempt admission and append-only reconciliation facts. Use SQLite
   deterministic transaction tests for attempt CAS, exact profile/effectKey,
   fact+settlement atomicity, crash before/after COMMIT, stale-fence rejection,
   consumed approval reuse and legacy shell-v2 fail-closed. No external provider.
3. **Profile adapter module.** Use a dedicated test tool backed by a controllable
   durable fake external source with a finality watermark and idempotency key.
   Verify NotOccurred/Occurred/StillUnknown and reconstructable versus missing
   result evidence. The generic `shell` Executor is not used as a reconciliation
   test adapter.
4. **Real daemon single-worker.** Only after the module gates pass, kill at
   admission→effect, effect→reconcile, reconcile→P4 settlement, and P4
   settlement→P3 Observation. Same Execution/ProviderTurn/LogicalAction/callRef/
   ToolInvocation/profile/effectKey across restart; unique fact, effect,
   settlement, ToolResult, Action and cursor.
5. **Real two-daemon race.** Hold old generation inside a profile-owned external
   request, expire lease and start generation+1. Prove the profile's cancel/
   fence/finality semantics prevent an old late effect before accepting
   NotOccurred; stale writes/facts fail the full lease tuple. Then test
   authority/approval/resource changes before retry. No sleep-based race.
6. **Public shell classification / regression.** `shell@3` arbitrary command
   tests NonIdempotent OutcomeUnknown after effect; `shell@2` active legacy rows
   without profile do not replay; `read@2` remains ReadOnly and `patch@2`
   remains Idempotent. Only a separately registered constrained profile may
   exercise Reconcilable.
7. **P3/P9 integration.** Assert OutcomeUnknown/Attention versus terminal
   ReconciledNoEffect projection, exact source mapping, no duplicate status or
   approval consumption, restart/replay before/after every transaction. Run full
   suite only at its authorized final gate, never as this proposal-only task.

### Stop conditions

- No immutable profile/effect identity or no authoritative external source → do
  not classify that tool as Reconcilable.
- External I/O can complete after the adapter says NotOccurred and cannot be
  fenced/cancelled/idempotently deduplicated → StillUnknown; no replay.
- Positive effect cannot reconstruct canonical result → StillUnknown; no fake
  settlement.
- Permission/resource/approval binding changes → no automatic replay.
- A design requires another P4/P3/P9 semantic not fixed in the accepted package
  → stop implementation and raise a new owner-specific Design Gap.
