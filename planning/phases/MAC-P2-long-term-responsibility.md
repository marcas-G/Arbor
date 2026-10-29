# MAC-P2 — Long-Term Responsibility and Child Workspace Closure

## Authority and status

- Proposed authority: `planning/proposals/minimal-architecture-convergence-decision-draft.md`
- Depends on: `planning/phases/MAC-P1-single-workspace-golden-path.md`
- Absorbs the valid parts of RGI-DG-01 and Formation fulfillment findings.

```text
Planning:        FROZEN / COMPLETE
Design:          ACCEPTED / LANDED
Implementation:  COMPLETE / FORMALLY CLOSED
Entry gate:      SATISFIED — MAC-P1 FORMALLY CLOSED
```

Final evidence: `planning/results/MAC-P2.result.md`.

## Goal

Extend the proven single-Workspace path to durable responsibility placement without making the user
understand Arbor internals:

```text
Human goal
→ Agent inspects current root, active direct children and in-flight formations
→ current | existing child | proposed new child
→ exact governance/authorization
→ target Work starts
→ result is verified
→ Parent Agent accepts ordinary child outcome
→ child Work completes
```

Workspace formation is justified only by durable responsibility. It is not a parallelism primitive,
Plan expansion mechanism or substitute for a bounded Work.

## Scope

### Included

- WorkspacePlacementContext and progressive canonical inspection;
- model decision rules for current/existing/new responsibility placement;
- RootConversation action surface for exact placement outcomes;
- formation proposal with initial Work;
- human first-layer approve/modify/reject;
- durable FormationFulfillmentProjection;
- deterministic CreateChildWorkspace + AssignWork chain;
- child bootstrap from accepted canonical facts;
- parent capability/resource ceiling and permission posture preview;
- Parent Agent `accept_result` for exact direct-child Work result;
- result delivery to Parent Workspace cognition without Session authority escalation;
- duplicate/in-flight placement prevention;
- restart/replay and real-provider qualification.

### Excluded

- arbitrary reparent/move of Workspace;
- sibling governance;
- automatic standing PermissionGrant creation not shown in proposal;
- cross-Work Dependency/Deliverable graph;
- runtime subagent parallelism;
- creating Workspace merely because a task is large or complex;
- arbitrary descendant assignment from Root; target is current or Active Direct Child.

## Placement decision

The model receives a bounded, canonical snapshot:

```text
current Workspace responsibility/boundary/open-work summary
Active Direct Children responsibility/status/open-work summaries
Pending/Approved-not-Applied Formation summaries
hard constraints and authority ceiling
snapshot fingerprint/cursor
```

Large sets use scoped read-only inspection actions:

```text
list_workspaces(cursor?, query?)
read_workspace(ref, workCursor?)
```

No Session transcript, Secret, raw database ID or arbitrary descendant is exposed.

Decision order:

1. respect an explicit valid user target;
2. detect existing Open Work or in-flight Formation covering the goal;
3. prefer current/existing responsibility when it naturally owns the result;
4. propose new Workspace only for durable, reusable, independently governable responsibility;
5. ask only for ambiguity that changes outcome/boundary/acceptance—not “Workspace or Work?”.

## Formation fulfillment

Governance and application are separate:

```text
Governance:  Pending | Approved | Rejected
Fulfillment: AwaitingDecision
           | PendingApplication
           | WorkspaceCreated
           | Applied
           | Blocked(typed reason)
```

`Approved` does not mean child created. `Applied` means child exists and, when required, the exact
initial WorkAssigned fact exists. Projection identity binds proposalId + proposalRevision +
deterministic child/work IDs.

Retryable infrastructure failure remains PendingApplication with durable attempt metadata. A
non-retryable typed precondition becomes Blocked and produces Attention.

## Parent Acceptance

Child Verification PASS becomes an exact input to its Direct Parent. Parent Agent may call:

```text
accept_result(resultRef)
```

Runtime binds child WorkId, target WorkRevision, VerificationId, parent Workspace authority and
current ControlBasis. The model cannot supply or switch those canonical identities.

Parent may instead request additional Work. Verification PASS remains true even if Parent decides
the result is insufficient for the parent-level goal.

Root has no Parent Agent; root acceptance remains Human/policy as established in MAC-P1.

## Dependency graph

```text
MAC2-001 Placement contract/context
   ├─ MAC2-002 Canonical list/read inspection
   └─ MAC2-003 Placement prompt/evaluation

MAC2-001
   └─ MAC2-004 Formation governance + fulfillment projection

MAC2-002 + MAC2-003 + MAC2-004
   └─ MAC2-005 Create child + initial Work + bootstrap

MAC2-005
   └─ MAC2-006 Child result delivery + Parent accept_result

MAC2-001..006
   └─ MAC2-007 Recovery, Web projection, live qualification and closure
```

