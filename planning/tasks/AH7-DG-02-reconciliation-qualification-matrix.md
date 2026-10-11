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
| Historical shell v2, `MayHaveStarted` / `LegacyUnknown`, no persisted profile/effect key | Stored `Reconcilable`, profile absent | No valid retrospective proof | Never reinterpret under new catalog; canonical `StillUnknown(ProfileUnavailable)` with physical provenance `LegacyProfileUnavailable` | Original ToolInvocation stays auditable; P9 Attention; no executor |
| Historical shell v2, exact `NotAdmitted` definition/binding still available | Intent exists, effect admission absent | P4 marker proves no executor was admitted | Re-enter only exact shell@2 under current fresh authority/resource/approval/lease/stop gate | Keep exact v2 definition until these rows terminate; never substitute v3 or reclassify |
| Registered profile, crash after admission but before executor | attempt N `MayHaveStarted` | Exact final `NotOccurred` proof; old attempt externally fenced/quiescent | Revalidate exact binding; at most one attempt N+1 if authority/resource/approval unchanged and not stopping | Same invocation/callRef/ProviderTurn; one effect key; append-only proof fact |
| Registered profile, effect occurred before P4 settlement | attempt N `MayHaveStarted` | Exact terminal `Occurred` proof plus reconstructable settlement/observation/result ref | Do not execute again; settle from proof | P4 settlement + fact; one P3 ToolResult with observationRef equal Action/Session source |
| Positive effect proof, result/output cannot be reconstructed | attempt N `MayHaveStarted` | Occurred is known, canonical outcome is not | `StillUnknown(ResultEvidenceUnavailable)` | Attention/OutcomeUnknown; no fake Success, no result fabrication, no replay |
| Lookup timeout, eventually-consistent negative, stale watermark, mismatched effect key/profile | attempt N `MayHaveStarted` | Proof is incomplete or unbound | `StillUnknown` with the exact closed reason code | No executor; P9 fact; retain unresolved-side-effect gate |
| Authoritative NotOccurred, but permission/grant/policy/approval snapshot changed | attempt N `MayHaveStarted` | Bound NotOccurred proof; current replay gate fails | No retry; terminal `ReconciledNoEffect` with closed suppression reason | Preserve consumed approval binding; no executor; typed ToolResult/action disposition |
| Authoritative NotOccurred, ResourceBoundary / region / environment revision changed | attempt N `MayHaveStarted` | Bound NotOccurred proof; current target no longer exact | No retry; `ReconciledNoEffect(ResourceSnapshotChanged)` | No widened target; no executor |
| StopExecution after MayHaveStarted; reconcile proves NotOccurred | attempt N `MayHaveStarted`, stop requested | Bound terminal NotOccurred proof | No replay during quiescence; `ReconciledNoEffect(StopRequested)` → existing Interrupted projection | No effect, one cursor convergence, no new executor |
| StopExecution after MayHaveStarted; reconcile proves Occurred | attempt N in flight, stop requested | Bound terminal Occurred + reconstructable canonical result | Record P4 settlement/fact under current fence; no new attempt; P3 records known ToolResult then existing stop/quiescence settles remaining execution | Known effect is never dropped or relabeled Unknown merely because stop was requested |
| StopExecution after MayHaveStarted; StillUnknown | attempt N unresolved, stop requested | Inconclusive/absent source | No new attempt; commit StillUnknown fact/Attention under current fence; remain ReconciliationPending/OutcomeUnknown, never plain Interrupted | No new external effect; unresolved-side-effect gate remains |
| Attempt 1 also proves NotOccurred | two attempts, same invocation/effectKey | Finality proof for attempt 1 | Stop automatic retries at v1 limit; `ReconciledNoEffect(ReplayLimitReached)` | No retry loop; next human/model decision uses a new logical invocation |
| Old daemon can still complete external I/O after negative query | attempt N unresolved | No cancellation/fence/finality proof | `StillUnknown(AttemptNotFinal)` | New daemon must not replay even if current query says “absent” |
| P4 settlement committed, P3 ToolResult/action/cursor missing | terminal P4 result + fact | No new external lookup required | Rebuild P3 projection only | Same resultRef/fact; unique ToolResult observationRef == Action source == Session source |
| P3 ToolResult/Action/cursor COMMIT before/after crash | P4 result/fact already durable | Existing canonical result only | Before commit rolls back all P3 facts; after commit idempotently replays | Same Action/cursor, exactly one ToolResult and one observation source |

The same checks are parameterized by replay-time `PermissionGrant` revision,
subject/capability/target, workspace/project policy revision, approval
expiry/revocation/consumer, resource-boundary revision, region/address,
profile hash and Worker lease generation. Any mismatch blocks replay; it is not
resolved by treating a similar current grant/profile as equivalent.

