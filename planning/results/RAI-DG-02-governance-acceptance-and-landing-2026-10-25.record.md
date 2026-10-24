# RAI-DG-02 V2 governance acceptance and owner landing

Date: 2026-10-25  
Decision: **ACCEPTED / OWNER DOCUMENTS LANDED**  
Implementation: **NOT AUTHORIZED by this decision**

## Manual decision

The manual governor supplied the exact token:

```text
ACCEPT_RAI_DG_02_TERMINAL_PROVIDER_FAILURE_HOLD_V2
```

Accepted proposal:
`planning/proposals/RAI-DG-02-terminal-provider-failure-readmission-hold-draft.md`

Verified pre-landing raw SHA-256:
`FA1AFC6675E040698F69E5EE29C67DE92EA10D54228D476A6DA27E2A98B8FA93`.

The hash matched the V2 revision record before any owning document changed.
The accepted decision authorizes only the exact owner landing package named by
that proposal. Production implementation, migration activation, preserved
database access, Provider execution and release qualification remain separate.

## Landed owner revisions

- System Design `v1.22 → v1.23`.
- Detailed Implementation Design `v1.60 → v1.61`.
- P2 `02`: closed source kind, proof query, integrity and admission recheck.
- P3 `08`: exact terminal Attempt/Turn/Step/Manifest evidence chain.
- P6 `04`: exact-revision Steer release and terminal lifecycle disposition.
- P7 `03`: sole runnability classifier consumption.
- P9 `07`: crash/restart ordering and no reconstruction.
- P10 `02`/`05`: query-derived valid/integrity presentation and API literals.
- P12 `12`: unchanged failure taxonomy and non-authoritative telemetry/config.
- P13 `03`: presentation through existing Attention/Work Detail and Steer.

No schema, migration, route, command, Work lifecycle variant, persisted gate,
Attention marker, automatic retry, WorkWait or Provider taxonomy change is
part of this landing.

## Landing manifest

`preGitBlob` identifies the exact pre-landing Git blob. `postSha256` is the raw
working-file SHA-256 after the accepted landing.

| Owner file | preGitBlob | postSha256 |
|---|---|---|
| `docs/design/02-system-design.md` | `ca243d94be028e340377d5166329088584ea17d7` | `70655530BA5A49289148F9F1D727D60EE2DCEE21093375AC40DC868FECC142E9` |
| `docs/design/03-detailed-implementation-design.md` | `e814f3c9060e38a7adc1f75ef8ba34a4b460f533` | `4628D013EA16FD24E52A0788F86D28ADAA6842646996AE4EB217E7C41F4D5428` |
| `docs/design/implementation/P2/02-port-contracts.md` | `90755cdaa1d820e816e47a37d1045fcd37e068ec` | `8BB7367CFFD17B8DB3DB6BF2AED5275874C97D93AFC2002AC405FB6769423C17` |
| `docs/design/implementation/P3/08-agent-loop-step-handoff.md` | `0cbb3286e87e6e7eda3ef4a526e7586bcc1f3d32` | `899D60B6B9A6659804561BE695D7D34AA66D2CC22BA54DDDE85FBE91C30D9D02` |
| `docs/design/implementation/P6/04-human-steer.md` | `0c69ad4ad4836b1fbb28f7cdbee25b9f3179585f` | `47FCF7A2757DB1F2906782B39217D7F6EFBD9E030709F98324DB056A253B9E90` |
| `docs/design/implementation/P7/03-runnability-classification.md` | `a23a2069e5537273c99988f1b8a84234c929ec8d` | `35B3D0BC6DFAE37B9E21550DFB5205EA95FE2C4FFFE7836FD23E606E048994ED` |
| `docs/design/implementation/P9/07-agent-loop-step-recovery.md` | `fe728c30c662183caa8e498bb3455637510477f1` | `B38F20C10599C1CA8B8BF269A955F87C120DC10A0B2045685BEAA133EFCB0BD6` |
| `docs/design/implementation/P10/02-attention-readmodel.md` | `f2dcc35f04b398759c6ba148b840e7c78d27544c` | `D785DD585C243970B8B2FD983DCB24409C2EBF985314CF4F3F10274D53A73FA6` |
| `docs/design/implementation/P10/05-surface-actions-transport.md` | `d526daa73fd8d0742b23ed123d6a1f6b2cdbc303` | `350B973283E0E33CEF538E8F294406B88A6C962A2D94D8BEB8290B964E208B52` |
| `docs/design/implementation/P12/12-providers-tools.md` | `e5ee5a30607f6a87352c8c8347e8443a30363bf3` | `94C351BAC19457440325D7E354C27C0C9E1FE2031D81D5B9476DBDB9A9D2A0FA` |
| `docs/design/implementation/P13/03-view-rendering.md` | `1a45aa5cc9e9acdff45803aa0ea24197dee0adcc` | `6BBD268390E92B47D1A48AD85D3216C527456265A2EDB6C721C08C38003A4CBB` |

