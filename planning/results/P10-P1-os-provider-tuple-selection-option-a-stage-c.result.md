# P10 → P1 Option A — Stage C result

Date: 2026-10-20

Authorization: `AUTHORIZE_P10_P1_OS_PROVIDER_TUPLE_SELECTION_OPTION_A_IMPLEMENTATION`

Plan SHA-256: `E806F986FA272390F6D3F6372946DC69A838CDD299A11A6A7BADF1C56DE761DA`

## Outcome

P1 preparation now accepts an OS policy only when one exact `Supported` row
matches provider id, provider version, capability revision, current Windows
host/build, profile, network mode, codec version, and the provider's canonical
enforcement-rule-set digest. Missing, duplicate, non-Supported, evidence-less,
or mismatched rows fail closed. No row order, candidate id, or inferred version
selects a provider.

For the currently implemented Windows provider, preparation verifies the
manifest and detached signature against the same V3 authority snapshot's
operator trust set using the existing production verifier. The verifier binds
the manifest's provider tuple, host build, profile/network/ruleset, evidence
digest, all six limits, and current operator-config revision/digest. Production
uses the verifier's fixed artifact paths; only tests may supply the filesystem
I/O seam. Other provider/host tuples remain unavailable until an exact
production evidence verifier exists for them.

The resulting path-free P1 summary is built from the accepted tuple and exact
network policy, with the corresponding broker controls, provider-registry
pair, operator limits, complete P11 boundary, and environment-basis digest.
The in-transaction current-preconditions reread now rebuilds the boundary with
the same selected policy kind/profile, preserving the existing registry and
handle-binding CAS. TrustedLocal remains unchanged.

The synthetic `Supported` fixture is test-only: it uses the accepted D2 V3
trust-set shape, a genuine Ed25519-signed manifest, and the production
qualification verifier. It does not qualify the installed helper, change any
production registry row, start a provider, or claim T3 support.

## Verification

- `pnpm --filter @arbor/single-workspace... build` — PASS.
- `pnpm typecheck` — PASS.
- Focused preparation, P5 vertical-slice, and schema-50 Gateway atomic/crash
  tests — 3 files, 18 tests PASS.
- `pnpm architecture` — 36 files, 193 tests PASS.
- Targeted Biome check — 7 files PASS.
- Production Windows helper qualification / actual provider execution — NOT
  performed; remains separately gated. No online database was accessed.

## Remaining

Stage D P13 deliberate provider-version/capability-revision mapping and Stage
E's restart/source-drift qualification remain. This result establishes exact
selector and evidence verification only; it does not mark any T3 provider
Supported or runnable.
