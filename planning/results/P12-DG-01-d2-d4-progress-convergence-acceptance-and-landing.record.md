# P12-DG-01 D2/D4 Progress-Signal Convergence — Acceptance and Landing Record

Date: 2026-10-24
Decision: **ACCEPTED fixed package, revision 2**
Acceptance token: `ACCEPT_P12_DG_01_D2_D4_PROGRESS_CONVERGENCE`

## Accepted package identity

The accepted fixed package is
`planning/proposals/P12/P12-DG-01-d4-progress-signal-fixed-package.md`,
SHA-256:
`8E737E2F0E4C423D7A4AAD05B3F44CAA3E9C618DA1E451F3AB7F5C8F60AA5E71`.
Its manifest is
`planning/proposals/P12/P12-DG-01-d4-progress-signal-fixed-package.manifest.json`,
SHA-256:
`5117291BB4E0E8374018555BA1A3AA7A74B8B017EB33B907A3F524E85EC7F779`.
The accepted decision applies to revision 2 and its sole listed decision token;
the retired draft/token is not accepted.

## Decision and authority boundary

The accepted contract makes the existing `durableProgress` observation the
shared D2/D4 reset signal. Only a newly committed successful terminal sourced
AgentAction outcome or an attributable authoritative application/canonical
mutation sets it. Unsuccessful typed outcomes remain sourced/model-visible as
applicable but do not reset either safety history. ProviderResult,
AssistantMessage/ModelOutput-only commits, Session text, AgentLoopStep/cursor
progression and P9 recovery/handoff/replay bookkeeping do not count by
themselves. The same true signal clears D2 fingerprint history and resets D4
at the next new ProviderTurn boundary; false or absent preserves D2 history and
increments D4. Existing thresholds/counting, `MAX_TURNS = 24`, process-local
counter reset, stop/settlement and Work lifecycle are unchanged.

For each new ProviderTurn operation, D2 request identity is compiled before
gate admission and ProviderRuntime dispatch, namespaced by operation kind, and
reuses that path's existing opaque stable hash. Inference retains its current
FNV-1a compiled-request hash; Summary/Native compaction and Conversation
checkpoint/overflow paths retain their current SHA-256-based request identity.
No universal hash or authority fingerprint is introduced. ProviderAttempt
retries remain within the same admitted ProviderTurn. AgentAction identity
binds route, action/tool name and canonical semantic arguments, excluding
callRef and other ephemeral invocation identities; its equivalence
qualification remains required. P9 settled-result replay is not a new
ProviderTurn/admission and cannot alone contribute progress; only a new
qualifying commit while processing replay may accumulate for the next new
ProviderTurn.

The second token supplied for implementation is recorded exactly as
conditional authority:
`AUTHORIZE_P12_DG_01_D2_D4_PROGRESS_CONVERGENCE_IMPLEMENTATION_AFTER_LANDING_REVIEW`.
It may be exercised only after an independent post-landing review reports
Blocking = 0. That review has not yet occurred, so implementation authority is
not currently exercisable. This landing does not modify production code,
tests, persistence, migrations, provider protocols, or runtime behavior; it
does not claim P12 implementation qualification or closure.

## Owner-document landing

The accepted semantics are landed in these owning contracts:

| Owner document | SHA-256 of staged Git blob |
|---|---|
| `docs/design/implementation/P12/00-contract-index.md` | `884367510EC427CB44E4851CF836D83FD2B31BA02968F442B9FCDBC2333454D5` |
| `docs/design/implementation/P12/08-runtime-safety-completion.md` | `9D3E4CD72D1EECB0FC4370B0206F844D07CC61F2A05DC0800EAC7EFB8FECFF6A` |
| `docs/design/implementation/P12/14-acceptance.md` | `6FA8C0157B17ADEA1AE1B91F255D5E7CB9E753C4CE74A82BF4D1F03903C1E674` |
| `docs/design/implementation/P2/02-port-contracts.md` | `8A2C0E5C50139871C495E855675022CCF2D3800A28301C213E721D51472873E6` |
| `docs/design/implementation/P3/03-agent-loop-driver.md` | `6FB7BE23C3ABB9269E4FA328CBD58030F553036F8C242E81E259C10570EEA458` |
| `docs/design/implementation/P3/08-agent-loop-step-handoff.md` | `294698E00A222848E09A4F5A55663A9422BB80A1838E0D7D29F5841594C11BDA` |

P12 `08` §7C was wording-harmonized so a productive compaction remains a
bounded continuation/checkpoint outcome but is not independently the shared
D2/D4 progress signal. P3 `03` and `08` add only producer/recovery interaction
notes; existing P9 and S4 semantics are retained. P2's existing observation
shape and gate ownership remain unchanged. P12 `14` records the required
focused qualification matrix without claiming those tests already exist.

The staged-document blob hashes above are the landing package hashes; after
commit they are to be verified against the committed tree. Independent
post-landing consistency review remains pending and must report Blocking = 0
before the conditional implementation token can be exercised.
