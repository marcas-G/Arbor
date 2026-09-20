# P3 — 06 Provider Failure / Repair / Freshness

**Authority:** DID v1.7 §6A.3, §6A.6, §6A.8, §6A.10, §8.19; SD v1.3 §6.3–§6.4.
**Status:** DRAFT (first draft for contract review).

## 1. Error translation boundary

- Adapter/SDK errors are translated at the adapter boundary into the narrow
  `ProviderFailure` port error (`01` §1); they never cross a semantic boundary.
- No universal `ProviderError` / `ContextPreparationError`; each port keeps a
  narrow semantic `E` (DID §6A.2, §6A.12, §7.7).
- `ContextUnsatisfiable` is a typed `E` of `prepareTurn`; it is **not** a
  control result (DID §6A.10).

## 2. Provider failure → runtime decision

```text
RateLimited          → retryable under safe-retry policy (bounded backoff)
ProviderUnavailable  → retryable under safe-retry policy
StreamInterrupted    → retryable; cancelled Turn ends here
AuthenticationFailed → terminal for the Turn; Attention; credential fix required
RequestRejected      → terminal for the Turn (non-retryable)
ProtocolViolation    → terminal for the Turn
```

- A terminal Turn failure does not itself settle the Execution `Failed`; the
  driver decides: bounded retry/repair, or settle `Failed` when the strategy is
  exhausted (DID §6A.6).
- `ProviderAttempt.outcome` records `Success | RetryableFailure |
  TerminalFailure` + `provider_error_kind` (`04` §3.2).

## 3. `ModelOutputContractViolation` bounded repair

- A request may succeed while the model output violates the Output Contract.
  This is **not** a provider transport failure (DID §6A.8).
- P3 owns the bounded repair mechanism:

```text
repair attempt 1..N:
  re-invoke prepareTurn with a repair instruction fragment (A4 Execution Strategy)
  + the violated Output Contract
  validate output against the contract
after N exhausted:
  settle the Execution Failed(ExecutionFailure) OR
  Interrupted(RuntimeSafetyStop) if the failure is a safety/looping signal
```

- `N` and backoff are empirical; the mechanism and the settle-after-exhaustion
  rule are contract.
- Repair never mutates canonical Domain truth outside `CommandGateway`.

## 4. `DecisionStale` / freshness

- Every effectful `AgentDirective` carries `decisionBasisManifestId` (DID §8.19).
- Tool/Command admission declares a `FreshnessRequirement` per action type.
- If a relevant Work/Responsibility/Boundary/Policy/Authorization/Environment
  revision changed since the Manifest, admission returns `DecisionStale`; the
  action is **not** executed and the AgentRuntime must re-`prepareTurn`.
- Read-only actions may use weaker freshness; write/destructive actions must
  validate their relevant control basis.

## 5. `ContextUnsatisfiable`

```text
prepareTurn -> E.ContextUnsatisfiable
  = mandatory / Pinned + Protected context cannot be legally constructed
    under the current allowed model policy
```

- Never silently truncate hard control facts (DID §8.9).
- The AgentRuntime handles it by running the compaction ProviderTurn (`02` §9)
  and re-invoking `prepareTurn`; if still unsatisfiable, settle
  `Interrupted` / escalate Attention — never a partial context.

## 6. `GovernanceBlocked`

- `prepareTurn` returns `GovernanceBlocked(GovernanceIssue)` for an
  unresolvable same-level canonical instruction conflict (DID §8.7, §6A.10).
- The AgentRuntime emits Attention / a governance request; it does not
  improvise a resolution and does not mutate governance state.
- `RequestGovernance` directives are routed through the Application command
  pipeline, not applied by the runtime.

## 7. Must Not Decide

- No tool `OutcomeUnknown` reconciliation (P4/P9).
- No verification verdict (P8).
- No Work lifecycle change (Application/P8).
- No safety counter ownership (P2).
