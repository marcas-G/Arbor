# MAC — Action, Approval and Typed Error Boundary

## 1. One model-facing action protocol

Every model effect request is a typed tool/action invocation resolved through
one recorded turn profile:

```text
Model ActionCall
→ exact registered identity/version/hash/model name
→ purpose applicability and visibility
→ authorization / optional exact approval
→ route-specific handler
→ typed ActionResult
```

Routes remain internal:

```text
ExternalExecutable
InternalControl
Subagent (optional after MAC-P4 authorization)
```

Route distinction may change side-effect settlement, sandboxing and handler
requirements. It does not create separate model output protocols or allow a
provider function name to become an authority key.

## 2. Authorization order

```text
registered and purpose-visible
→ subject/capability/target/policy authority
→ exact approval when required
→ ResourceBoundary/Ownership/Sandbox/freshness/fence checks
→ handler effect
```

Visibility never grants authority. Approval never widens standing capability,
ResourceBoundary, ownership or sandbox.

## 3. ActionApproval semantic contract

Executable and internal-control exact approvals share one semantic lifecycle:

```text
Pending | Approved | Rejected | Consumed | Expired | Cancelled
```

The only state transitions are:

```text
Pending(r)  → Approved(r+1) | Rejected(r+1) | Expired(r+1) | Cancelled(r+1)
Approved(r) → Consumed(r+1) | Expired(r+1) | Cancelled(r+1)
Rejected / Expired / Consumed / Cancelled are terminal
```

`Consumed` is written by the exact route's effect/command claim transaction.
`Cancelled` is a Runtime closure (for this package, authorized StopExecution)
and is distinct from a human Reject or time Expire; it preserves any prior
human Approve decision provenance.

The durable intent binds:

```text
authenticated subject
stable action identity/version
normalized argument/action digest
target canonical resources
ControlBasis/freshness revisions
route kind and side-effect semantics
expiry
single-consumption revision
```

For an Executable approval, the binding additionally includes the Runtime-owned
Execution, AgentLoopStep identity, LogicalActionId, callRef and exact
ToolInvocationId. `expiresAt` is the TTL selected by the first successful
Pending commit, not part of the stable binding comparison: concurrent/replay
issuers with the same stable binding read and reuse the committed ApprovalId,
expiry and revision; a different stable field fails closed. A different
LogicalActionId may request the same semantic tool action within one
Execution.

`ApprovalRequired` is a typed nonterminal ActionResult/Execution pause. The
same Execution/AgentLoopStep/action remains Pending and no P4 terminal
`Denied(ApprovalRequired)` is written for a new request. Human Approve/Reject,
Runtime Expire, or Stop cancellation resolves the exact row/revision and wakes
the same action. P4 rechecks authority and consumes only the exact Approved
revision in the fenced claim. Reject/Expire then close the action with a typed
no-effect result; Stop uses Interrupted/quiescence semantics.

`Denied(ApprovalRequired)` written by older P4 runtimes remains terminal
read/replay evidence only. It is never migrated to Pending or resumed as a
new approval request. `Cancelled` is distinct from human Reject and TTL Expire;
it records Runtime cancellation provenance while preserving any earlier human
Approve decision. The status transition and state/decision/consumption DDL
constraints are route-neutral, but the `Executable` and `Control` request,
decision, inbox keys and claim transactions stay strictly route-specific.

Standing PermissionGrant remains independent and revocable. Physical merger of
`invocation_approvals` and `control_action_approvals` is MAC-P4 final
convergence work; before that, one semantic port may adapt both stores without
steady-state dual write. Any unprovable migrated binding fails closed.

## 4. Typed ActionResult

Model-usable outcomes distinguish:

```text
Success observation/result
Semantic rejection with correction
ApprovalRequired pause
Retryable operational interruption
Terminal operational failure/attention
OutcomeUnknown with reconciliation requirement
```

Native errors, secrets and unbounded logs never enter model context. Useful
typed failure information does.

## 5. Effect contract

Application, consumer and recovery boundaries must expose narrow typed error
unions. Repository/transport failures may not be collapsed into `unknown`,
`Error`, unconditional `orDie` or console-only diagnostics.

`orDie` is legal only when an invariant proves the failure impossible at that
exact boundary and an executable test demonstrates the proof. An asynchronous
consumer failure must become durable retry eligibility, typed Blocked/Attention
or OutcomeUnknown—not a lost log line.

## 6. Legacy isolation

Historical directive/message/focus/provider formats remain readable through
migration/archive/recovery adapters. They are never advertised in a new turn,
never selected by active new-write branches and never reconstructed by parsing
free text. MAC-P4 owns physical/source removal after equivalent-fixture proof.
