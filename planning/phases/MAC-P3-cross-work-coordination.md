# MAC-P3 — Cross-Work Coordination and Deliverable Closure

## Authority and status

- Proposed authority: `planning/proposals/minimal-architecture-convergence-decision-draft.md`
- Depends on: MAC-P1 and MAC-P2 FORMALLY CLOSED.
- Reopens the existing Dependency/Deliverable implementation only after its complete model-facing
  lifecycle is accepted.

```text
Planning:        FROZEN / COMPLETE
Design:          ACCEPTED / LANDED
Implementation:  COMPLETE / FORMALLY CLOSED
Entry gate:      SATISFIED — MAC-P2 FORMALLY CLOSED; contract review Blocking = 0
```

Final evidence: `planning/results/MAC-P3.result.md`.

## Goal

Make cross-Work coordination real rather than table/command-complete:

```text
Consumer declares an exact expected result
→ producer receives/accepts responsibility for producing it
→ producer creates a formal Deliverable from versioned Artifacts
→ Deliver routes it to consumer
→ deterministic matcher satisfies or rejects the Dependency
→ exact wait clears
→ consumer integrates the result
```

No LLM decides structural satisfaction. No Message or Report is silently promoted into a formal
Deliverable.

## Scope

### Included

- review and minimalization of Dependency/Deliverable vocabulary already in Domain;
- model-facing actions for declare, produce and deliver;
- producer routing/admission and explicit inability/rejection path;
- deterministic match and SatisfyDependency consumer;
- exact wait registration/clear with lost-wake prevention;
- typed Deliverable artifact roles and source Work revision;
- delivery to Workspace Inbox/Work cognition with provenance;
- Withdrawn/Unfulfillable/producer-loss behavior;
- deadlock detection and bounded Attention;
- restart/replay, migration compatibility and real-provider scenarios.

### Excluded

- semantic similarity matcher;
- arbitrary query DSL, regex or model-defined satisfaction predicate;
- automatic quality PASS from structural match;
- sibling governance or write permission;
- direct Session-to-Session chat as authority;
- subagent runtime;
- general workflow engine or visual BPMN/Kanban system.

## Minimal semantics

### Dependency

```text
consumer Work requires ExpectedDeliverable
producer binding = AnyProducer | WorkspaceBound | WorkBound
state = Unsatisfied | Satisfied | Withdrawn | Unfulfillable
```

### Deliverable

```text
formal result fact
source Work + exact WorkRevision
kind
versioned Artifact bindings with semantic roles
```

### Message

```text
communication only
```

### Deliver

```text
delivery of an existing formal Deliverable
```

The four concepts are retained only because they own different invariants. If an implementation
path does not require those distinctions, it must not introduce another wrapper entity.

## Model-facing actions

```text
declare_dependency(expected, producer?)
produce_deliverable(kind, artifactRefsWithRoles)
deliver(deliverableRef, recipientRef)
withdraw_dependency(dependencyRef, reason)        # only when authorized
mark_unfulfillable(dependencyRef, evidence)        # owning policy/authority only
```

Runtime binds Work/Workspace IDs, revisions, authority, source Artifact versions, correlation and
causation. Model refs are scoped opaque refs; raw canonical IDs are not trusted arguments.

`satisfy_dependency` is not a model-facing action. It is a deterministic consumer result.

## Producer admission

A Dependency targeting a producer does not silently assign new Work. The producer side must resolve
one of:

```text
existing Open Work already owns the requirement
authorized new Work is assigned
request is rejected/needs clarification
producer is unavailable → Unfulfillable/Attention path
```

This resolution is durable and visible. Message arrival alone does not mean accepted responsibility.

## Wait and wake

- `wait` binds exact DependencyId + observed revision;
- wait registration rechecks the dependency in the same reliable boundary to prevent lost wake-up;
- DeliverableProduced triggers candidate matching but not quality judgment;
- Satisfied clears only the matching wait; unrelated Inbox traffic cannot impersonate satisfaction;
- Work may continue independent Plan items while one Dependency remains unsatisfied;
- no runnable alternative plus a dependency cycle produces Deadlock Attention.

## Quality boundary

```text
structural match  = correct producer/kind/roles
Verification      = result quality/evidence
Parent cognition  = result sufficiency for higher-level outcome
```

These remain separate. A matched Deliverable may still fail Verification or be insufficient to the
consumer.

