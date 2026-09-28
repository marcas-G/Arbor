# Agent Action Language Governance Review

**Date:** 2026-09-27
**Status:** Governance review; no schema, representation, Prompt, or
implementation change authorized

## Scope and decision rule

This review starts from the 15 candidates in
[25-agent-action-language-candidate.md](./25-agent-action-language-candidate.md)
and checks them against the 49 S1–S4 Decision Points, the frozen P1/P4/P6/P7/P8/P14
contracts, and the distinction between model intent and application/runtime
effects.

An item is a `CANONICAL_AGENT_ACTION` only when:

1. the model must express a business-semantic intent or authored decision;
2. the intent crosses an authority, lifecycle, communication, evidence, or
   external-effect boundary; and
3. Runtime must structurally validate, observe, persist, or route that intent.

An existing Application command is not sufficient by itself. Conversely, a
command may be the deterministic realization of a canonical action without
making the action command-only.

## Overall verdict

All 15 candidates remain canonical Agent Actions. None is downgraded to
`APPLICATION_COMMAND_ONLY`, `RUNTIME_AUTOMATION`, or `HUMAN_CONTROL`.

That does not mean every action is exposed to every execution or represented as
an `AgentDirective` branch:

- `RespondToHuman` is a canonical semantic action whose representation is the
  ordinary bounded ModelOutput of a P14 Coordination execution. It must not be
  duplicated with a second response directive.
- `AcceptWorkOutcome` can be issued by a Parent Agent or by the authorized
  Human authority for a root milestone. Exposure is actor/capability-specific.
- `RecordVerificationEvidence` expresses the verifier's attribution of an
  observation to a criterion. P8 persistence is the application effect.
- `RequestDependencyMatch` is the reviewed name for the former
  `RequestDependencySatisfaction`. The model requests evaluation of an exact
  pair; the P7 matcher alone decides whether `DependencySatisfied` occurs.

The candidate language therefore has **15 ACTIVE canonical actions**. The
Human/Governance boundary contains controls that remain outside this language,
including `RecordDecision`, `SteerWork`, `CriticalSteer`, and `StopExecution`.

## Action-by-action governance decisions

| Candidate | Final category | Release status | Governance decision |
|---|---|---|---|
| `RespondToHuman` | `CANONICAL_AGENT_ACTION` | `ACTIVE` | Keep as a semantic response action; use ordinary P14 response text, not a second directive channel. |
| `InvokeTool` | `CANONICAL_AGENT_ACTION` | `ACTIVE` | Keep; model chooses capability and arguments, Runtime owns admission, safety, and reconciliation. |
| `AssignWork` | `CANONICAL_AGENT_ACTION` | `ACTIVE` | Keep; model can express objective/constraints/completion semantics for new or supplementary Work, while P1 owns IDs, revision, and command execution. |
| `Wait` | `CANONICAL_AGENT_ACTION` | `ACTIVE` | Keep; model chooses a real canonical condition, Runtime registers and wakes it. |
| `ClaimCompletion` | `CANONICAL_AGENT_ACTION` | `ACTIVE` | Keep; producer readiness is a distinct lifecycle boundary before verification. |
| `AcceptWorkOutcome` | `CANONICAL_AGENT_ACTION` | `ACTIVE` | Keep; Parent sufficiency is a semantic judgment, while exact binding and authority are Runtime-checked. |
| `RecordVerificationEvidence` | `CANONICAL_AGENT_ACTION` | `ACTIVE` | Keep; model selects evidence meaning/criterion attribution, Runtime persists the append-only record. |
| `ConcludeVerification` | `CANONICAL_AGENT_ACTION` | `ACTIVE` | Keep; model supplies criterion judgments, Runtime enforces evidence binding and deterministic aggregation. |
| `SendMessage` | `CANONICAL_AGENT_ACTION` | `ACTIVE` | Keep one identity with `Query`, `Reply`, `Report`, and `DecisionRequest` kinds. |
| `DeclareDependency` | `CANONICAL_AGENT_ACTION` | `ACTIVE` | Keep; model chooses producer binding and expected deliverable contract. |
| `ProduceDeliverable` | `CANONICAL_AGENT_ACTION` | `ACTIVE` | Keep; model chooses the formal result kind and artifact roles, Runtime binds source Work/revision. |
| `RequestDependencyMatch` | `CANONICAL_AGENT_ACTION` | `ACTIVE` | Keep as an exact-pair request. It never means “mark satisfied”; the matcher remains authoritative. |
| `Deliver` | `CANONICAL_AGENT_ACTION` | `ACTIVE` | Keep separate from ordinary `SendMessage`; it hands an existing Deliverable to the direct Parent and emits the distinct delivery wake. |
| `ProposeChildWorkspace` | `CANONICAL_AGENT_ACTION` | `ACTIVE` | Keep; durable responsibility formation differs from temporary specialist execution. |
| `SpawnSpecialist` | `CANONICAL_AGENT_ACTION` | `ACTIVE` | Keep; model chooses mission/constraints/skills, Runtime admits a temporary ExecutionBound specialist. |

