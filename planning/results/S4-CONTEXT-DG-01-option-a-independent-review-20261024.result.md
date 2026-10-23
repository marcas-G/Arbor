# S4-CONTEXT-DG-01 Option A Package — Independent Review

**Disposition: PASS — Blocking = 0.** This is an independent read-only
semantic/hash review of a governance draft. It is not manual acceptance,
design landing, implementation authorization, or S4 qualification.

## Reviewed identity

- Governance package commit: `a5c2d7717cc308538d2e066791a323b13646ba2e`.
- Proposal SHA-256: `B03BDB36C72714E6BCBBEE61364E3E0431C95F342012B6D6B99F16ABB8329A70`.
- Package manifest/list raw SHA-256:
  `CB2B1AF86617B8AFBEC6E4F1E4017BB024C62805337D7B3A8AC48C18C2EEAA20`.
- Suggested token (not accepted):
  `ACCEPT_S4_CONTEXT_DG_01_ASSISTANT_MESSAGE_PROJECTION_OPTION_A`.

The current proposal SHA and all seven artifact hashes in the package list
match their files. The previous proposal and manifest hashes are explicitly
identified as retired; the current package list contains the replacement
proposal hash and the separately owned P12-DG-01 gap artifact.

## Semantic review

- **Evidence and scope:** Option A accurately describes the model-light
  projector/compiler diagnostic as a supplied-frontier test, not
  SessionRepository/runtime integration evidence. It does not claim the
  projection omission alone caused the real Provider not to select `shell`.
- **P3 output/source binding:** The proposed message is the existing typed
  `AssistantMessage` projected as a role=`assistant` PortableMessage with
  `AuthenticatedAgent` provenance and C3/DataOnly capability. Its exact
  ProviderTurn/contentRef/ProviderTurn source ref and `{text, finishReason}`
  content hash match the accepted-output writer. Malformed, legacy or
  mismatched rows are not inferred from adjacent data or free text.
- **Authority boundary:** The message is explicitly not an
  InstructionFragment, canonical Work fact, permission, action, effect,
  CompletionClaim or proof of progress. Projection grants no action or
  completion authority.
- **Frontier and checkpoint:** The proposal preserves P2's latest-64
  pre-checkpoint selected frontier without refill, and the exact checkpoint
  plus unsummarized typed rows after it. It does not reread covered entries,
  expand the window, or let `retainedFrontier` claim content absent from a
  Summary. Legacy/unprovable rows stay durable but are not reconstructed.
- **No-action continuation:** WorkspaceWork text-only `Stop` remains
  nonterminal and may continue in the same Execution; the next Provider
  context receives the exact accepted same-Session AssistantMessage. The
  proposal preserves `MAX_TURNS`, settlement, stop/fencing, rate limits, and
  the current RuntimeSafety observation/counter-update algorithms.
- **P12 owner conflict:** The prior draft's implicit choice about whether
  AssistantMessage/Session/AgentLoopStep evidence resets D4 is removed. The
  conflict between P12 `08` §5 and §7 is recorded separately in
  `P12-DG-01`; this S4 package neither adjudicates it nor conditions the
  projection decision on its resolution. P12-DG-01 remains open for its owner.
- **P14/P17 isolation:** The new rule is restricted to the exact same
  Responsibility-bound Workspace Session. ConversationResponse continues to
  use its independent P14/P17 RootWorkspaceId-owned Conversation history,
  checkpoint and exact claimed HumanMessage; Inbox/Decision ownership is not
  merged with Work history.
- **Governance boundary:** The draft remains unaccepted. Acceptance would
  authorize only the specified P3/P2 owning-document landing and its review;
  production implementation, schema changes, provider qualification and
  release claims still require separate authorization.

## Conclusion

Option A is internally coherent as a narrow P3/P2 projection decision and
respects the System Design, P3, P14, P17 and P12 owner boundaries. The separate
P12-DG-01 clarification is a follow-up for D4 signal semantics, not a blocker
to projecting already accepted Session output. No files under
`docs/design/**`, proposal, gap, manifest, or production source were changed by
this review; no tests, daemon, or Provider were run.

**Review status:** suitable for manual governance consideration; Blocking =
0. No decision token has been exercised.
