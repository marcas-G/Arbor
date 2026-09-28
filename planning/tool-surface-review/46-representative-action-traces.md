# Representative Agent Action Traces

**Date:** 2026-09-27
**Baseline:** `HEAD 063d40d236ef73aa2f007d057f9f6d045512fc21`. All “current” statements refer to that baseline. Candidate B/C traces are architecture sketches only.

The traces compare the action boundary only. They do not define schemas, resume the four paused v2 field-source gaps, or authorize implementation.

## 1. ClaimCompletion

### Current A-shaped path

```text
Provider ToolCallProposed(arbor_directive, JSON {_tag: CompletionClaim, claim})
  → decodeTurn parses JSON and admits CompletionClaim
  → AgentDriver freshness check
  → AgentDriver returns Completed(CompletionClaimed(workRevision, claimRef))
  → P2 execution runtime settles through its existing settlement boundary
  → durable ExecutionSettled fact
  → verification consumer deterministically starts P8 Verification
```

Evidence:

- `packages/model-context/src/decode.ts:103-159`.
- `packages/agent-runtime/src/driver.ts:462-470`.
- P3 `03-agent-loop-driver.md:23-25,96-110`.
- `packages/application/src/verification-consumer.ts:158-220`.
- Tests: `tests/p3-driver.test.ts:290-322`; `apps/single-workspace/test/p5-completion-claim.test.ts:171-229`; `tests/p8-consumer-a.test.ts`.

The v1 claim payload supplies `claimRef` and `workRevision`; the driver does not replace those values with guesses. The durable completion consumer checks the referenced Work, project, lifecycle, and exact current revision before submitting `StartVerification`. The Work remains Open after a claim. Verification, Parent acceptance, and `CompleteWork` own later transitions; the model does not mark Work complete.

### Option B

```text
claim_completion tool call
  → per-tool codec validates the claim semantics
  → internal AgentAction.ClaimCompletion
  → shared Runtime binds the current execution context/control basis and applies common policy
  → completion settlement result
  → same P2 settlement and verification-consumer path
```

The internal action is transient. The persisted facts remain the Execution settlement and subsequent verification effects.

### Option C

```text
claim_completion tool call
  → typed ClaimCompletion handler + shared invocation context
  → handler requests the same typed completion settlement from the driver
  → same P2 settlement and verification-consumer path
```

No separate action union is required. A common driver settlement result remains necessary, but it describes Runtime control outcome rather than a unified model-action taxonomy.

## 2. SendMessage

### Current HEAD path and mismatch

```text
Provider ToolCallProposed(arbor_directive, Communicate { message.text })
  → decodeTurn
  → apps/single-workspace Communicate handler
  → Runtime Observation(message.text)
```

This handler does not submit `SendMessage`. That is contrary to frozen P6 `02-communication-protocol.md:98-114`, which specifies `Communicate(OutboundMessage) → SendMessage → MessageSent + Inbox admission/promotion/wake`.

The durable Application path exists independently:

```text
sendMessagePlan(semantic message + trusted bindings)
  → CommandGateway.SendMessage
  → authority/fingerprint/idempotency checks
  → MessageStore + MessageSent + recipient Inbox admission/promotion
  → bounded delivery observation
```

Evidence:

- Current observation-only handler: `apps/single-workspace/src/directives.ts:383-391`.
- Application command/factory: `packages/application/src/commands/send-message.ts:37-105,246-305`.
- Gateway checks and receipt reuse: `packages/application/src/gateway.ts:228-345`.
- Frozen communication semantics: P6 `02-communication-protocol.md:22-50,53-96,98-114`.
- Tests: `tests/p6-send-message.test.ts`, `tests/p6-acceptance.test.ts`, `tests/p6-inbox-promotion.test.ts`, `tests/p7-deliver-primitive.test.ts`.

The architectural options do not alter the downstream message rules:

### Option A

```text
model communication intent
  → canonical communication action
  → Runtime binds current sender/authority and handles content persistence
  → sendMessagePlan / SendMessage
  → MessageSent + Inbox effects
```

This requires a semantically complete canonical action. The current v1 `Communicate { message: { text } }` does not carry the frozen P6 `OutboundMessage` shape; this review records the mismatch without resolving its fields.

### Option B

```text
send_message tool
  → codec
  → internal AgentAction.SendMessage
  → common Runtime middleware + P6 communication handler
  → SendMessage command / durable Inbox effect
```

The provider tool call is translated into a local semantic action; the durable contract remains the Application command and P6 communication records.

### Option C

```text
send_message tool
  → typed communication handler + invocation context
  → SendMessage command / durable Inbox effect
```

The handler can call the existing Application command path directly. It still must use the same authority, body persistence, correlation, idempotency, and Inbox semantics; none should be delegated to a model-facing schema.

