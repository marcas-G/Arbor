# F18 Verification v2 Consumer and Read-model Acceptance and Landing

Date: 2026-10-21  
Decision: **accepted; exact design landing recorded; independent post-landing review required**

## Decision

The manual governor accepted Option A with token
`ACCEPT_F18_VERIFICATION_V2_CONSUMER_AND_READMODEL_CONVERGENCE_OPTION_A`.
The accepted proposal is
`planning/proposals/F18-verification-v2-consumer-and-readmodel-convergence-draft.md`,
SHA-256 `C6C41E96C5A59B46810DB9FA7A998DDBC5887B93D75ADF3606E0CA25E351EC73`.
The RED evidence is
`planning/results/F18-verification-v2-consumer-readmodel-red.result.md`,
SHA-256 `0FA66DDC6D4D97932855C11E459A86E2C0365C7228C85FAF5727BE85E638B49B`.
The SHA-pinned implementation plan is
`planning/tasks/F18-verification-v2-consumer-readmodel-implementation-plan.md`,
SHA-256 `9230C474B544BD4FF46539D58CF6B90BBDEF0295B7C4211DDBB011EBDCC3101A`.

The manual governor separately granted implementation authorization with
token `AUTHORIZE_F18_VERIFICATION_V2_CONSUMER_AND_READMODEL_CONVERGENCE_IMPLEMENTATION`.
That authorization is effective only after an independent review of this exact
landing records B0/B1/B2 = 0/0/0. No implementation code or migration is
authorized before that review passes.

## Exact landing manifest

The accepted proposal was landed in its owning documents without adding a new
semantic choice. The post-edit SHA-256 of each owning document is frozen here:

| Owner | Document | SHA-256 |
|---|---|---|
| DID governance summary | `docs/design/03-detailed-implementation-design.md` | `385CA34F760684374D2AA3387C9CB8DB4CBACE13805AE83B202E1EA8D86C289C` |
| P1 schema | `docs/design/implementation/P1/04-sqlite-schema.md` | `0623670F9709386CB66B057E6D293B18FB7CB38B4E5591C8F0CB4BF3390867F7` |
| P1 event journal | `docs/design/implementation/P1/05-event-journal.md` | `9FF05540BD28FF286A041E91236232BC3BF10DDBA5ABCE273D0E205627E16F59` |
| P8 command/receipt | `docs/design/implementation/P8/01-verification-commands.md` | `CD54702A83E07B53E1FC9BFB405286ABF6810896D5F86B509F3E1B5DB16866B7` |
| P9 recovery | `docs/design/implementation/P9/07-agent-loop-step-recovery.md` | `E120850DA12131B9927596D449542AC918FC5836325246EF6D3CF9A4CD56EE1D` |
| P10 Attention | `docs/design/implementation/P10/02-attention-readmodel.md` | `82F78CEC41D221815D6B9B85AF740FECC77E62FD871FA1D2C7A406D95A0E3C8B` |
| P10 rebuild | `docs/design/implementation/P10/04-rebuild-atscale.md` | `71D1AA94A2ACFDAA6FFD59DC25B81E2DEFF9F5A5991E59C6979A08DE9798AF91` |
| P13 rendering | `docs/design/implementation/P13/03-view-rendering.md` | `A8F9DEEA30A5AFAD7473B69B64862EDDD7F70F0190BA663168872987BBE2E151` |

The landing fixes the exact P1 writer/reader pair registry, P8 explicit-null
and receipt binding including the bounded legacy tuple, P9 durable reconciliation
and effect/crash/Attention contract, P10 live queue and rebuild, and P13 four
snapshot-state projection. It does not change the P8 verdict aggregation or
Parent Acceptance authority. Physical migration implementation details remain
bound to the accepted plan and must satisfy the frozen identities/lifecycle.

Implementation baseline: `fcc2e64287ef2be73301631e0d4322cd3c9e8c9b`.  
Landing worktree: `C:\Users\ThinkPad\.codex\worktrees\f18-verification-unknown\Arbor`.  
Post-landing review: pending; implementation remains gated until its independent
record confirms B0/B1/B2 = 0/0/0.
