# AH7-DG-02 independent read-only audit

Status: **design gap confirmed; fixed decision draft and layered matrix prepared;
not accepted and not implementation-authorized**.

Worktree: `C:\Users\ThinkPad\.codex\worktrees\ah7-reconcilable-dg02\Arbor`  
Explicit source baseline: `db929654128b8e864d3733b95088f4edda0e4c43`  
Checkout: detached at the explicit source baseline; managed worktree is separate
from the already reviewed AH7 implementation tree and `C:\Arbor`.

## Evidence and conclusion

- `planning/gaps/AH7-DG-02-reconcilable-tool-proof.md` describes the live
  process counterexample: shell appends a marker, daemon dies after the effect
  and before P4 settlement, restart prevents duplicate append but reports
  OutcomeUnknown without reading/proving the external result.
- Historical `planning/proposals/reconcilable-shell-reality-proof-decision-draft.md`
  has SHA-256
  `41E0998B6B93648C0D0CA5767C97628F091E54E757299D1D585D0B4E71B50A9A`; the
  recorded readiness review says draft only, not accepted or implementation-
  authorized.
- P4 `01` §2 and `02` §5 require Reconcilable reality resolution before replay;
  P4 `08` §5 nevertheless freezes arbitrary `shell@2` as Reconcilable.
- P4 `06` §4 defines `ReconciliationSource.pending` as returning invocation
  refs. P4 `06` §6 expressly leaves external reconciliation logic to the owning
  tool. This does not specify an evidence-producing port, stable effect key,
  profile/version, proof strength/finality, attempt state, or persisted result.
- P9 `02` §5 T3 requires real external reality reconciliation before settling;
  P9 `07` §1–§4 specifies recovery ordering/disposition but not how to obtain,
  bind, persist or project `NotOccurred` / `Occurred` / `StillUnknown` facts.
- Current `packages/tool-runtime/src/catalog.ts` binds shell to hash
  `shell-v2-mount-relative-cwd` and `sideEffectSemantics: Reconcilable`.
  `packages/tool-runtime/src/tools/shell.ts` executes arbitrary policy-allowed
  command text with `spawnSync`; its policy only classifies deny/approval/allow.
  `ToolExecutor` has `execute` but no reconcile operation. Current
  `packages/tool-runtime/src/reconciliation.ts` enumerates unsettled refs by
  semantics and does not inspect an external source.

Thus existing contracts express the objective but do not make arbitrary shell
reconciliation executable. The design gap remains; current `OutcomeUnknown` /
`ReconciliationPending` is a safe stop, not proof that the external effect was
reconciled.

## Reused crash reproduction

The existing `tests/functional/process/agent-action-ah7-reconcilable.functional.test.ts`
is reused as the baseline reproduction; it was **not run in this task**. Its
post-effect/pre-settlement scenario proves the external marker is present once
and is not blindly replayed, while restart remains unresolved. This preserves
the failure evidence without starting a daemon. Its pass is explicitly not
counted as reconciliation qualification. No new test was added.

## Draft package

- Fixed governance draft:
  `planning/proposals/AH7-DG-02-reconcilable-tool-reality-fixed-decision-draft.md`
  SHA-256 `D0A43BCDF3F95424BE7167B49D2170917B7605EE1E498A2601F2FFFB3DD6940B`
- Layered qualification matrix:
  `planning/tasks/AH7-DG-02-reconciliation-qualification-matrix.md`

The draft selects generic new `shell@3` as NonIdempotent; permits Reconcilable
only for exact versioned profiles with stable effect identity, authoritative
proof and old-attempt finality; closes the three proof states, retry gate,
authority/resource/approval binding, per-attempt P4 facts, P3 ToolResult source,
P9 Attention, and legacy shell@2 fail-closed disposition. It introduces no new
SideEffectSemantics tag and does not rewrite frozen docs.

## Scope and validation

- No production code, migration, tests, or `docs/design/**` modified.
- No daemon or full-suite test run.
- `git diff --check`: PASS; only the three intended planning files are changed.
- Manual acceptance: **none**. The proposal is a recommendation only; a
  separate human acceptance and landing review are required before design or
  implementation changes.

## Independent review response (Blocking=4)

The fixed draft/matrix were revised for all four blockers; this remains a
proposal and makes no accepted design or production changes:

1. Stop prohibits **new attempt admission only**. Read-only reconciliation and
   known in-flight Occurred/NotOccurred/StillUnknown accounting may still be
   durably recorded after Stop under the current full Worker lease fence;
   these fact/settlement writes do not require `stop_requested_at IS NULL`.
   Known Occurred settles once; known NotOccurred is not replayed and maps to
   `ReconciledNoEffect(StopRequested)` plus the existing Interrupted quiescence
   result; StillUnknown keeps the unresolved gate/Attention and is never plain
   Interrupted. A stale/expired generation cannot write facts or settlement.
2. The P3→Application→P4 identity path is explicit:
   `PreparedModelTurn.manifest.providerTurnId`, P3
   `AgentLoopStepRecord.identity` (`executionId`, `logicalStepNo`, `repairAttempt`),
   durable `AgentLoopStepActionRecord.logicalActionId/actionIndex`, and pinned
   `ToolInvocation.callRef` are copied in Runtime-owned
   `ExecutableInvocationInput.sourceBinding` to both P4 `ToolIntent.sourceBinding`
   and `ToolExecutionContext.sourceBinding`. P4 owns binding persistence/migration
   and exact re-entry checks. Approval subject/revision is trusted only from the
   P4 durable ledger: claim CAS re-reads exact revision, authenticated subject,
   action/args/target/basis, expiry and state before consume and atomically records
   the same consumed-by ToolInvocation plus pre/post revisions.