## Boundary decisions

### Verification

`RecordVerificationEvidence` and `ConcludeVerification` are separate canonical
actions because they express different model intents and have different
durability and lifecycle effects:

- evidence attribution is append-only and criterion-bound;
- conclusion is an immutable Pass/Fail/Unknown judgment;
- P8 owns the command handlers, exact verifier authority, and deterministic
  aggregation.

The model does not directly choose evidence IDs, execution IDs, timestamps, or
storage provenance.

### Conversation

P14 freezes:

```text
SubmitHumanMessage
→ Coordination execution
→ final ModelOutput
→ SettleExecution(QueryCompleted)
→ bounded AssistantConversationTurn
```

`RespondToHuman` names this semantic effect for the action language. The
canonical output representation remains ordinary response text. A future
`agent-directive-v2` must not expose both free text and a second
`RespondToHuman` branch for the same response episode.

### Communication

`SendMessage(kind=Query|Reply|Report|DecisionRequest)` remains one canonical
action because all four use the same P6 `SendMessage → MessageSent → Inbox`
lifecycle and communication authority family. Kind-specific target,
correlation, and direction rules remain Runtime validation.

`Deliver` stays separate because its semantic target is an existing
Deliverable/direct Parent handover, with `ChildDelivered` wake semantics. A
provider compiler may split these representations later without changing the
canonical taxonomy.

### P7 dependency and delivery actions

- `ProduceDeliverable` creates the immutable formal result fact.
- `Deliver` performs the formal child-to-parent handover.
- `RequestDependencyMatch` submits an exact dependency/deliverable pair to the
  shared matcher.
- The coordinator's automatic `SatisfyDependency` path remains
  `RUNTIME_AUTOMATION`; it is not a second Agent action.

## Non-actions kept outside the language

These are not omissions from the 15-action result:

- `StartVerification`, `CompleteWork`, `RouteResultAndWake`,
  `EvaluateDependencySatisfaction`, `PersistIdleAndWait`,
  `EnforceNoBlindReplay`, and `AuthorizeAndAdmit` are Runtime automation.
- `RecordDecision`, `SteerWork`, `CriticalSteer`, and `StopExecution` are
  Human/Governance controls.
- readiness, stale/fresh classification, evidence sufficiency, repair choice,
  continuation strategy, and next-action selection remain reasoning that
  selects one explicit action.

## Evidence anchors

- P14 response boundary: `docs/design/implementation/P14/02-conversation-execution.md`
  §§1, 4 and `03-transcript-read-model.md` §1.
- P6 Message and formation boundaries:
  `docs/design/implementation/P6/02-communication-protocol.md` §§1–5 and
  `P6/01-formation-semantics.md` §§1–4.
- P7 command and matcher boundary:
  `docs/design/implementation/P7/01-dependency-deliverable-commands.md` §§1–4
  and `planning/results/P7.result.md` G2/G6.
- P8 verification boundary:
  `docs/design/implementation/P8/01-verification-commands.md` §§2–5 and
  `P8/04-evidence-binding.md` §§1–3.
- S1–S4 decision ownership:
  `planning/behavioral-eval/01-s1-decision-map.md` through
  `04-s4-decision-map.md`.
