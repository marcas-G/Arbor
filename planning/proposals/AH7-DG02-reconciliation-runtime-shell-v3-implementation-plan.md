# AH7-DG-02 — Reconcilable Runtime and shell@3 Implementation Authorization Plan

Status: **DRAFT — fixed implementation scope; authorization pending. No work run.**

Requested authorization token:
`AUTHORIZE_AH7_DG02_RECONCILIATION_RUNTIME_AND_SHELL_V3_IMPLEMENTATION`

Baseline: accepted DID v1.40 AH7-DG-02 owner amendment and its P4/P3/P9/P10
landing. The design decision is already made: unrestricted `shell@3` is
`NonIdempotent`; historical exact `shell@2` is preserved, unprofiled legacy is
never blindly replayed; only a constrained tool definition with trusted,
version/hash-bound proof capability may be `Reconcilable`. This plan requests
implementation under that contract only; it does not alter frozen design.

Current implementation boundary at planning HEAD `367fd9a3`: the P39/P40
storage/runtime foundations exist, but `ToolReconciliationPort` has no
production call site; the P4 runtime constructs null profile/effect fields;
the built-in catalog still exposes shell v2 as `Reconcilable`; no shell v3
catalog descriptor exists. P39 remains a privileged maintenance migration;
P40 is in current schema 44. This plan adds no migration and does not use the
historical P39/P40 implementation records as proof that the reconciliation
runtime is wired or qualified.

## 1. Fixed implementation boundary

### Versioning and catalog behavior

- Add a new built-in `shell@3` definition with a new immutable definition hash
  and `NonIdempotent` semantics. Preserve the existing input/result contract,
  workspace sandbox boundary and approval policy; the version/hash change is
  only the accepted side-effect reclassification.
- New provider turns enumerate only the current shell v3 descriptor. Keep an
  exact v2 definition lookup only as required to recover persisted historical
  v2 actions/ToolInvocation rows; do not advertise v2 for new writes, mutate
  old rows, or reinterpret v2 as v3.
- Historical shell v2 has no proof profile by default. If its invocation is
  `MayHaveStarted`, recovery is fail-closed (`StillUnknown`/existing unresolved
  recovery path) with no Executor replay. Do not synthesize RecoveryBinding,
  profile hash or effect key for P36/P39 legacy rows.
- ReadOnly/Idempotent tools retain their existing classifications. This plan
  does not register unrestricted shell or arbitrary model-authored shell text
  as Reconcilable.

### Trusted profile source and runtime wiring

- Add a composition-owned immutable `ToolReconciliationProfileRegistry`
  (or equivalent existing catalog extension) keyed by exact trusted
  `(toolName, version, definitionHash)`. It returns profile ID/version/hash/
  protocol, stable effect-key policy and the `ToolReconciliationPort` adapter.
  Profile identity and effect key are Runtime/adapter facts; neither provider
  output, shell arguments nor model-selected values may populate them.
- P4 creates the P39 `RecoveryBindingV1` from the trusted selected profile and
  current authority/resource/approval snapshot before claim. The immutable
  profile tuple is copied into the P39 effect attempt. Missing/mismatched
  registry entry or incomplete profile fails closed before `MayHaveStarted`;
  profile hash/version drift on recovery cannot fall back to another adapter.
- Wire `ToolReconciliationPort` and `ToolReconciliationFactStore` through the
  application composition into P4 recovery. External read/confirm/cancel/fence
  I/O remains outside SQLite. Validate each returned proof against the exact
  invocation, attempt, binding SHA, profile hash, effect key, source revision/
  watermark, visibility scope, evidence refs/hash and finality before recording
  an immutable fact.
- No production Reconcilable tool profile is introduced by this package.
  Tests use a test-only deterministic profile/provider with explicit
  authoritative state and stale-attempt finality. If product scope requires a
  real production Reconcilable command/profile, that concrete external source,
  effect identity and finality contract require separate owner approval before
  registration; this token does not authorize inventing them.

### Three proof outcomes and settlement

- `NotOccurred`: only an authoritative, final proof for the exact attempt can
  be selected. Under a single current Worker fence, revalidate full current
  authority, grant/policy/verifier/ControlBasis revisions, resource state,
  approval binding, Stop predicate and profile hash. Permit at most attempt 1
  of the same ToolInvocation/ProviderTurn/LogicalAction/callRef. Commit the
  selected fact and P40 `ReconciledNoEffect` bounded Observation atomically;
  no new invocation/action/Provider decision.
