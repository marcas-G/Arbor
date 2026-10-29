# RAI-DG-01 proposal — independent contract review

**Review scope:** v1 proposal SHA-256
`B5441C27A4DC6152641808A2CCD710C3F885C13ECFBDEF81B22074F498F6D826` only.
This review is superseded for the current v2 proposal and must not be cited as
its independent review.

**Reviewed proposal:** `RAI-DG-01-readmission-hold-governance-draft.md`
**Review baseline:** `2ea26f0e604d220b11e357c851346b7cec357b71`
**Review disposition:** **PASS WITH GOVERNANCE AUTHORIZATION REQUIRED**

This review checks the fixed proposal against the identified P2/P7/P9/P10 and
Execution Episode owners. It is not the manual governor's acceptance and does
not authorize changes to `docs/design/**` or implementation.

## Findings

1. **The counterexample is causally bounded.** It distinguishes the normal
   `ExecutionOrigin` settlement from `RecoveryController`, preserves
   `stop_requested_at = NULL`, and names the new Work Execution, rather than
   claiming the original Action was replayed. This matches the b186 test
   snapshot. Code review also confirms `AgentActionRecoveryBlocked` has no P9
   retry count: AgentLoop returns `RecoveryBlocked`, ExecutionRuntime releases
   the lease without settling, and repeated no-progress ProviderTurns are
   counted separately by P2 D4 until a RuntimeSafetyStop; D1 retry ordinals
   are provider-operation retries.
2. **The gap is real under the frozen decision table.** P2 `05` admits an Open
   current Work without a WorkWait; P7 `03` is the sole runnability authority
   and currently excludes safety/P9 evidence from its inputs. P9 blocks the
   original action's unsafe recovery but does not govern a distinct Execution
   with the same Work Episode binding. P10 expressly keeps Attention
   read-only. EGP supplies the needed exact Work revision identity but no
   re-admission transition.
3. **The recommended gate is not an implementation detail.** Adding it
   changes P2/P7 admission semantics and P10 active Attention derivation. The
   proposal labels those as explicit governance changes and does not pretend
   the source contracts already require them.
4. **Option comparison is material.** WorkWait re-use conflicts with the P7
   contract that waiting is an explicit cognitive decision and would merge
   recovery disposition with dependency/progress waits. The dedicated
   read-only gate keeps one scheduler predicate while using existing durable
   canonical sources.
5. **The trigger and release decisions are explicit.** The recommendation
   deliberately holds both P9 recovery-blocking facts and ordinary
   Work-bound RuntimeSafetyStop settlements. Only a revision-advancing
   authorized Steer releases the current hold; P10 queue ACK and projected
   Attention are not authority. This closes the re-entry loop without
   cancelling Work or globally deduplicating Deliverables.
6. **Episode and scope binding are appropriately narrow.** The proposal joins
   the source Execution to `agent_execution_state.episode_json` by
   `execution_id` and prohibits inference from Session text or the Attention
   target. A child fact affects only the child Work revision; parent/sibling
   Work is not blocked.
7. **Persistence and qualification are testable.** The query has one
   transaction snapshot; the authoritative admission path rechecks in its
   `BEGIN IMMEDIATE` transaction; before/after source commits and Steer commits
   have process-kill/restart cases; ordinary SafetyStop, P9-before-projector
   ACK, same-revision stop, later-revision recovery, Work scope and no global
   dedupe are separate assertions.

## Review correction

Initial draft text placed `episode_json` on `executions`. The frozen EGP
migration stores it in `agent_execution_state`. The proposal was corrected to
join `executions` and `agent_execution_state` by `execution_id` before this
review. No other contract ownership or scope mismatch was found.

## Limits / acceptance required

- The proposed P10 active-row omission after Work revision advance is new view
  semantics; P10 currently defines immutable facts and no general dismiss or
  repair action. Manual governance must accept this source-specific rule.
- Applying holds to ordinary RuntimeSafetyStop without a P9 fact is a
  deliberate conservative extension to G8/P2, not a mechanically implied
  consequence of the existing G8 wording. The proposal makes this choice
  visible for acceptance.
- `AdmitExecution` transaction revalidation depends on a reliable exact Work
  Episode binding being present before the first admission. If implementation
  discovers a missing binding, it must stop with a further Design Gap; it may
  not infer one.

No tests were run for this planning-only review. No design or runtime source
was modified.
