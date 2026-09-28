# AgentDirective v2 Readiness

**Date:** 2026-09-27
**Status:** Scope decision only; no schema, decoder, representation, Prompt,
or Runtime implementation

## Scope boundary

The canonical action review produces 15 ACTIVE semantic actions. That result
does not mean `agent-directive-v2` must contain 15 branches.

The following are semantic actions but have a different representation or
exposure boundary:

- `RespondToHuman` uses ordinary P14 response text;
- `AcceptWorkOutcome` is exposed only to an authorized Parent Agent or Human;
- `RecordVerificationEvidence` and `ConcludeVerification` are verifier-only;
- `SendMessage` may later compile to several provider-facing tools while
  remaining one canonical action;
- Runtime automation and Human controls never become AgentDirective branches.

## Proposed v2 initial scope at the semantic level

The v2 design review may consider these ACTIVE canonical actions:

```text
InvokeTool
AssignWork
Wait
ClaimCompletion
AcceptWorkOutcome
RecordVerificationEvidence
ConcludeVerification
SendMessage
DeclareDependency
ProduceDeliverable
RequestDependencyMatch
Deliver
ProposeChildWorkspace
SpawnSpecialist
```

`RespondToHuman` remains part of the canonical action language but is excluded
from the structured directive surface because P14 already defines ordinary
ModelOutput as the response representation.

This list is a semantic scope, not a JSON schema or provider tool plan.

## Explicit exclusions

The initial v2 scope must exclude:

- `ResponsibilityHandoff` — `DEFERRED` until successor/retire/authority
  transfer contracts exist;
- `StartVerification`, `CompleteWork`, coordinator satisfaction, wake,
  durability, authorization, and no-blind-replay controls — Runtime-only;
- `RecordDecision`, `SteerWork`, `CriticalSteer`, and `StopExecution` —
  Human/Governance controls;
- any provider-specific split of `SendMessage` — representation compiler
  responsibility, not canonical taxonomy.

P7 inclusion is already decided for the semantic scope: P7 is formally closed,
and G2/G6 freeze `ProduceDeliverable`, `Deliver`, and the ConsumerExecution
request path that uses the shared `SatisfyDependency` command
(`planning/results/P7.result.md`; `docs/design/implementation/P7/01-*.md`,
`02-deliver-primitive.md`).

## Readiness gates

Before v2 is declared ready for implementation, governance must still close:

1. the `Communicate` authored-content → durable `bodyRef` transformation;
2. the exact Reply target rule when multiple Queries are open;
3. canonical payload ownership for every selected action;
4. versioned manifest/decoder/repair identity and v1 compatibility policy.

These are contract-closure requirements, not reasons to add Runtime defaults or
Prompt instructions.

## Verdict

```ini
canonical_action_language = GOVERNANCE_CLOSED
responsibility_handoff = DEFERRED
agent_directive_v2_scope = IDENTIFIED
agent_directive_v2 = READY_FOR_SCOPED_DESIGN
agent_directive_v2_implementation = NOT_AUTHORIZED
model_facing_representation = NOT_AUTHORIZED
```

The semantic action language and the scoped v2 action set are ready for design
review. The v2 contract is not ready for implementation because the
communication content/reference and Reply-target boundaries, canonical payload
ownership, and versioned compatibility policy remain contract prerequisites.
