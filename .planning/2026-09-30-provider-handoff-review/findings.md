# Review evidence

- DOGFOOD-DG-01 records a successful ProviderTurn under an Active Execution with a fenced Session append.
- Draft introduces durable AgentTurn handoff but review must cover repair, terminal failure, takeover, and action replay.
- Existing root planning files belong to earlier recovery work; review uses this isolated directory.
- Provider runtime commits successful Attempt and Turn in separate transactions (runtime.ts ~1144-1170). Draft resumes every unsettled Turn with a new Attempt while its first crash test demands no duplicate request.
- Draft graph has no terminal Provider failure or exhausted repair path; existing P3 06 requires durable failure/safety disposition.
- Draft action graph requires all actions completed before observations/settlement; current frozen freshness semantics require skipping stale actions and preparing a fresh decision. P2/P9 require reconciliation before replay of unknown side effects.
- Legacy incident has no AgentTurn row; draft read/recovery rules all assume a record exists.
- Confirmed immutable command identity conflict: DID §9.9 makes FencingRejected terminal; gateway.ts 247-285 replays stored rejection before fresh fence checks. Stable action command IDs therefore cannot recover after old-owner rejection. SettleExecution additionally fingerprints expectedFencingGeneration (execution-runtime.ts ~194), creating a different fingerprint under takeover.

## Final findings

1. P1: Stable command keys need a governed distinction between logical action identity and authoritative command attempts; otherwise stale-worker terminal rejection poisons recovery (draft 138-142, 149-151).
2. P1: Successful Attempt / unsettled Turn must reconcile locally or commit atomically. Unconditional P9 retry contradicts the no-duplicate-request requirement (draft 157, 194-204).
3. P1: Complete the graph for terminal provider failure and exhausted output repair, with durable terminal disposition and no required ModelOutput (draft 71-78).
4. P1: Add partially executed batch disposition for DecisionStale and early settlement. Existing freshness rules prohibit executing stale remainder, whereas graph requires every action completed before observations and settlement (draft 138-145).
5. P2: Specify governed migration/reconciliation of pre-AgentTurn records, including the exact DOGFOOD-DG-01 state; current recovery table cannot select a record that does not exist (draft 155-166).

Review uses static contract/code inspection and explicit crash/concurrency counterexamples; no runtime tests were run and no frozen design or application source was edited.

## Second review

- Revised 345-line draft responds materially to R1–R5 at proposal level.
- R6/P1: OutcomeUnknown is counted as terminal for ordinary TurnEffectsCommitted progression without the P2/P9 unresolved-effect settlement guard.
- R7/P2: NextTurnReady and OutputRejected + Retry have no recovery-table rows or explicit successor-reuse transition.
- R8/P2: Universal one-answer/no-duplicate-provider assertions do not distinguish safe Attention, null-body Interrupted, and authorized new decisions/attempts.
- Shareable report: planning/proposals/provider-result-handoff-decision-draft.review-round2.md.

## Third review

- Draft SHA-256 BDC9AFB28515B2BC6FDBC450EEEB8006ACB1D8A4994DB5AB290A472EA0AB512F.
- R6–R8 addressed at proposal level: unresolved-effect gate, stable successor recovery, branch-specific acceptance assertions.
- No new P1/P2 findings in this pass. Recommend submission for manual governance; no implementation authorization or Design Gap closure implied.
- Shareable report: planning/proposals/provider-result-handoff-decision-draft.review-round3.md.

## Governance submission review

- Submission hash 908610EE54ED33B3AA5448264E8C18A32EFB333B372D18934D97EC1993EB3A08.
- Referenced proposal hash matches actual file and round-three review.
- No blocking findings: review/governance/implementation/evidence boundaries are retained.
- Review saved to planning/proposals/provider-result-handoff-governance-submission.review.md; not an ACCEPT decision.
