# S4-CONTEXT-DG-01 — AssistantMessage omitted from subsequent WorkspaceWork context

Status: **OPEN — manual owner clarification required**
Discovered against candidate: `4de305bb6e81f98688f40d98e817d5b4d7da19b4`
Evidence: [S4 Work AssistantMessage context diagnostic](../results/s4-work-assistant-message-context-diagnostic.result.md)
Governance draft: [Option A proposal](../proposals/S4-CONTEXT-DG-01-assistant-message-projection-governance-draft.md) (unaccepted)

## Question

When a WorkspaceWork ProviderTurn completes with `finishReason=Stop`, non-empty
plain text and no ToolInvocations, should a later ProviderTurn in the same
Execution receive that persisted `AssistantMessage` as a provider-neutral
`Message(role="assistant")` / DataOnly C3 history item? Or is omitting it
intentional, in which case what frozen rule prevents/reconciles repeated
same-context sampling after the no-action result?

The current frozen owner text is suggestive but does not completely settle the
projection rule. DID §9.8 and the v1.50 AH19/P2 eligible SessionItem set name
`AssistantMessage`. P3 `02` accepts portable assistant messages as input and
classifies them as `AuthenticatedAgent`/DataOnly C3 history. The existing P3
`projectSessionTimeline` has no `AssistantMessage` projection branch. The
owner must decide the intended projection and no-action continuation semantics;
implementation/tests must not silently choose a new semantic rule.

## Reproduction evidence

The model-light diagnostic creates the same typed sourced `AssistantMessage`
that the P3 output journal appends after a completed ProviderTurn, then invokes
the existing P3 projector on the Session frontier. The frontier advances from
sequence 1 to 2, but `inputItems`, source `contextRefs`, and the diagnostic hash
of projected input remain identical. The skipped test records assistant-role
projection as a candidate behavior pending owner decision, not as an accepted
contract assertion.

The same test shows that appending a sourced ToolCall followed by either a
ControlResult or ToolResult changes projected input and its diagnostic hash.
This distinguishes the missing assistant projection from a test fingerprint
that simply ignores all Session-result changes. The historical S4-B result
also independently records identical message-array fingerprints for steps
10–25 after multiple persisted AssistantMessages; the test Capture hook stores
the parsed full request body, although the short diagnostic hash specifically
fingerprints only `request.messages` and says nothing about tool definitions or
other manifest fields.

The test also compiles the projected rows with the existing pure `compileTurn`
function. After AssistantMessage only, the complete provider-neutral
`PortableModelRequest` and its `compiledRequestHash` are equal even though the
Manifest's Session frontier and ProviderTurnId advance. Adding either a
ControlResult or ToolResult changes the request input and `compiledRequestHash`.
The repeated message-array fingerprint is therefore not an artifact of hashing
a field that omitted a real projected assistant item; the current projection
supplies no such item.

Separately, `completeAgentLoopStep` receives a WorkspaceWork output with
`Stop`, text and zero tool invocations and returns `Continue`, persisting
`StepEffectsCommitted → NextStepReady` and one successor step in the same
Execution. It is not an infinite loop: `MAX_TURNS` is 24, and the last
no-action step does not create a successor; the outer driver exits its loop
with `Failed("max turns reached")`. Thus the supported claim is repeated
unchanged projected input with bounded step advancement, not unbounded
advancement or a process hang.

## Owners and required resolution

- P2 owns the durable Session timeline and selected frontier.
- P3 owns `AssistantMessage` → `PortableInputItem` projection, C3 history,
  and AgentLoop no-action continuation behavior.
- P12 RuntimeSafety provides finite progress limits but does not decide what
  cognitive history a WorkspaceWork Provider request must contain.

Before changing production code, manual governance should either:

1. confirm that a completed WorkspaceWork AssistantMessage is projected as an
   assistant-role DataOnly C3 item on subsequent turns, while preserving the
   existing frontier, compression, and source-binding rules; or
2. explicitly confirm that it is not projected and define the intended
   no-action/Stop continuation behavior so identical-input retries do not
   become the accidental progress mechanism.

Until resolved, the diagnostic expectation remains skipped/pending. No
production code, frozen design, real Provider, daemon, or user database was
changed or used for this reproduction.