The logical exact-shell@2 re-entry row above applies only when a complete
Runtime-owned binding is already available and verified. The P39 physical
supplement adds a pre-upgrade refusal for active P36 NotAdmitted rows, whose
P36 schema persisted no such binding; that legacy migration gate is not
permission to reconstruct or graft one.

## Runtime identity and approval binding owner matrix

| Value | Trusted producer / owner | Interface hop | P4 durable use |
|---|---|---|---|
| ProviderTurnId | P3 pinned `PreparedModelTurn.manifest` | `AgentLoopActions` → P3 `ExecutableInvocationInput.sourceBinding` → Application `ExecutableToolHandler` → P4 `ToolIntent.sourceBinding` | Immutable RecoveryBinding and reconciliation fact; never model reconstructed |
| Step identity | P3 durable `AgentLoopStepRecord.identity` (`executionId`, `logicalStepNo`, `repairAttempt`) | Same sourceBinding | Cross-check binding digest; P3 remains owner of cursor |
| LogicalActionId/actionIndex | P3 durable `AgentLoopStepActionRecord` | Same sourceBinding | Exact fact/action correlation; P4 may not manufacture another ActionId |
| callRef/ExecutionId | Pinned P3 decoded ToolInvocation + current ExecutionOrigin | Existing ToolIntent plus sourceBinding; invocation ID uses existing `(executionId,callRef)` allocator | P4 verifies stable re-entry and persists binding at claim |
| Worker lease triple | P1/P2 `ExecutionOrigin` of current worker | Existing `ToolExecutionContext` only | Current full fence on attempts, facts, settlement and Attention handoff; no stop-null requirement for accounting after Stop |
| Approval subject/revision | P4 trusted InvocationApproval record + authenticated principal/current ControlBasis | P4-owned `MatchedInvocationApproval` from exact P4 match; never model/P3-authored | Claim transaction re-reads exact expected revision, subject, tool/action/args/target/basis/expiry/state then consumes by same ToolInvocationId; stores pre/post revisions and binding hash |
| Authority/resource versions | P4 trusted InvocationAuthority resolver + ResourceAdmission/ProjectEnvironment | P4 ToolRuntime, not ToolIntent args | Binding holds sourceRevision, grant ids+revisions, policy/boundary/environment revisions, canonical resource snapshot; retry requires exact current match |

Required migration owner is P4 `tool_invocations`/effect-attempt/fact schema; P3's
identity tables and ownership do not move. Legacy rows without source binding are
not backfilled from Session text. A losing approval CAS rolls back the claim; a
same-invocation recovery verifies the original consumed-by/revision binding and
never consumes again.

## ReconciledNoEffect P4→P3 projection

This variant is distinct from P4 `Denied`, which remains valid only for
`NotAdmitted`. P4 `CanonicalToolObservation` and `ToolInvocationSettlement` both
carry `ReconciledNoEffect{reasonCode,reconciliationFactRef}` with the closed
codes below. The P3 Executable handler passes that exact union to
AgentLoopActions; it may not synthesize a generic `Denied` result at P4:

| P4 reasonCode | P3 ToolResult status / disposition | AgentLoop action/cursor | Execution |
|---|---|---|---|
| `AuthoritySnapshotChanged`, `ResourceSnapshotChanged`, `ApprovalNoLongerAuthorized` | `Denied` / `ReconciledNoEffect:<reasonCode>` | `TerminalRejected`; advance once; same Observation source | Continue normally; no P4 Denied rewrite |
| `StopRequested` | `Interrupted` / `ExecutionStopping` | current `TerminalRejected`, rest `SkippedEarlySettlement`, advance once | `SettlementProposed(Interrupted(StopRequested))` |
| `ReplayLimitReached` | `Failed` / `ReconciledNoEffect:ReplayLimitReached` | `Applied`; advance once with truthful “effect not performed; automatic retry limit reached” observation | No fabricated Success or global Failed settlement |

Every branch carries `reconciliationFactRef`; Session ToolResult
`observationRef`, P3 Action `observation_source_ref`, and Session `source_ref`
are exact same deterministic identity and unique. Same fact replay yields no
second result/action/cursor.

The exact ref formula is P3's existing
`observation_${executionId}_${sha256Hex(JSON.stringify({providerTurnId,callRef,resultRef}))}`.
P4 `ReconciledNoEffect` carries an Artifact `resultRef` for the typed bounded
payload; P3 preserves that result ref and the reconciliation fact ref in the
ToolResult's result/disposition references. The P3 action source identity is
formed from the P3-owned ProviderTurn/callRef and exact resultRef; P4 cannot
invent any of those ids.

## P9 fact → P10 Attention projection / rebuild owner matrix