3. P9 reuses the exact existing
   `ReconciliationEscalated{executionId,invocationRefsFingerprint,refs}` event;
   P10 owns the materialized projection. Exact mapping is
   `source=ReconciliationEscalated`, `severity=ActionRequired`, target
   `executions.workspace_id`, dedup key
   `reconciliation-escalated:<executionId>:<invocationRefsFingerprint>`, fixed
   path-free summary “An external tool effect could not be verified; recovery
   is paused.”, and event `occurredAt`. P10 apply+offset are atomic; rebuild
   resets rows and rewinds Attention offset to retained-floor−1 in the same
   transaction before replaying retained events. User visibility is explicitly
   limited to the P1 journal retention horizon; indefinite post-prune Attention
   would need a new accepted source-store design.
4. `ReconciledNoEffect` is a closed P4 **CanonicalToolObservation and
   ToolInvocationSettlement** variant with exact five-code union plus required
   `reconciliationFactRef` and result ArtifactRef. It is never P4 Denied and
   never resets `MayHaveStarted`. P3 maps authority/resource/approval changes to
   Denied/TerminalRejected, StopRequested to Interrupted/quiescence, and replay
   limit to Failed/Applied. ToolResult uses the exact existing source formula
   `observation_${executionId}_${sha256Hex(JSON.stringify({providerTurnId,callRef,resultRef}))}`;
   this same ref is Session AgentLoopAction `source.ref`, ToolResult
   `observationRef`, and AgentLoopStepAction `observation_source_ref`.

Nonblocking historical shell clarification: only `MayHaveStarted` /
`LegacyUnknown` shell@2 rows lacking a historical profile are blanket
`StillUnknown`/no-replay. A shell@2 row with exact `NotAdmitted` and complete
binding may re-enter the exact retained v2 definition under fresh gates; that
definition stays available until such rows terminate. It may never silently
switch to shell@3.

## P39 physical-schema supplement status

Parent direction paused the accepted DG02 owner-document landing because the
logical D0A package did not freeze every physical P39 field/constraint and the
actual `db929` checkout contains P36 but not P37/P38. A proposal-only P39
supplement was added at
`planning/proposals/AH7-DG-02-P39-physical-schema-supplement-draft.md`; its
SHA-256 is
`2BE13013986BE7B9D3626892FB31C6B9F364F554980310D44D4705F7A56CEC6C`. It
proposes versioned canonical
RecoveryBinding JSON + digest, per-attempt rows, append-only three-outcome facts,
exact constraints/indexes, illustrative SQLite upgrade envelope, transaction
failure rollback matrix, immutable/late/conflicting proof handling, and the
accepted P36→P37→P38→P39 ordering. The qualification matrix now contains
proposal-gated migration/backfill/FK/rollback/binding/attempt/fact/atomicity
gates.

## Independent review response (Blocking=3)

The P39 proposal/matrix were revised only; no owner docs, production, migration,
or test source was changed:

1. P36 has no `admitted_at`. Backfilled MayHaveStarted/LegacyUnknown attempts
   now preserve `admitted_at=NULL`, `admission_source=P36Backfill`, and
   `admission_time_precision=UnknownLegacy`; P36 `intent_at` is never used as an
   admission-time proxy. New P39 admission records a transaction-captured time
   with `TransactionTimestamp`, explicitly not exact commit wall time.
2. Legacy unprofiled attempts now have a representable `P36LegacyUnprofiled`
   StillUnknown fact with NULL binding/profile/effectKey and physical
   `legacy_reason=LegacyProfileUnavailable`; public canonical reason remains
   accepted D0A `ProfileUnavailable`, so no fake hash/key or public union
   extension is silently introduced. The alternative public reason-code
   extension is explicitly flagged as separate governance. P9/P10 for these
   may-have-started rows remains the already-accepted D0A
   ReconciliationEscalated→ActionRequired mapping.
3. Active P36 NotAdmitted rows cannot use that external-effect Attention path.
   P39 therefore has a pre-DDL refusal gate that leaves the same DB, approval,
   P3 Action/cursor, schema and `user_version=38` unchanged and emits a durable
   `{kind,schemaVersion,databaseFingerprint,createdAt,invocationIds}` audit
   report. P39 proceeds only after existing authorized old-version disposition
   makes them terminal; if that path is unavailable, migration/release remain
   blocked and no new Attention event is invented.
4. `Bound` now requires a non-null binding digest and deferred composite FK to
   the exact immutable binding row at commit; binding marker/digest and attempt
   identity cannot be rewritten. Invocation/fact ArtifactRefs and invocation-
   scoped settlement fact references have explicit FK targets. Terminal
   settlement cannot be rewritten; contradictory late facts append as
   `PostTerminalEvidence` / `StillUnknown(EvidenceBindingMismatch)` without
   changing P4/P3 terminal state or replaying. Any new post-terminal
   user-visible Attention remains a separate P9/P10 gap.

Qualification now includes actual schema-38/P36 copies, migration refusal,
rollback, repeated migration-runner invocation/restart, approval and Action/
cursor preservation, and post-terminal contradiction checks. No tests or daemon
processes were run; `git diff --check` is the only validation. The supplement
remains DRAFT and is not owner landing or implementation authorization.