- `Occurred`: accept only proof carrying reconstructable canonical result and
  result evidence. Revalidate identity and current full lease. Settle the same
  invocation and write the accepted bounded P40 Observation without invoking
  the Executor or inferring result from current workspace state.
- `StillUnknown`: store the exact immutable fact and use the existing P9
  `ReconciliationEscalated`/P10 `Action Required` route. Keep the invocation
  unsettled, Execution/action unresolved, and never admit/replay an Executor.
  Missing, eventual-consistency, stale-attempt or unavailable-source evidence
  is not `NotOccurred`.
- A stale Worker generation cannot read/select/settle on a winner path. Current
  fence, Stop and authority/resource checks are required in the same transaction
  as every P39 fact selection, attempt transition, P4 terminal settlement and
  P3 sourced ToolResult/Action/cursor write. A stop blocks new attempts, not
  accounting of already-known reality.

## 2. Qualification matrix

### Module / adapter

- Exact trusted profile lookup succeeds only for a registered descriptor/hash;
  missing, wrong-version/hash, partial tuple and model-authored profile/effect
  key all fail closed.
- Validate `NotOccurred`, `Occurred`, `StillUnknown` and malformed/mismatched
  proof payloads; bind fact identity to invocation + attempt + RecoveryBinding.
- P39 fact writes are idempotent/immutable. Inject storage failure and prove no
  P4 terminal settlement/P3 projection is claimed. P40 evidence checks its
  exact version/body/hash and distinguishes proof `evidence_ref` from P4
  Artifact/resultRef.
- Verify exact shell v2 persisted rows remain unprofiled and never execute on
  ambiguous recovery; verify fresh shell v3 writes use NonIdempotent.

### Real daemon/process crashes and concurrency

For one test-only trusted profile with an isolated authoritative source, cover
both sides of each relevant durable commit with actual daemon SIGKILL/restart:

1. Claim/attempt-0 before/after commit and `NotAdmitted → MayHaveStarted` before/
   after commit.
2. Crash before reconcile call; during source lookup; after proof returned but
   before fact commit; after fact commit but before selected settlement.
3. For `NotOccurred`, P40 RNO settlement before/after commit and P3
   ToolResult/Action/cursor before/after commit; exactly one bounded retry of
   the same invocation only when every current gate remains valid.
4. For `Occurred`, reconstructable result/Observation persistence before/after
   commit, then P3 projection recovery with no Executor repeat.
5. For `StillUnknown`, exact unresolved P3 outcome and P9/P10 recovery, no
   Executor call, no applied action, no success/result/artifact inference.
6. Two daemons: current G1 must not replay before P39 proof; stale G0 cannot
   write fact/settlement after G1 acquisition. Inject wrong-attempt facts,
   profile-version drift, Stop, approval revocation, authority/resource change
   and source visibility mismatch; all fail closed without widening access.
7. Migration/recovery fixture cases: clean schema44 current runtime; P39
   maintenance prefix/preflight refusal and legacy profile-unavailable rows in
   disposable copies only. Do not modify preserved/live DBs.

The live-lease acquisition and P4 settlement-fence tests remain supporting
evidence, not substitutes for the above P39 proof/reconciliation boundaries.

## 3. Explicit non-goals and stop conditions

- No `docs/design/**`, P1/P3/P4/P9/P10 semantic edits; no new command, tool
  output DTO, failure tag, Attention source, event, or user-facing profile
  selector.
- No new schema, SQL migration, P39/P40 DDL rewrite, migration registration,
  online/preserved database access, deployment or release operation. P39's
  existing maintenance-only preflight and schema44/P40 current boundary stay
  unchanged.
- No broad shell reconciliation, file-existence heuristic, arbitrary command
  replay, model-provided proof or effect identity, or cross-profile fallback.
- The production profile registry may remain empty. If a real production
  adapter/source, profile-specific finality horizon or effect-key semantics
  are needed to satisfy release/product scope, stop and request a separate
  owner decision; do not treat the implementation token as profile acceptance.
- The requested token does not by itself claim AH7 closure. Record exact
  per-case command, commit, schema fixture, provider/effect counts and resulting
  P39/P4/P3/P9/P10 state; keep AH7 PARTIAL until the complete authorized matrix
  and phase review pass.

## 4. Authorization proposal

If accepted verbatim, the requested token authorizes only the implementation
and qualification scopes in §§1–2 and the explicit no-migration/no-live-data
limits in §3. It does not authorize a production Reconcilable profile. No
implementation was run while preparing this plan.
