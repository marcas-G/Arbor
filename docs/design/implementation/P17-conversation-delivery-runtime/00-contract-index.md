# P17 — Conversation Delivery Runtime — Contract Index

> **MAC successor (DID v1.31):** durable ConversationResponse delivery and
> exact TurnProfile remain. MAC-P1 adds Root text-or-assign behavior through the
> common ActionCall facade; later placement/formation belongs to MAC-P2.
> RootConversation does not receive subagent capability. See
> `docs/design/implementation/MAC/**`.

**Baseline:** System Design v1.5 · DID v1.24 · accepted CDRC-1…CDRC-10

**Status:** FROZEN / IMPLEMENTATION COMPLETE / FORMALLY CLOSED

## Accepted owner amendment — EA-DG-01 (DID v1.39)

Fixed proposal SHA-256:
`E4F1B2935E0397292049BB3FDB1AB5847B02443CCE1B55A9827F823C63F145EB`;
acceptance record `planning/results/EA-DG-01-governance-acceptance.md`.
P17 `03`/`04`/`07` clarify that Executable `ApprovalRequired` pauses the same
Execution and does not consume conversation retry budget or create a new
ProviderTurn. The decision route stays separate from CAPA Control approval;
RootConversation's zero-executable-tool profile is unchanged. This is an
additive contract successor, not a reopen of the completed P17 implementation.

## Scope

P17 replaces P14's overloaded `HumanMessage Pending|Claimed|Answered` retry
protocol with a durable response-job runtime. It also closes the inference
context gate and exact turn-tool profile required to prevent invalid history or
irrelevant tools from becoming Provider requests.

P17 does not change Workspace/Work/Execution identity, P2 settlement semantics,
P4 authority/sandbox rules, or P6 Workspace messaging.

## Documents

| Doc | Owns |
|---|---|
| `01-domain-storage.md` | ResponseJob/Attempt ADTs, invariants, ports and migration-0021 DDL |
| `02-session-context-gate.md` | causal closure, blocked frontier, reconciliation-before-inference |
| `03-recovery-scheduler-breaker.md` | failure classification, three budgets, retry policy, scheduler and deployment breaker |
| `04-turn-profile-resolver.md` | purpose-specific exact tool/output/context profile; registry applicability |
| `05-commands-projections.md` | Resume/Cancel, status read model, transcript/web behavior |
| `06-migration-recovery.md` | legacy adoption, startup order, crash/replay and rollout |
| `07-acceptance.md` | mechanical seams, live qualification and closure gate |

## Recorded supersessions

- P14 `01` runtime state columns become legacy compatibility fields; immutable
  HumanMessage facts remain authoritative.
- P14 `02` §4.2 `Failed/OutcomeUnknown -> Pending -> retry-until-response` is
  superseded. Job policy classifies settlement before any retry decision.
- P14 `03` transcript gains a separate response-status projection; content
  entries remain backward compatible.
- Model Context `includeTools/includeControlTools` and compiler universal
  directive fallback are transitional and must be removed by P17.

## Authorization

Manual governance token accepted on 2026-10-01:

```text
ACCEPT_CONVERSATION_DELIVERY_RUNTIME_CONVERGENCE
```

Accepted proposal SHA-256:

```text
66FF684CFD71A76C20A6FA32B30C1413BED85F34A694DE06301B122366C121B2
```

Implementation order is fixed: Context Gate → Job/Attempt → Recovery/Scheduler/
Breaker → Turn Profile → Commands/UI → migration/restart/live qualification.