## Required next gate

An independent post-landing consistency review must confirm the proposal hash,
owner scope, version chain, negative boundaries and absence of unaccepted
semantics. Only after that review reports Blocking = 0 may the governor issue a
separate implementation authorization token.

## Corrective landing after independent review round 1

Round 1 is preserved in
`planning/results/RAI-DG-02-postlanding-review-round1-2026-10-25.result.md`
and reported Blocking=3/Nonblocking=0. The correction applies only semantics
already present in the accepted V2 hash:

- P2 now freezes the complete `TerminalProviderFailureSource`, closed return
  union, exact integrity reasons and shared deterministic witness order.
- P10 now freezes additive terminal detail objects on Attention/WorkDetail,
  exact summaries/dedup identities and no-row behavior when canonical
  `occurredAt` cannot be proved.
- P12 `14` now freezes all 15 required qualification rows.

| Corrected owner file | pre-correction Git blob | corrected post SHA-256 |
|---|---|---|
| `docs/design/implementation/P2/02-port-contracts.md` | `db4c352789ac6f98ab43f500d585db3a50730ce8` | `124A00088442018A356B71D9060AFC750B22D744CF8C57D5552684F61126E71A` |
| `docs/design/implementation/P10/02-attention-readmodel.md` | `82c3821c7e39dd45607452212ccc5027b32a8b53` | `4DBFD5A3D6677250427A3921D3B60285B6F4B7901674C82AB62C6F413480ADF6` |
| `docs/design/implementation/P10/05-surface-actions-transport.md` | `0f26cc668fdaa2cff168e5bce2be60e762ad5d1c` | `886DB5B97ECBD843E5E6632BF88F440D2E0A41DDBADAB4086585572F7ABA9E5B` |
| `docs/design/implementation/P12/14-acceptance.md` | `c22b9a0ab837c73fc23bd2edfcfe3d8fcde61bc1` | `F8D7DB68102F2423F35870EA0A5828BC65EF51A3A265A73CE849262F43B35B71` |

The accepted proposal bytes remain unchanged. The correction adds no code,
migration, schema, database access or implementation authorization. A second
independent review is required.

## Narrow corrective landing after independent review round 2

Round 2 is preserved in
`planning/results/RAI-DG-02-postlanding-review-round2-2026-10-25.result.md`
and reported Blocking=1/Nonblocking=0. The only remaining omission was the
accepted Work Detail occurrence time. `TerminalProviderFailureView` now carries
the exact validated final ProviderAttempt `settledAt` as `occurredAt` for both
variants; the existing no-row `ProjectionIntegrityFailure` rule still applies
when that instant cannot be proved.

| Corrected owner file | pre-correction Git blob | corrected post SHA-256 |
|---|---|---|
| `docs/design/implementation/P10/05-surface-actions-transport.md` | `5967ac0862cb2b915c4a9192a76a5fdb18193da7` | `ECE7D74BB8664CF455AA6AF345410F7F93161076B8B329780F35CEE651FB4CE3` |

No other owner contract changed. The accepted proposal bytes remain unchanged;
round 3 independent review is required before implementation authorization.

## Final post-landing disposition

Round 3 is recorded in
`planning/results/RAI-DG-02-postlanding-review-round3-2026-10-25.result.md`.
Decision: **PASS — Blocking=0, Nonblocking=0**. The RAI-DG-02 V2 design layer
is closed and may request a separate implementation authorization. No such
authorization is inferred from this design acceptance or review.