## Task contracts

| ID | Deliverable | Required proof |
|---|---|---|
| MAC2-001 | PlacementContext ADT, provenance, fingerprint and budget | canonical-only sources; exact target binding; no silent truncation |
| MAC2-002 | scoped list/read query actions | direct-child-only, cursor/ref scope, stale/foreign/retired fail-closed |
| MAC2-003 | versioned placement behavior | one-off/current, existing-child, new-responsibility and ambiguity eval matrix |
| MAC2-004 | durable formation governance/application separation | every state transition/restart; Approved never rendered Applied |
| MAC2-005 | deterministic child + initial Work + bootstrap | replay-safe IDs; boundary ceiling; initial constraints/mission unchanged |
| MAC2-006 | exact result routing and Parent Agent acceptance | no human babysitting for ordinary child; PASS ≠ acceptance |
| MAC2-007 | end-to-end closure | Queue/Web truth, migration, fault injection, real provider, `pnpm check` |

## Behavioral matrix

| ID | Input situation | Required decision |
|---|---|---|
| P1 | one bounded root responsibility task | assign current Work |
| P2 | matching Active Direct Child | assign existing child |
| P3 | matching child has equivalent Open Work | report existing state; no duplicate |
| P4 | matching Formation Pending/Approved-not-Applied | report/wait existing proposal; no duplicate |
| P5 | genuinely durable new responsibility | propose child with initialWork |
| P6 | complex but temporary task | no child; bounded Work |
| P7 | insufficient outcome/boundary information | ask one minimal clarification |
| P8 | user explicitly forbids new Workspace | obey and use valid existing scope or explain impossibility |
| P9 | user explicitly requests long-lived responsibility | propose exact readable structure, not external-platform questions |
| P10 | proposal rejected | no child, no root fallback Work unless newly authorized |

## Mechanical matrix

1. stale placement snapshot cannot target moved/retired/foreign Workspace;
2. exact proposal revision is required for approve/modify/reject;
3. approve replay creates one child and one initial Work;
4. restart after child create but before Work assign resumes exact Work;
5. resource/capability ceiling cannot expand parent rights;
6. no hidden standing grants appear during formation;
7. child bootstrap contains only accepted Responsibility/Boundary/initialWork/rationale/project
   instructions with correct trust labels;
8. result delivery deduplicates and binds exact child Work revision;
9. Parent accept replay produces one Acceptance/CompleteWork chain;
10. Parent rejection/additional-work decision does not mutate Verification PASS.

## Web and user language

- never show raw IDs as primary labels;
- proposal preview shows: name, durable responsibility, boundary, initial Work, constraints,
  permission posture and rationale;
- Queue distinguishes “等待批准”“已批准待应用”“已创建待分配”“已应用”“应用受阻”；
- Workspace tree only shows canonical child after WorkspaceCreated;
- Work only appears under child after WorkAssigned;
- no Specialist/subagent node appears in the responsibility tree.

## Migration and recovery

- add fulfillment storage/projection only after accepted exact contract;
- backfill current Pending/Approved/Rejected proposals without inferring success from state text;
- determine Applied only from deterministic derived IDs and canonical WorkspaceCreated/WorkAssigned;
- unprovable historical Approved rows become PendingApplication/Blocked for governed review, never
  guessed Applied;
- wake same root conversation surface through a successor episode; never resurrect settled
  Execution;
- migration re-entry, consumer replay and database restart are mandatory.

## Exit criteria

1. User states a goal without choosing internal structure; Agent chooses a valid placement.
2. Existing responsibility and in-flight work/proposal are preferred over duplicates.
3. Formation approval and fulfillment are separately observable and recoverable.
4. Approved proposal creates exactly one child and exact initial Work after asynchronous recovery.
5. Child inherits only a reduced capability/resource ceiling.
6. Child result reaches Parent and can be accepted by Parent Agent without routine human action.
7. Root acceptance remains human/policy; no synthetic parent exists.
8. Placement behavior matrix P1–P10 is stable with real provider.
9. All mechanical restart/replay tests and `pnpm check` pass.
10. No Dependency/Deliverable or subagent capability is required for closure.

## Stop conditions

- placement requires semantic inference from raw Session history as authority;
- target identity cannot be runtime-bound from a scoped ref;
- formation requires hidden permission elevation;
- Application cannot distinguish governance decision from applied effect;
- Parent Acceptance cannot bind exact child result revision;
- the same blocking formation state repeats across three goal turns without a governed disposition.