## Dependency graph

```text
MAC3-001 Contract minimization and action schemas
   ├─ MAC3-002 Producer admission/routing
   └─ MAC3-003 ProduceDeliverable + Artifact binding

MAC3-002 + MAC3-003
   └─ MAC3-004 Deliver + Inbox/Work cognition

MAC3-001 + MAC3-004
   └─ MAC3-005 Deterministic matcher + SatisfyDependency

MAC3-005
   ├─ MAC3-006 Exact wait/wake/lost-wake proof
   └─ MAC3-007 Withdraw/Unfulfillable/producer-loss/deadlock

MAC3-001..007
   └─ MAC3-008 Recovery, migration, real-provider and phase closure
```

## Task contracts

| ID | Deliverable | Required proof |
|---|---|---|
| MAC3-001 | minimal ADTs and scoped action schemas | no duplicate wrapper concept; runtime-bound identities |
| MAC3-002 | request reaches producer and receives durable disposition | arrival ≠ acceptance; busy producer does not lose request |
| MAC3-003 | agent can create exact formal Deliverable | source revision and artifact roles immutable; stale artifact rejected |
| MAC3-004 | exact delivery to consumer | message/report cannot impersonate Deliverable; dedup/replay proof |
| MAC3-005 | deterministic satisfaction consumer | positive/negative producer-kind-role matrix; no model call |
| MAC3-006 | exact wait and wake | same-boundary recheck; unrelated wake ignored; no polling |
| MAC3-007 | terminal and deadlock paths | Withdrawn/Unfulfillable typed; cycle attention; no silent forever-wait |
| MAC3-008 | end-to-end closure | restart every boundary, real provider, projection/Web, `pnpm check` |

## Test matrix

1. AnyProducer + correct kind/roles satisfies;
2. WorkspaceBound from wrong Workspace does not satisfy;
3. WorkBound from another Work does not satisfy;
4. correct producer but missing role does not satisfy;
5. old Work revision Deliverable does not satisfy a revised requirement;
6. Report text naming the expected kind does not satisfy;
7. duplicate Produce/Deliver event remains one Deliverable/admission;
8. restart after Produce before Deliver resumes exact delivery;
9. restart after Deliver before satisfaction resumes exact matcher;
10. satisfaction racing wait registration cannot produce lost wake;
11. unrelated InboxAdvanced does not clear exact Dependency wait;
12. producer rejects/retired/cancelled transitions to governed Unfulfillable path;
13. cycle with alternative runnable Work is not premature deadlock;
14. closed cycle with no runnable work produces one Attention;
15. structural satisfaction does not create Verification PASS or Acceptance.

## Migration and compatibility

- existing dependency/deliverable rows are preserved;
- existing command handlers may be reused only after exact action-source fields are frozen;
- backfill may bind deterministic derived refs from canonical columns, never from Message text;
- incomplete historical rows remain compatibility evidence or governed Attention;
- model-facing `declare_dependency` remains hidden until produce/deliver/satisfy/wake path is ready
  in the same release;
- no partial rollout that lets agents create new unsatisfiable dependencies.

## Real-provider qualification

Use at least these semantic cases:

- consumer asks a known producer for a typed report Artifact;
- producer produces and delivers correct roles;
- producer returns wrong kind/role and model receives useful typed rejection;
- consumer keeps doing independent work while waiting;
- dependency becomes unfulfillable and Agent selects an alternative/escalates honestly;
- duplicate/restart run produces identical canonical effects.

## Exit criteria

1. A real agent can declare, produce and deliver through advertised actions.
2. Producer responsibility acceptance is explicit and durable.
3. Structural matcher is deterministic and the sole satisfaction authority.
4. Wait/wake is exact, polling-free and lost-wake safe.
5. Message, Deliverable, Dependency and Verification retain separate semantics.
6. terminal impossible dependencies do not wait silently forever.
7. all fifteen test cases, fault injection, real-provider matrix and `pnpm check` pass.
8. no subagent capability is required.

## Stop conditions

- satisfaction requires reading arbitrary prose or semantic similarity;
- producer assignment authority cannot be bound exactly;
- formal result cannot bind immutable source Work/Artifact versions;
- wait correctness depends on polling or UI state;
- compatibility requires guessing missing identities from historical text;
- the model-facing surface would expose declare without a complete delivery path.
