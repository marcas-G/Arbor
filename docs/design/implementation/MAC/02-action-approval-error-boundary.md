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
Pending | Approved | Rejected | Consumed | Expired
```

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
