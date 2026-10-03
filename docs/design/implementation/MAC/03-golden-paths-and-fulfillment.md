# MAC — Golden Paths and Durable Fulfillment

## 1. Ordered delivery

MAC changes are delivered in four sequential product phases:

```text
MAC-P1 single Workspace correctness
→ MAC-P2 long-term responsibility formation/acceptance
→ MAC-P3 cross-Work dependency/deliverable closure
→ MAC-P4 optional runtime subagent + final physical convergence
```

No later phase is required to make an earlier phase correct.

## 2. MAC-P1 golden path

```text
Human goal
→ RootConversation: text or assign_work(current)
→ exact approval when policy requires
→ Open Work
→ WorkEpisode
→ LocalPlan + executable actions
→ CompletionClaim
→ independent Verification
→ exact root Acceptance (Human or explicit Project policy)
→ CompleteWork
→ user-visible accepted result
```

Root has no synthetic Parent Agent. PASS does not imply Acceptance. FAIL returns
evidence to the same Open Work; UNKNOWN remains first class.

## 3. MAC-P2 long-term responsibility path

```text
Goal placement context
→ current root | existing Active Direct Child | proposed new Child
→ exact formation governance when new
→ asynchronous Formation fulfillment
→ child initial Work
→ child result + Verification
→ Direct Parent Agent accept_result or request additional Work
→ child Work complete
```

Users approve concrete organization/permission changes; they are not asked to
choose internal nouns. A new Workspace requires durable reusable responsibility,
not mere task size or parallel opportunity.

## 4. MAC-P3 cross-Work path

```text
DeclareDependency
→ producer durable disposition
→ ProduceDeliverable from exact Work/Artifact versions
→ Deliver
→ deterministic producer/kind/role match
→ SatisfyDependency
→ exact wait clear/wake
→ consumer cognition/integration
```

`declare_dependency` is hidden for new model turns until the entire production,
delivery, satisfaction and wake path ships together. Message ≠ Deliverable;
structural match ≠ Verification; PASS ≠ Parent sufficiency.

## 5. MAC-P4 optional subagent path

```text
Work main Agent
→ spawn_agent with bounded brief/tool profile
→ child Execution
→ list/message/follow-up/wait/interrupt
→ AgentResult to exact parent Execution mailbox
→ parent integrates result
```

Disabled mode preserves identical correctness. If real qualification cannot
show benefit greater than complexity/cost, the capability remains disabled or
is removed.

## 6. Durable fulfillment rule

Every asynchronously applied decision has separate truths:

```text
Decision state != Application fulfillment state != Result state
```

At minimum, fulfillment represents pending application, partial canonical
effects, applied, retryable operational delay and typed terminal block. It is
derived from exact canonical identities/events plus durable consumer state,
never from UI inference, memory callback or logs.

Formation is the first mandatory implementation. The same rule governs action
approval resume, verifier spawn, completion consumer and future AgentResult
delivery.

## 7. Phase gates

- MAC-P1 is implementation-authorized by the accepted MAC token after design
  landing consistency passes.
- MAC-P2 begins only after MAC-P1 formal closure and its accepted exact phase
  contracts.
- MAC-P3 begins only after MAC-P2 formal closure.
- MAC-P4 begins only after MAC-P3 formal closure plus explicit authorization
  to add optional parallelism/final physical convergence.
