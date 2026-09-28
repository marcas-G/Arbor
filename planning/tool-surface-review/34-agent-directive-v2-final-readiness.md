# AgentDirective v2 Final Readiness

**Date:** 2026-09-27
**Status:** Semantic contract-design gate; no schema or implementation

## Communication closure

The communication decisions in
[31-communication-binding-closure.md](./31-communication-binding-closure.md),
[32-send-message-kind-matrix.md](./32-send-message-kind-matrix.md), and
[33-reply-target-semantics.md](./33-reply-target-semantics.md) close the two
remaining canonical semantic gaps:

1. Model-authored body text is persisted by Communication Runtime through P4
   BlobStore; P4 returns the authoritative content-addressed `BlobRef`, which
   becomes P6 `bodyRef`.
2. Reply selects an existing Query by `queryMessageId` when the choice is
   ambiguous; Runtime derives recipient and correlation. A unique pending
   Query is bound automatically; missing/stale targets fail closed.

Query, Reply, Report, DecisionRequest, and Deliver now have explicit ownership,
target, correlation, persistence, effect, and failure rules. Runtime does not
invent model-owned content, communication kind, discretionary Query target, or
ambiguous Reply choice. Durable messages cannot reference absent body content
or unresolved Reply correlations.

## Scoped v2 action set

The semantic v2 contract design scope is the ACTIVE structured-action subset
of the accepted canonical Action Language:

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

`RespondToHuman` remains an ACTIVE canonical Agent Action but stays on P14's
ordinary ModelOutput response channel, so it does not become a second
structured directive branch.

`RequestDependencyMatch` is the semantic name for the ConsumerExecution
request intent. The downstream frozen command remains `SatisfyDependency`;
Runtime's structural matcher alone decides whether the Dependency changes
state.

## Exclusions

- `ResponsibilityHandoff` remains explicitly `DEFERRED` until successor,
  responsibility transfer, retirement, authority transfer, rebinding, and
  recovery semantics are frozen.
- `StartVerification`, `CompleteWork`, coordinator satisfaction, wake,
  authorization, durability, and no-blind-replay remain Runtime automation.
- `RecordDecision`, `SteerWork`, `CriticalSteer`, and `StopExecution` remain
  Human/Governance controls.
- Provider-specific tool splitting remains a later representation concern.

## Readiness verdict

All Communication Binding Semantic Closure gates are satisfied at the
canonical design level:

```ini
body_ref_owner = P4_BLOBSTORE
message_persistence_owner = P6_SENDMESSAGE_COMMAND
reply_single_target = RUNTIME_UNIQUE_BINDING
reply_multi_target = EXISTING_QUERY_MESSAGE_ID
stale_or_missing_target = FAIL_CLOSED
kind_binding_matrix = COMPLETE
deliver_transform = COMPLETE
communication_design_gaps = 0
agent_directive_v2 = READY_FOR_CONTRACT_DESIGN
implementation = NOT_AUTHORIZED
```

This authorizes the next **contract design** step only. It does not authorize
JSON schema authoring in this stage, model-facing tool design, production
changes, Prompt changes, S01, or Wave 2.
