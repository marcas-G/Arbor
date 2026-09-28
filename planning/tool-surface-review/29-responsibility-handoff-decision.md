# ResponsibilityHandoff Decision

**Date:** 2026-09-27
**Status:** Explicitly deferred; no new action or contract added

## Finding

S2 DP20 and S4 DP49 require the model to distinguish:

- a continuation of the current long-lived responsibility;
- a genuinely new responsibility; and
- a formal transfer of ownership when the old owner should retire or a
  successor should take over.

The first two judgments are expressible today:

- continue current Work/Workspace;
- use `ProposeChildWorkspace` for a newly governed child responsibility;
- use `SendMessage(kind=DecisionRequest)` when a Parent ruling is needed.

The third is not expressible without inventing lifecycle semantics.

## Frozen-contract check

The current contracts do not freeze a complete handoff protocol containing all
of the following:

| Required semantic | Current status |
|---|---|
| successor Workspace or responsibility identity | Not frozen |
| transfer event and durable handoff state | Not frozen |
| old Workspace retirement/closure relation | Not frozen |
| authority transfer and effective revision | Not frozen |
| active Work/dependency/artifact rebinding | Not frozen |
| in-flight execution and Session treatment | Not frozen |
| rollback/rejection/replay rules | Not frozen |

P6 explicitly states that it does not own Successor/Retire semantics
(`docs/design/implementation/P6/01-formation-semantics.md` §5 and
`P6/03-authority-delegation.md` §3/§5). P11 retirement and ownership contracts
enforce preconditions around existing ownership; they do not define a complete
Agent-requested transfer protocol.

## Decision

`ResponsibilityHandoff` is a **DEFERRED capability**, not an ACTIVE canonical
Agent Action in the current release and not a hidden alias for another action.

It is not classified as `NOT_AGENT_ACTION`: a future handoff may contain a real
model semantic intent. Its current status is deferred because the downstream
governance protocol is absent, not because the intent is merely reasoning.

No default mapping is allowed:

- `ProposeChildWorkspace` does not retire or transfer the current owner;
- `AssignWork` does not transfer responsibility ownership;
- `SendMessage` does not alter the tree;
- `SteerWork` does not change Workspace parentage or authority;
- `SpawnSpecialist` creates only a temporary ExecutionBound role.

## Release impact

The current release may support:

1. continuation of an existing responsibility;
2. a new governed child responsibility;
3. a Parent decision request about an ownership question.

It may not claim to complete a durable successor/retire handoff. Therefore:

```ini
responsibility_handoff = DEFERRED
active_release_unexpressible_required_intent = NONE
full_s1_s4_handoff_coverage = DEFERRED
```

If a future release makes handoff a supported capability, governance must first
freeze the successor, transfer, retirement, authority, rebinding, and recovery
contracts. Only then can a canonical action be named and evaluated.

## Design status

This decision closes the ambiguity about the current release: the gap is
explicitly isolated and does not block a scoped action-language review. It does
block any claim that the current language covers the full unqualified S1–S4
handoff behavior.