Only `StillUnknown`/no-profile unresolved effects escalate. P9 RecoveryController
reuses the existing durable `ReconciliationEscalated` event, with exact existing
identity `(executionId, invocationRefsFingerprint)` and refs. It does not emit
command text, profile parameters, authority snapshot, resource paths or raw
evidence. P10's source mapping is fixed:

| P9 event/fact | P10 Attention source | Severity | Target | Dedup key | Fixed path-free summary |
|---|---|---|---|---|---|
| `ReconciliationEscalated{executionId, invocationRefsFingerprint, refs}` | `ReconciliationEscalated` | `ActionRequired` | `executions.workspace_id` | `reconciliation-escalated:<executionId>:<invocationRefsFingerprint>` | “An external tool effect could not be verified; recovery is paused.” |

P9 commits the event/fact under the existing recovery commit/authority path;
repeated passes with the same execution/ref fingerprint do not duplicate it.
P10 owns the `Attention` row and event-consumer offset: apply row + advance offset
atomically; read-model rebuild resets Attention rows and rewinds the Attention
offset to the retained floor minus one in the P10 rebuild transaction, then
replays retained events. This proposal **does not** promise the Attention row
survives P1 journal pruning; beyond-retention visibility would require a separate
P9 durable fact-store/P10 rebuild-source design decision, not an implicit table.

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

## P39 physical schema supplement gate (proposal only)

The proposed physical representation and upgrade/rollback matrix are in
`planning/proposals/AH7-DG-02-P39-physical-schema-supplement-draft.md`. The
matrix below is qualification work after that supplement is independently
reviewed/accepted and after P37/P38 are present; it is not authorization to
write migration/tests now.

