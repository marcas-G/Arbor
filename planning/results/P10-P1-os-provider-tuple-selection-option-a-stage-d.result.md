# P10 → P1 Option A — Stage D result

Date: 2026-10-20  
Authorization: `AUTHORIZE_P10_P1_OS_PROVIDER_TUPLE_SELECTION_OPTION_A_IMPLEMENTATION`  
Plan SHA-256: `E806F986FA272390F6D3F6372946DC69A838CDD299A11A6A7BADF1C56DE761DA`

P13 now maps only the deliberate current-read candidate to the existing P1
command. The Web OS payload type is a strict schema-2 union requiring both
`providerVersion` and positive `capabilityRevision`; the TrustedLocal branch
does not admit either field. The mapping copies the exact candidate pair,
provider tuple, profile, selected network policy, current preconditions,
registry pair, and selected handle digest. It never sends `candidateId`,
evidence, host data, or provider diagnostics.

Candidate choice labels now show provider version and capability revision so
otherwise-identical rows remain human-distinguishable. TrustedLocal still
requires its separate explicit confirmation; refresh/stale behavior and
no-default selection remain unchanged. Server-side schema-1 exact-receipt
replay and current schema-2 no-receipt rejection are covered by the Stage B
Gateway/codec results; this Web-only stage did not alter receipt behavior.

## Verification

- `pnpm --filter @arbor/web typecheck` — PASS.
- Web selection, command-form, and workspace-page tests — 3 files, 44 tests
  PASS.
- Targeted Biome check — 6 files PASS.

## Remaining

Stage E real schema-50 dual-daemon qualification remains. No provider was
started and no T3 support is claimed.
