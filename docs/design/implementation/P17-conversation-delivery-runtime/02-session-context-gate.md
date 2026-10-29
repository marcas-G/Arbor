# P17 — 02 Session Context Gate

## 1. Contract

```ts
type SessionProjectionDecision =
  | { readonly _tag: "Ready"; readonly projection: SessionTimelineProjection }
  | {
      readonly _tag: "Blocked";
      readonly reason: "UnresolvedInvocation" | "ContradictoryTimeline";
      readonly callRefs: ReadonlyArray<string>;
      readonly closedFrontier: SessionFrontier;
    };
```

`projectSessionTimeline` is replaced by `decideSessionProjection`. It never
returns a Provider-ready request containing an unresolved call.

## 2. Causal-closure algorithm

For the selected epoch/frontier:

1. Validate sequence monotonicity and unique sourced entry identity.
2. Record every ToolCall by stable callRef and its route identity.
3. Require exactly one later ToolResult or ControlResult with the same callRef.
4. Reject result-before-call, duplicate call, duplicate result, route-kind
   mismatch or contradictory terminal status as `ContradictoryTimeline`.
5. If any call lacks a result, return `Blocked(UnresolvedInvocation)` with the
   maximal closed frontier ending before the unresolved call.
6. Only `Ready` may be compiled into an Inference request.

Parallel calls may settle out of order; pairing is by callRef, not adjacency.
Every call in one provider output must be terminal before the next inference.

## 3. Reconciliation-before-inference

```ts
interface InvocationReconcilerPort {
  reconcile(input: {
    sessionId: SessionId;
    executionId: ExecutionId;
    callRefs: ReadonlyArray<string>;
    frontier: SessionFrontier;
  }): Effect<
    | { _tag: "Repaired" }
    | { _tag: "Awaiting"; refs: ReadonlyArray<string> }
    | { _tag: "OutcomeUnknown"; refs: ReadonlyArray<string> },
    ReconciliationError
  >;
}
```

The reconciler reads AgentLoopStep action records, ToolInvocation settlement
and canonical command receipts. It may idempotently append a missing sourced
result when the real disposition is already proven. It never infers authority
or result from Session text.

- Repaired → re-project the same frontier, without a Provider request.
- Awaiting → keep the same Attempt/Execution paused and durably wake on the
  reconciliation source.
- OutcomeUnknown → Job NeedsAttention(ReconciliationRequired); no auto retry.

## 4. Adapter gate

`validatePortableToolPairing` adds `DanglingToolCall`. Every Inference adapter
must validate complete pairing immediately before sending Provider bytes. This
is a second fail-closed boundary, not the primary recovery mechanism.

## 5. One continuation truth

Typed Session projection is the portable authority for request items.
ProviderNative continuation may replace a bounded historical segment only when
the current ResolvedModelBinding fingerprint matches its checkpoint. A request
must never contain both the replaced portable items and the native continuation
for the same frontier.

The manifest records continuation implementation, covered frontier and binding
fingerprint. Mismatch falls back to portable rebuild; ambiguity blocks.
