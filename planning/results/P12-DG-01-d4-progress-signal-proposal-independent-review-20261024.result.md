# P12-DG-01 D4 Progress-Signal Proposal — Independent Review

**Disposition: BLOCKING = 1.** The proposal is not ready for manual acceptance
in its current fixed scope. This is a read-only semantic/hash review; no
proposal, design, or production source was changed, and no tests/provider/
daemon were run.

## Reviewed identity

- Proposal commit: `346a0c6a8afa6628ba6196ec6e105db4aef73e33`.
- Proposal SHA-256: `B0B22BF4850E85785FDA718461A8582491BDDEF206209A7B848B4D6510C1BD51`.
- Manifest raw SHA-256: `6C412AD91C3B6064541EC053D67CE6A17A1AFA82FA299C4D190E6C9745C71018`.
- Proposed decision token: `ACCEPT_P12_DG_01_AGENT_ACTION_TERMINAL_D4_PROGRESS`.

The proposal hash matches its manifest entry, and the manifest hash matches
the committed manifest file. The manifest is marked `PROPOSED_NOT_ACCEPTED`;
the token has not been exercised.

## Blocking finding

**B1 — The fixed D4 signal reuses the same boolean that currently resets D2.**
The proposal says D4 progress is narrowed to a terminal sourced AgentAction
outcome or attributable authoritative mutation, while also asserting D2
fingerprint accounting/reset semantics remain unchanged and independent. In
the current `packages/execution-runtime/src/runtime-safety.ts`, however, one
`RuntimeSafetyObservation.durableProgress` value is consumed by both
dimensions: the D2 path clears `state.fingerprints` when it is `true`, and the
D4 path resets `state.noProgressTurns` on the same value. The frozen P12 `08`
table also defines D2 reset on durable progress. Narrowing the producer of
this shared boolean therefore changes when D2 fingerprints clear, even if
the D2 counter algorithm itself is untouched. This contradicts the package's
claims that D2 reset semantics remain unchanged and that the D2 matrix row is
independent of D4.

Before acceptance, the P12 owner must make this interaction explicit. Either
the package must govern the resulting D2 reset change and update its scope,
owner landing and acceptance tests, or it must define how D2 preserves its
existing reset semantics independently from the narrowed D4 signal. The
current package cannot claim both a changed shared signal source and unchanged
D2 behavior. A focused qualification must cover repeated fingerprints across
output-only/step-only progress and after a terminal sourced action outcome.

## Non-blocking review findings

- The proposed D4 rule itself is clear: text-only AssistantMessage/provider
  result/AgentLoopStep bookkeeping do not count; the first durable terminal
  sourced action result counts even when typed Failed/Denied/Rejected; an
  authoritative mutation requires attribution; and P9 recovery bookkeeping
  alone does not count. The base-source audit also identifies the concrete
  false-positive path where `persistActionObservation` returns false but a
  caller sets `durableProgress` unconditionally, and correctly requires
  persistence or separately attributable mutation evidence.
- Owner boundaries are appropriate: P12 owns the semantic reconciliation and
  acceptance mapping, P3 owns the producer, and P2 retains the gate/counter.
  The proposal does not ask for a P2 port/table/migration or change D4 counter,
  `MAX_TURNS=24`, restart reset, Stop/settlement or P9 recovery behavior.
- The P9-vs-D4 distinction is explicitly preserved: recovery state remains
  authoritative recovery evidence, but cannot independently reset D4.

**Conclusion:** The D4 classification is suitable as a discussion basis, but
the shared D2/D4 signal makes the current “D2 unchanged” scope internally
inconsistent. Manual acceptance should wait for that boundary and its test
matrix to be resolved. No implementation authorization is implied.
