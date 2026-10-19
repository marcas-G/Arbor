# Native OS Sandbox T3-D D0+D3 implementation result

Status: **D0+D3 implementation slice complete; no provider qualification or
T3 launch authority claimed.** Implemented against the reviewed fixed plan
`planning/tasks/native-os-sandbox-windows-t3d.md` (SHA-256
`353b368738594d9d3da0c917cc6627bdd4f9a27f898e4b844ac519dedceb8451`). No
`docs/design/**`, V6 candidate, or P10 files were changed.

## D0 — full enforcement rule-set identity

Added the closed `SandboxEnforcementRuleSetV1` codec with exact ordered fields,
version-1-only numeric values, the pinned IANA special-purpose snapshot ID,
and the provider-specific closed `platformPrimitiveSetId` mapping from the
accepted P12 contract. Canonical decode requires exact byte round-trip and
rejects extra fields, whitespace/order variants, wrong snapshot IDs, invalid
primitive IDs, and unknown provider identities. The Linux bwrap KAT fixes both
the exact canonical bytes and SHA-256 digest.

`exactSupportedOsProviderEntry` now compares the registry tuple digest with
the complete canonical rule-set bytes derived from the exact provider ID. A
broker-controls-only digest no longer qualifies; duplicate exact Supported
entries remain ambiguous and fail closed. The RED test reproduced the old
behavior: a full-rule-set digest was rejected before the fix.

## D3 — capability/evidence join before process execution

The internal OsEnforced process policy now carries the validated registry
`enforcementRuleSetDigest` and `qualificationEvidenceRef`. Materialization
copies those exact values only after the current registry row is unique,
Supported, and exact. The provider capability and selection carry the same
full digest/evidence binding. Resolution requires exact digest equality and
both capability evidence fields to equal the committed
`blob:sha256:<lowerhex>` qualification reference, including
`probeEvidenceRef`; no conversion or fallback is used. ToolRuntime rejects
missing/malformed policy bindings before the process port run seam. TrustedLocal
does not acquire OS evidence requirements. POSIX and Windows Experimental
adapters retain empty capability tuples and null qualification/digest values.

## Verification

- `pnpm build`: PASS.
- `pnpm typecheck`: PASS.
- Domain policy/codec suites: 21/21.
- Materializer suite: 3/3.
- ToolRuntime P4 pipeline: 80/80, including missing policy evidence/digest,
  capability evidence mismatch, and capability rule-digest mismatch with no
  `SandboxProcessPort.run` call.
- Native POSIX policy: 13/13; Windows provider: 4/4.
- Sandbox process architecture boundary: 24/24.
- Changed-file Biome and `git diff --check`: PASS.
- Full `pnpm check` and full repository tests were not run.

All OS providers remain Experimental and publish no supported tuple. This
slice does not qualify or enable Windows, POSIX, or any production process
launch.
