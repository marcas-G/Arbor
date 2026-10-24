# S4-CONTEXT-DG-01 governance acceptance and owner landing

**Decision date:** 2026-10-24
**Accepted token:** `ACCEPT_S4_CONTEXT_DG_01_ASSISTANT_MESSAGE_PROJECTION_OPTION_A`
**Decision:** ACCEPTED for the exact Option A semantic landing below.
**Production implementation authorization:** NOT GRANTED.
**Real Provider/daemon qualification authorization:** NOT GRANTED.

## Fixed package identity

This acceptance applies to the fixed governance package from candidate
`a2fe27a099854493a0bd71af5354040276801df6`:

- Proposal committed-content SHA-256:
  `B03BDB36C72714E6BCBBEE61364E3E0431C95F342012B6D6B99F16ABB8329A70`
- Package-manifest committed-content SHA-256:
  `CB2B1AF86617B8AFBEC6E4F1E4017BB024C62805337D7B3A8AC48C18C2EEAA20`
- Manifest: `planning/proposals/S4-CONTEXT-DG-01-assistant-message-projection-package.sha256`
- Accepted proposal token recorded above; prior proposal/package identities
  superseded by the fixed manifest are not accepted by this record.

Hashes identify committed Git content, not Windows checkout bytes;
`core.autocrlf` may produce different raw checkout hashes. The fixed manifest's
listed hashes and source commit are the identity check.

## Accepted semantic decision

For subsequent Provider contexts consuming the same Responsibility-bound
Workspace Session, an accepted and exactly sourced `AssistantMessage` is
projected in Session sequence order as a role=`assistant`, DataOnly C3 history
message. The exact binding is the accepted closed payload and source tuple:
`entryKind=ModelOutput`, payload tag `AssistantMessage`, exact ProviderTurn
`T`, `contentRef="provider:T:assistant"`, source
`{ kind: "ProviderTurn", ref: "T:assistant" }`, accepted writer string
`text`/`finishReason`, and its exact source content hash. Unprovable, malformed,
mismatched, unsupported legacy, or wrong-source entries are not reconstructed
or inferred from adjacent rows or text and contribute no AssistantMessage
projection.

The existing P2/P3 selection and compaction contract remains unchanged: latest
selected 64 rows before a typed checkpoint, no refill after filtering; exact
checkpoint plus unsummarized typed frontier after checkpoint; no false
`retainedFrontier` coverage; existing budget and `NeedsCompaction` behavior.
ConversationResponse remains on its independent P14/P17 RootWorkspaceId-owned
Conversation history/checkpoint and never merges Work Session
AssistantMessages. Existing pinned ProviderTurn manifests/results remain
immutable and replayed exactly; no duplicate Session output or same-turn
recompilation is introduced.

A text-only WorkspaceWork `Stop` with no ToolInvocation remains nonterminal if
the existing loop continues the same Execution. Its accepted output must be
present in the next same-Session Provider context (or its exact active
checkpoint representation). Text remains DataOnly: it is not canonical Work
progress, authority, effect, CompletionClaim, or settlement evidence.

This decision changes only context projection. It does not decide or modify
P12-DG-01; `RuntimeSafetyObservation` generation, P12 D2/D4 counter-update
rules, `MAX_TURNS`, settlement, rate limits, and stop/fencing behavior are
unchanged. Context may naturally affect later model-selected activity, but
this landing does not interpret that activity as a new P12 progress rule.

## Exact owner-document landing

The accepted semantics are landed only in these P3 owner documents:

1. `docs/design/implementation/P3/02-model-context-contracts.md` — exact
   same-Session projection/source binding, DataOnly C3 provenance, frontier,
   checkpoint and legacy fail-closed behavior.
2. `docs/design/implementation/P3/03-agent-loop-driver.md` — text-only Stop
   continuation in the existing same Execution and next-turn visibility, with
   P12/safety and Conversation boundaries unchanged.
3. `docs/design/implementation/P3/08-agent-loop-step-handoff.md` — accepted
   output binding and immutable exact replay/no duplication.
4. `docs/design/implementation/P3/07-behavioral-eval-harness.md` — required
   deterministic/model-light acceptance coverage and explicit non-authorization
   for live evaluation.

P2 is not changed: its existing typed eligible SessionItem set and active
frontier contract are sufficient. No schema, port, migration, wire contract,
P1 receipt, ProviderTurn identity, output contract, P14, P17, or P12 change is
authorized by this acceptance.

## Review and authorization status

This record and the four-file owner landing are the exact accepted governance
application. Independent post-landing consistency review is **PENDING**; the
landing must not be treated as self-reviewed. Once that review is complete,
implementation still requires a separate explicit authorization. This
acceptance record grants no production-code, test, migration, real Provider,
deployment, or release-claim authority.