## 3. ProposeChildWorkspace

### Current A-shaped path

```text
Provider ToolCallProposed(arbor_directive, ProposeChildWorkspace)
  → decodeTurn checks JSON/tag allowlist
  → application handler validates ChildWorkspaceProposal shape and boundary ceiling
  → Runtime binds parent Workspace, principal, proposal/command IDs and time
  → first-layer proposal enters governance/human gate
      OR deep-layer path submits CreateChildWorkspace and optional AssignWork
  → bounded Runtime observation
```

Evidence:

- `apps/single-workspace/src/directives.ts:91-210`.
- Frozen distinction and transitions: P6 `01-formation-semantics.md:8-16,18-37,91-130`.
- Tests: `tests/p6-acceptance.test.ts:818-885`; `tests/p6-deep-formation.test.ts`.

This trace shows the separation between model proposal, Runtime-selected authority path, and Application commands. The current generic `spec: unknown` union field means payload correctness is deferred to the handler rather than enforced by `decodeTurn`.

### Option B

```text
propose_child_workspace tool
  → proposal codec
  → internal AgentAction.ProposeChildWorkspace
  → shared Runtime middleware
  → formation handler binds parent/authority/IDs and applies the frozen layer gate
  → same Application and governance path
```

### Option C

```text
propose_child_workspace tool
  → typed formation handler + trusted context
  → same layer gate and Application commands
```

Both B and C can reuse the existing formation handlers and Application boundary. A versioned full union is not needed for the deterministic deep-vs-first-layer routing.

## 4. RecordVerificationEvidence / ConcludeVerification

### Current HEAD state

The P8 Application commands and authority rules exist, but `AgentDirective` v1 has no `RecordVerificationEvidence` or `ConcludeVerification` branch, and the current `SliceDirectiveHandlers` list has no verifier handler. Thus the current production path is **not**:

```text
LLM output → verifier action handler
```

The implemented command paths are:

```text
authorized RecordVerificationEvidence command
  → P8 handler checks Open Verification + verifier authority
  → append-only evidence runtime record
  → no Domain event

authorized ConcludeVerification command
  → P8 handler checks evidence/criteria and deterministic verdict aggregation
  → one-Open conclusion commit
  → VerificationConcluded + relevant wake/release
```

Evidence:

- P8 frozen command rules: `docs/design/implementation/P8/01-verification-commands.md:36-48,65-80`.
- Application implementations: `packages/application/src/commands/conclude-verification.ts`, `makeRecordVerificationEvidenceHandler`, `makeConcludeVerificationHandler`.
- Verifier authority resolution: `packages/application/src/authority-resolver.ts`; `packages/application/src/commands/conclude-verification.ts`.
- Tests: `tests/p8-conclude.test.ts:252-319,383-429`; `tests/p8-acceptance.test.ts`; `tests/p11-verdict-consumer.test.ts`.

This review does not decide how the evidence observation handle or conclusion summary is represented. Those remain among the paused field-source questions.

### Option A

```text
future provider representation
  → versioned canonical verification branch
  → Agent Runtime
  → verifier-only P8 command with Runtime-bound verification/execution authority
```

The v2 contract design previously drafted those action names, but the current source-closure gate is not complete. This review does not count the draft as an implemented or ready branch.

### Option B

```text
record_verification_evidence / conclude_verification tool
  → codecs
  → internal AgentAction
  → verifier Runtime handler binds exact execution authority
  → existing P8 command
```

### Option C

```text
tool-specific verifier codec
  → typed verifier handler + exact Runtime context
  → existing P8 command
```

For both B and C, P8 remains the semantic authority. The model tool cannot bypass evidence validation, verdict aggregation, or the verifier-only boundary.

## Trace comparison

| Action | Current A path at HEAD | What B adds | What C keeps |
|---|---|---|---|
| ClaimCompletion | Working internal union branch; produces settlement and starts verification through durable consumer | Codec plus shared internal action middleware | Typed completion handler plus shared control-result protocol |
| SendMessage | `Communicate` currently returns Observation; P6 durable route is separate from this model path | Internal message action then common Runtime handling | Direct typed message handler |
| ProposeChildWorkspace | Union branch routes to application handler, which binds Runtime facts and applies formation gate | Internal action normalizes the model call before the same handler | Tool-specific handler calls the same Application path |
| Verification evidence/conclusion | P8 commands exist; model-facing union/handlers absent in HEAD | Internal action layer could host future verifier routing after source closure | Direct typed verifier tools could route to P8 after source closure |

Across all traces, durable effects belong to Application/Domain and Runtime facts come from trusted execution context. The deciding difference is whether Arbor retains a formal canonical output contract (A), a private common semantic action (B), or only per-tool handlers (C).
