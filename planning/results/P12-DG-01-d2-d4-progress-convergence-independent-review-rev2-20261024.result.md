# P12-DG-01 Revision 2 — Independent Review

**Disposition: PASS — Blocking = 0 for governance consideration.** This is a
read-only semantic/hash review of an unaccepted proposal. It is not acceptance,
implementation authorization, P12 closure, or runtime qualification.

## Reviewed identity

- Revision 2 proposal commit:
  `da58a3b24a51feef45e7a1b34503d9277b664c74`.
- Proposal SHA-256:
  `8E737E2F0E4C423D7A4AAD05B3F44CAA3E9C618DA1E451F3AB7F5C8F60AA5E71`.
- Manifest raw SHA-256:
  `5117291BB4E0E8374018555BA1A3AA7A74B8B017EB33B907A3F524E85EC7F779`.
- Proposed token:
  `ACCEPT_P12_DG_01_D2_D4_PROGRESS_CONVERGENCE`.

The manifest's single proposal artifact hash matches the file, and the
manifest hash matches the committed manifest. The manifest marks revision 2
`PROPOSED_NOT_ACCEPTED` and retires the prior revision/token.

## Findings

- **D2/D4 coupling is now explicit.** The proposal acknowledges that the one
  `durableProgress` boolean currently drives both `RuntimeSafetyGate` effects:
  D2 clears fingerprint history and D4 resets the no-progress counter. The
  chosen source definition intentionally changes the D2 reset trigger as well
  as D4, while keeping each dimension's count/threshold algorithm unchanged.
  P12 `08` owner targets and the acceptance matrix cover both reset effects;
  this resolves the blocker in the revision-1 review.
- **Success and unsuccessful terminal outcomes are distinguished.** A
  successful durably sourced terminal AgentAction outcome or an attributable
  authoritative mutation may set the shared signal. Typed Failed/Denied/
  Rejected outcomes remain in model context but do not clear D2 or reset D4.
  The audit identifies the current `persistActionObservation=false` false-
  positive path and requires the signal to depend on committed evidence or a
  separately attributable mutation.
- **Replay and P9 are bounded correctly.** Provider result journaling,
  AgentLoopStep progression and P9 recovery/handoff bookkeeping alone do not
  count. Qualification requires no progress from old/replayed evidence or
  missing persisted action binding, while a newly committed terminal sourced
  outcome remains eligible. P9 recovery meanings and unresolved-side-effect
  gates remain unchanged.
- **ProviderTurn D2 identity is explicitly pre-network.** The proposed
  fingerprint is the semantic compiled-request hash, obtained after local
  request compilation but before any Provider call. The proposal accurately
  says existing `compiledRequestHash` is only a candidate: the current audit
  does not prove availability/order at the present gate callsite. The
  required implementation evidence includes a Stop making zero Provider
  calls; no existing wiring is falsely claimed.
- **AgentAction D2 identity excludes ephemeral callRef.** The desired
  fingerprint binds route/tool name and canonical semantic arguments, with
  tests for reordered object keys and materially different arguments. The
  exact canonicalization algorithm is not frozen byte-for-byte, but the
  observable equivalence contract is. That is not blocking for governance:
  an implementation-level canonicalizer may be used if it passes those
  properties. If no canonicalizer can satisfy them without a new contract,
  the proposal expressly leaves that Action-D2 qualification pending; it must
  not be counted as qualified or used to claim P12 closure.
- **Other safety/ownership bounds stay explicit.** P2 retains counter/gate
  ownership and the existing port shape; P12 owns the shared reset semantics;
  P3 owns the signal producer and pre-network/action fingerprint wiring. D2's
  reset-trigger change is openly in scope, but its count/threshold, D4 boundary,
  `MAX_TURNS=24`, process-local restart reset, settlement, stop/fencing and
  Work lifecycle remain unchanged. The token is proposed only; no docs/design
  landing or implementation authority is granted.

## Conclusion

Revision 2 resolves the prior D2-reset contradiction by making the shared
D2/D4 signal and its intentional D2 reset-trigger change explicit. Provider
hash pre-network availability and semantic action canonicalization remain
implementation qualification obligations, not evidence already established
at the base. No tests, Provider, or daemon were run during this review.

**Review status:** suitable for manual P12 owner/governor consideration;
Blocking = 0. No decision token has been exercised.
