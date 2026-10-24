# RAI-DG-02 — Real S2 terminal Provider failure busy-loop evidence

**Status:** RED / governance gap confirmed. This record is evidence only. It
does not modify `docs/design/**`, authorize implementation, qualify the real S2
journey, or treat the retained fixture as safe to upgrade.

**Observed at:** 2026-10-24

**Evidence root:**
`.test-results/real-public-s2-normal-8dc83228e0-j4dztq`

**Retained database:**
`.test-results/real-public-s2-normal-8dc83228e0-j4dztq/retained-fixture-ba8727d4-0f2e-4ccb-ad77-2f97d538ea10/arbor-functional.db`

All counts below were obtained from the retained SQLite fixture and the
redacted capture envelope. No credential, Authorization header, request body,
response body, user content, filesystem resource path, or raw Provider payload
is reproduced here.

## Observed public journey

The real S2 Normal journey made 620 Provider requests over approximately
19 minutes 49 seconds (first Execution admission
`2026-10-24T14:10:50.636Z`; last admission
`2026-10-24T14:30:37.966Z`; evidence recorded
`2026-10-24T14:30:39.607Z`). Capture event counts were:

| Capture fact | Count |
|---|---:|
| `request-start` | 620 |
| `response-complete`, HTTP 200 | 2 |
| `response-complete`, HTTP 400 | 618 |
| HTTP 400 body classified locally as missing/rejected `reasoning_content` | 618 |

The first successful response served the root conversation. The second
successful response was the first Work decision and included the expected tool
call. The next Provider request was durably classified
`TerminalFailure(RequestRejected)`. Instead of holding the same Work revision,
the scheduler repeatedly admitted a new Work Execution and sent substantially
the same terminally rejected request.

## Canonical database facts

| Durable fact | Exact count |
|---|---:|
| Executions settled `Failed` | 617 |
| Executions still unsettled in the retained crash snapshot | 1 |
| Failed Execution reason `ProviderFailure:RequestRejected` | 617 |
| ProviderAttempts `TerminalFailure / RequestRejected` | 617 |
| ProviderAttempts `Success` | 2 |
| ProviderAttempts `InProgress` in retained snapshot | 1 |
| ProviderTurns `finish_reason=Failed` | 617 |
| ProviderTurns `finish_reason=ToolCall` | 2 |
| ProviderTurns unsettled | 1 |
| canonical Work | 1 `Open`, revision 1 |
| WorkWait rows | 0 |
| Verification rows | 0 |
| Acceptance rows | 0 |
| Attention projection rows | 0 |

Episode distribution is also material:

| Episode binding | Settlement | Count |
|---|---|---:|
| ConversationResponse revision 0 | `Failed` | 1 |
| Work revision 0 | `Failed` | 1 |
| Work revision 1 | `Failed` | 615 |
| Work revision 1 | active/unsettled snapshot | 1 |

The one ConversationResponse failure did not form this loop because P17 owns a
separate bounded ResponseJob/Attempt lifecycle. The failure is specifically an
open Work readmission problem: the same canonical Work stayed Open at revision
1, no WorkWait or exact-revision hold existed, and each `Failed` settlement
made it immediately runnable again.

## Exact durable binding is available

The retained records are sufficient to attribute a terminal Provider failure
without parsing Session text or Provider response bodies:

1. `executions` carries the exact WorkEpisode `(workId, episodeRevision)` and
   the final `Failed(ExecutionFailure("ProviderFailure:RequestRejected"))`.
2. The matching `agent_loop_steps` row is `SettlementProposed`, carries the
   same settlement and the exact `providerTurnId`.
3. `provider_turns` binds that turn to the Execution, Manifest, model and
   Output Contract and is durably `finish_reason=Failed`.
4. `provider_attempts` binds the terminal attempt to that turn and records
   `TerminalFailure`, `RequestRejected`, taxonomy `phase1-v2`, and
   `retry_decision=Stop`.
5. `model_context_manifests` carries the compiled request hash and the frozen
   model/context binding evidence.

The first revision-1 Work Execution contained one successful tool-call Turn
followed by the terminally rejected Turn. The remaining revision-1 admissions
started directly with the same terminal failure class. This proves that a
failure source must bind the exact settlement-producing Step/Turn/Attempt; a
query that merely picks an arbitrary or first Turn in the Execution would be
incorrect.

## Contract audit

This behavior is permitted by the current contracts but is not intended as a
safe product outcome:

- P3 correctly classifies `RequestRejected` as terminal and non-retryable for
  the ProviderTurn. It permits the Agent driver to settle the Execution
  `Failed` when recovery is exhausted.
- DID correctly states `Execution Failed != Work Cancelled`; the Work therefore
  remains Open.
- P2/P7 correctly re-admit an Open current Work that has no active WorkWait,
  active Execution or current RAI source.
- RAI-DG-01 deliberately closes its source union to
  `RuntimeSafetyStopSettlement`, `OutcomeUnknownSettlement`, and three P9
  recovery sources. It expressly says ordinary `Failed` is not a source.
- `Completed(Blocked)` cannot be reused: it requires exact terminal
  denied-action evidence plus an explicit help request. A Provider transport
  rejection is neither a denied tool action nor a model-authored request.
- P12 D1 is bounded ProviderAttempt retry inside one ProviderTurn. D2/D4 bound
  one Execution's no-progress behavior. Re-admitting a fresh Execution resets
  those execution-local mechanisms and therefore does not close the observed
  loop.
- P10 has no current source row for this condition and, in any case, is a read
  model rather than scheduler authority.

Therefore no accepted contract can be stretched to cover this failure without
changing a closed source union or violating the Blocked evidence contract.
`planning/proposals/RAI-DG-02-terminal-provider-failure-readmission-hold-draft.md`
contains the proposed minimal owner-consistent amendment.

## Required negative oracles

Any accepted implementation must prove all of the following; a test that only
checks a visible Attention row is insufficient.

1. After the first exact terminal Provider failure source commits, the same
   Work revision admits no second Execution, ProviderTurn, ProviderAttempt,
   ToolInvocation, AgentAction or canonical command.
2. Work remains `Open` at the same revision. It is not auto-completed,
   auto-cancelled, verified, accepted, failed as a Work, or removed from the
   Workspace.
3. No synthetic WorkWait, timer, exponential backoff, retry poll or P10 ACK is
   scheduler authority.
4. Restart and repeated reevaluation do not release the hold.
5. Retryable Provider failures continue to use bounded same-ProviderTurn
   ProviderAttempts and are not reclassified as this terminal hold.
6. `ModelOutputContractViolation`, tool failure, `RuntimeSafetyStop`,
   `OutcomeUnknown`, and P17 ConversationResponse failure keep their existing
   owning contracts.
7. A valid revision-advancing authorized `SteerWork` releases only the old Work
   revision. It does not delete the failure evidence or widen authority,
   Sandbox, ResourceBoundary or PermissionGrant.
8. A malformed/missing/conflicting Step/Turn/Attempt/Manifest binding fails
   closed with bounded typed identifiers; no Work or failure identity is
   inferred from Session text, response content, latest-row timing, or
   Workspace current pointers.
9. Public Attention/Work Detail exposes only a closed failure code and fixed
   safe summary. It never exposes Provider response bodies, reasoning content,
   prompts, credentials, request JSON, paths, SQL/parser text, or raw hashes
   other than the bounded governance fingerprint.
10. The Provider-adapter defect that produced the rejected request remains a
    separately testable defect. Holding the Work must not be claimed as fixing
    request construction or real S2 qualification.