| Gate | Deterministic evidence required | Must not claim |
|---|---|---|
| Migration prerequisite | Refuse any schema version other than P38/user_version 38; verify P36 invocation state and P38 approval ledger exist; set user_version 39 only after successful transactional upgrade | P39 can ship before P37/P38 or this `db929` checkout already has them |
| Legacy backfill | P36 `MayHaveStarted`/`LegacyUnknown` use `admission_source=P36Backfill`, null `admitted_at`, `admission_time_precision=UnknownLegacy`; never copy `intent_at`. Settled rows `HistoricalSettled`; no inferred binding/profile/effect key/fact; approvals and P3 Action/Step/cursor unchanged | Intent time is treated as effect-admission time or old source/provenance is lost |
| FK and rollback | Inject failure after each DDL/copy/backfill phase; transaction rollback preserves schema, rows, P38 approvals, and version 38; run `foreign_key_check` on success | A post-commit down migration can erase facts safely |
| Binding integrity | Canonical RecoveryBinding digest verified; duplicate/mismatched P3 identity, action/callRef, resource snapshot or P38 approval subject/revision fails claim before effect admission | P4 trusts model/caller-supplied approval or source identities |
| Attempt constraints | Unique `(invocationId, attemptNo)`, only attempt 0/1; CAS permits only NotAdmitted→MayHaveStarted; legacy no-profile rows remain representable but cannot pass new Reconcilable admission | Any row label alone proves admission or proof |
| Fact integrity | Append-only trigger, deterministic fact identity, exact attempt/binding/profile/effect key match, duplicate identical proof idempotent, conflicting/late proof preserved and classified StillUnknown | A conflicting proof overwrites prior facts or implies NotOccurred |
| Atomic handoff | Kill around claim+approval+attempt0, admission, fact+settlement, and P9 event writes; before/after commit outcomes match the accepted transaction boundaries | Approval is consumed twice or an uncommitted MayHaveStarted effect is reported as admitted |
| Legacy unprofiled proof | Persist `StillUnknown/ProfileUnavailable` with `fact_origin=P36LegacyUnprofiled`, `legacy_reason=LegacyProfileUnavailable`, and NULL binding/profile/effectKey; verify accepted P9 `ReconciliationEscalated` + P10 ActionRequired exact query/rebuild/dedup | Hash/key is fabricated or a new public P4/P3 reason code is silently added |
| P39 CLI sidecar precheck | Require `--migration-block-report-db <absolute-local-path>` and validate path before DB connections; open sidecar read-only first, reject relative/temp/network/main-DB/hardlink/symlink aliases and unknown schema, then open main DB only after app_id/user_version/schema/file identity verified | Main DB opened before sidecar identity/schema is safe, or unknown/unrelated SQLite file is changed |
| Active P36 NotAdmitted preflight | Main `BEGIN IMMEDIATE` captures version/fingerprint/sorted IDs; no writes. Hold main lock while sidecar `BEGIN IMMEDIATE` commits the report, then read back by key/hash; rollback/close main. Resolve uncertain sidecar COMMIT by reopen/query | Main DDL/user_version/row/approval/P3 state changes on blocker or cross-DB lock inversion exists |
| Migration-prefix preservation / lock order | On user_version 36/37/38, P39 gate runs before any pending P37/P38/P39 migration; deployment maintenance mode excludes all other writers through complete chain. Two primary DBs sharing one sidecar serialize `primary→sidecar` without inverse lock order | P37/P38 commits before blocker detection, or an unquiesced writer creates a new NotAdmitted row after snapshot |
| Primary preflight nonmutation | Open with P1 SQLite VFS `disableWAL=true`, verify stored `journal_mode=wal`, then use `BEGIN IMMEDIATE` to read blocker snapshot; unsupported journal mode fails before migrations, no PRAGMA changes persistent DB | Preflight silently converts journal mode or mutates DB while reporting a blocker |
| Sidecar idempotency/corruption | Same `report_key` + exact `content_hash/report_json` returns same immutable row; key collision with different content fails closed; readback verifies exact bytes/hash; unknown schema fails before main DB open | Duplicate row, overwrite, or uncertain COMMIT assumed success/failure without query |
| Sidecar WAL durability | Verify `journal_mode=WAL`, `synchronous=FULL` each connection; SQLite owns WAL/SHM lifecycle; backup via SQLite backup API; process-kill/I/O fault/restart confirms persisted row | Sidecar WAL/SHM manually unlinked/copied separately or durability claimed beyond VFS/OS/device `xSync` semantics |
| Platform durability | Actual `@effect/sql-sqlite-node` VFS + Windows local FS/hardware qualify with process-kill, injected I/O faults and VM hard-power-off; network/unqualified filesystems blocked | `FULL` described as absolute hardware guarantee or unqualified platform is released |
| Permanent DB isolation | Report success + typed exit 78; preserve committed P36 DB state/user_version, approval and P3 action/cursor; never launch P39 binary against affected DB. Operator retains both; no automatic or current manual disposition is asserted | Affected legacy DB counted as upgraded/released or AH7 recovery work marked closed |
| Bound physical integrity | `Bound` requires nonnull binding digest and deferred composite FK to exact immutable `(invocationId,bindingSha256)` row at transaction commit; state/digest and binding row cannot be rewritten; mismatched/missing binding fails transaction; refs target artifacts/fact tables | Marker alone can assert Bound or a dangling ref can settle |
| Terminal conflict | Append contradictory post-terminal evidence as `PostTerminalEvidence`; P4 settlement and P3 ToolResult/Action/cursor remain byte-identical; no replay. If user-visible alert lacks an accepted source, stop for P9/P10 governance | Late fact rewrites terminal truth or is mislabeled RecoveryInput |
| P4 reconciliation terminal selection | Ordinary terminal=`Ordinary` with selected fields NULL; every reconciliation-derived Success/ExpectedFailure/ReconciledNoEffect=`Reconciliation` with nonnull selected attempt/fact composite FK to same invocation+attempt immutable fact; validate Occurred vs NotOccurred/result mapping | Reconciliation terminal settles with no selected fact, or points at a different invocation/attempt |
| Ambiguous proof facts | Multiple distinct authoritative RecoveryInput facts for one attempt remain StillUnknown and none can be selected; no Success/ExpectedFailure/ReconciledNoEffect settlement | A “latest” fact silently wins or conflicting evidence is collapsed |
| Reconciliation terminal replay | Same invocation/selected attempt/fact returns exact prior P4 settlement and rebuilds same P3 ToolResult/Action/cursor; no second selection or terminal rewrite | Recovery adds another terminal result or replaces selected fact |
| P36 historical terminal | Migrated settled P36 rows=`LegacyHistorical`, selected fields NULL; exact settlement/result refs retained; no retroactive facts invented | Old P36 settlement is represented as reconciliation-selected or a fake fact is created |
| Late conflicting evidence | Append `PostTerminalEvidence`/StillUnknown without changing selected fact, P4 settled fields or P3 ToolResult/Action/cursor; no replay | Late facts reselect terminal fact or roll back P3/P4 terminal truth |
| Real historical DB qualification | Copy real user_version 36/37/38 P36 DBs. Sidecar absent initializes exact schema; known schema accepted; unknown schema rejected before main open. Active NotAdmitted emits one immutable sidecar row before pending P37/P38 and permanently isolates DB; repeated run confirms same key/hash; inject uncertain sidecar commit then restart/query; main version/state unchanged. Separate unaffected DB upgrades | In-memory-only fixture substitutes for migration, blocker is detected after prefix upgrade, unknown sidecar is overwritten, report commit ambiguity untested, or isolated DB reaches P39 |

This phase permits proposal review only. No SQLite fixture was migrated and no
test was run while preparing the supplement.
