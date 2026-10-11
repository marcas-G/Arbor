# AH7-DG-02 fixed decision — governance acceptance record

Status: **fixed semantics accepted; implementation authorization remains OPEN**.

## Decision identity and authority

- Accepted fixed proposal:
  `planning/proposals/AH7-DG-02-reconcilable-tool-reality-fixed-decision-draft.md`
- Accepted proposal SHA-256:
  `D0A43BCDF3F95424BE7167B49D2170917B7605EE1E498A2601F2FFFB3DD6940B`
- Decision: accept the exact proposal package as the AH7-DG-02 owner-contract
  landing basis. No later or additional semantics are accepted by this record.
- Authority: user standing manual-governance delegation, relayed by the parent
  task author for this landing. This is a design acceptance on the governor's
  behalf, not an implementation authorization.
- Independent proposal review: **Blocking = 0**. The reviewed proposal SHA above
  matches exactly. The review's four blocker resolutions are captured below.
- Implementation eligibility/authorization: **OPEN / separately gated**. No
  production code, migration code, or tests are authorized by this decision.

## Accepted decision summary

1. New unrestricted `shell@3` is `NonIdempotent`. Existing settled `shell@2`
   history is preserved. Exact historical `NotAdmitted` shell@2 invocations
   may re-enter only while the exact v2 definition/binding is retained and the
   ordinary fresh P4 gates pass. Unsettled `MayHaveStarted` / `LegacyUnknown`
   shell@2 with no proof profile fails closed; no catalog reinterpretation or
   blind command replay.
2. `Reconcilable` requires an exact versioned profile, stable effect identity,
   authoritative evidence, and proof that a stale attempt cannot complete late.
   The closed results are `NotOccurred`, `Occurred`, and `StillUnknown`; only
   `NotOccurred` can permit one bounded exact-invocation replay after complete
   authority/resource/approval and lease revalidation. `Occurred` settles only
   with reconstructable canonical result evidence. Inconclusive proof never
   replays.
3. P3 Runtime-owned ProviderTurn/Step/Action/callRef source binding flows through
   the Executable handler to P4 ToolIntent and ToolExecutionContext and is
   durably verified by P4. Approval subject/revision is P4-ledger-sourced and
   CAS-consumed in the existing claim transaction; re-entry never consumes a
   second time.
4. Stop blocks new attempt admission, but known in-flight facts and terminal
   accounting may commit under the current full Worker fence after Stop.
   `ReconciledNoEffect` is a distinct closed P4 observation/settlement union,
   not P4 `Denied`, and carries a reconciliation fact reference.
5. P9 owns the existing `ReconciliationEscalated` durable event; P10 owns its
   ActionRequired Attention row, target, dedup, summary, consumer offset and
   rebuild. User-visible Attention is bounded to the source journal retention
   horizon unless separately governed persistence is accepted.

## Independent review blocker dispositions

- **Stop/quiescence:** only a new effect admission/replay requires
  `stop_requested_at IS NULL`. Read-only reconciliation and known effect facts
  may be recorded after Stop under a current, unexpired full Worker lease fence;
  an expired/stale generation cannot write them.
- **P3→P4 trusted identity/approval:** P3 supplies its durable
  `ProviderTurnId`, `AgentLoopStep` identity, `LogicalActionId`, action index and
  pinned `callRef`; Application forwards the binding; P4 stores and compares it.
  P4 consumes only after an exact ledger revision/subject/action/target/basis/
  expiry CAS.
- **P9/P10 Attention:** event owner, projection owner, severity (`ActionRequired`),
  target (`executions.workspace_id`), dedup identity, fixed path-free summary,
  apply+offset and rebuild retention boundary are explicit.
- **ReconciledNoEffect:** exact P4 CanonicalToolObservation and settlement
  variants, five reason codes, fact/result refs, and P3 ToolResult status,
  Action/cursor and source-reference formula are explicit. The result never
  resets `MayHaveStarted` or masquerades as P4 Denied.

## Migration sequencing note

The accepted package requires a new P4 persistence migration for source
bindings, effect attempts and reconciliation facts. The parent confirmed the
reserved sequence: P36 (AH7-DG-03) → P37 (AH10 Deliver) → P38 (Executable
approval) → **P39 `ah7_reconciliation_attempts`**. The green `C:\Arbor@f80`
candidate is at P35; this managed `db929` checkout contains P35/P36 and
production migration wiring to P36. P37/P38 are not integrated in this
checkout. DG02 schema depends directly on P36 and P38; P37 is an ordered
`user_version` prefix dependency. Therefore P39 and its schema are conditional,
not-yet-integrated/unreleased; P39 cannot be independently implemented or
deployed before P37/P38. No migration code is authorized by this acceptance. If
final physical DDL requires an unaccepted field/index beyond the proposal, stop
and raise it rather than inventing schema semantics.

## Landing scope

This acceptance is based on `db929654128b8e864d3733b95088f4edda0e4c43` in the
separate `ah7-reconcilable-dg02` managed worktree. The subsequent owning-document
landing must remain limited to the exact accepted package, record all owner
file hashes, preserve the existing P36/P37/P38 dependency order, and receive
post-landing consistency review. It must not modify production, migration
implementation, tests, `C:\Arbor`, or the green integration tree.
