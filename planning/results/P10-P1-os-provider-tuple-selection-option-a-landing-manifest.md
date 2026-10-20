# P10 → P1 Option A — Owner Landing Manifest

Acceptance token: `ACCEPT_P10_P1_OS_PROVIDER_TUPLE_SELECTION_OPTION_A`

Accepted source: proposal commit `5a12bc64bd414321b8ecadb87a4b2a65a8444c3b`,
`planning/proposals/P10-P1-os-provider-tuple-selection-binding-draft.md`,
canonical LF UTF-8 SHA-256
`02D2687AA87D6E2B08D06090F293961CCBCFDFF884B6348872D42AFAA59B3013`.

Landing baseline: `5a12bc64bd414321b8ecadb87a4b2a65a8444c3b`.
Every design file below is an owning implementation contract explicitly in
scope for the accepted Option A landing. The listed SHA-256 is over the exact
file bytes after normalizing CRLF to LF and encoding UTF-8 without BOM. Other
`docs/design/**` files are unchanged. This package also adds the decision
record `planning/results/P10-P1-os-provider-tuple-selection-option-a-governance-decision.md`
and this manifest.

| Owner | File | Canonical LF SHA-256 |
|---|---|---|
| P1 index | `docs/design/implementation/P1/00-contract-index.md` | `71bcd77139f7f01f0994f89c234d0eec7dd6dfd0f840c1d8e2faf8ef77d98f7f` |
| P1 payload, handler identity, replay and result compatibility | `docs/design/implementation/P1/01-command-contracts.md` | `95d9069a2ada0170015af3fb631dfa47a6e0c30ca63cb1e1ffd2641f343b96a9` |
| P1 preparation/CAS/linearization | `docs/design/implementation/P1/03-transaction-model.md` | `5cd5a7990dbb10b11eef5b4f95123d46667a911fe5e1fc8354681b77ad5c318b` |
| P1 no-DDL/result-carrier record | `docs/design/implementation/P1/04-sqlite-schema.md` | `d5ee783f2d9a70c440542b6d123d86f6764cac7904cd69be7f4332d85db5648e` |
| P1 receipt/recovery compatibility | `docs/design/implementation/P1/06-recovery-matrix.md` | `332bdb521ce33f712dc9dbaebc6b2d93fe71240986827cce074704ee73fa44e3` |
| P4 snapshot input mapping | `docs/design/implementation/P4/04-sandbox.md` | `597d49453cbf99ac11110641f900b82ca48c9ae5bcf98f6f9033a7ce1bfc1da0` |
| P5 index | `docs/design/implementation/P5/00-contract-index.md` | `7b254c833030dd6426b6828d0fc534c4883ad62e834c5277a5f883e08a4f76ad` |
| P5 V2 authority registry source | `docs/design/implementation/P5/01-composition-root.md` | `098bda73c6bcad9e52c2b479723c2278d073bcf6e797698d7063bb5cdc9d8abd` |
| P10 index | `docs/design/implementation/P10/00-contract-index.md` | `623cfaeaa457bb7c92ccf38887e0a8bcb4360375d912eb89f6c781415eb15f57` |
| P10 candidate DTO, ordering and identity | `docs/design/implementation/P10/05-surface-actions-transport.md` | `8fc12f01ad2fa26d21dc079e24c4a5d1d615df60736a0f40803fffe24e85a086` |
| P10 candidate qualification | `docs/design/implementation/P10/07-acceptance.md` | `2d203a4d35696d0f6a503eeaeb29cc3e56a3d76555964c32f361c42c5b71e9a2` |
| P12 transport boundary | `docs/design/implementation/P12/10-transport-shells.md` | `460a64d98f038e2e8e2d64b8a9c81a01b1f2bd3504a436d25077e96a9e26de28` |
| P13 index | `docs/design/implementation/P13/00-contract-index.md` | `5981e66625f13cfe053bee5e4d4d73bb540c162508a8dacccd44e842de90d8b0` |
| P13 human command exposure | `docs/design/implementation/P13/02-command-exposure-matrix.md` | `1d880f812c26a7f8a87e3d9e758ee00c15b22bd5c1686f5cf79cf0e44c5d52f6` |
| P13 candidate rendering and mapping | `docs/design/implementation/P13/03-view-rendering.md` | `0db0f3bf7b88c3382404298ff91778e59714e09e3dad4c0a1be1ad978a6f92b8` |
| P13 selector/replay acceptance criteria | `docs/design/implementation/P13/06-acceptance.md` | `6675ec61d1f930b244cf2eedd6fed5958bedb5ca6bea25bc76943552cd83a8f7` |

The Option A landing adds only explicit providerVersion/capabilityRevision
selection, the current P1 handler schema 2 with exact schema-1 receipt
compatibility, the P10 candidate DTO/identity update, P13 mapping and the
necessary P4/P5/P12 owner references. The existing V2 P5 registry and
high-water shapes, P1 result bytes and schema-50 SQL, full-bundle/registry
CAS, P4 snapshot codec, authority, TrustedLocal behavior and no-fallback
rules are unchanged. No migration, production code, provider qualification,
Supported-state change or release action is included.

No top-level frozen owner document was edited:
`docs/design/00-problem-goals.md`, `01-scenarios.md`,
`02-system-design.md`, and `03-detailed-implementation-design.md` are
unchanged. All amendments are in P1/P4/P5/P10/P12/P13 owning implementation
contracts only.

Verification performed for this design-only landing: accepted proposal SHA
recomputed and matched; `git diff --check` passed; generated KAT recomputed
independently; no production/test command or database was run. Independent
post-landing review is pending and must record B0/B1/B2 before this landing is
considered closed.
