# Native OS Sandbox Windows T3-D D1 result

Status: **D1 strict artifact-manifest codec and read-only inspection seam
implemented; production qualification remains unavailable.** Implemented against
fixed plan SHA-256
`353b368738594d9d3da0c917cc6627bdd4f9a27f898e4b844ac519dedceb8451`.
No `docs/design/**`, provider `run` path, or Supported capability wiring changed.

## Manifest and inspector

Added `WindowsNativeArtifactManifestV1` with a closed ordered canonical JSON
codec. It binds exact Windows provider/version/numeric capability revision/OS
build/primitive identity; sorted unique qualification tuples and complete
rule-set digests; source, fixed Framework64 compiler, compiler-argument and PE
hashes plus compiler/build versions; sorted test/control artifact hashes; all
six limits; operator config revision/digest; discovery method/version; sorted
matrix results and host-control evidence. The manifest contains no own digest,
signature or `qualificationEvidenceRef`. Decoder requires UTF-8 byte
round-trip, exact key set/order, canonical positive integers, lowerhex digests,
closed enums, unique canonical arrays, and valid artifact/control references.

The D1 KAT pins canonical bytes and full manifest SHA-256
`e502199edae3e7b74c9fe6bd9681d727f537585b99d1b5983bbf9b013b4af234`.
Inspection reads only fixed package paths for the production helper source,
compiler, shipped PE, qualification manifest/signature and named test/control
artifacts. It verifies each current file's bytes against the manifest, the
fixed compiler argument template, exact current expectation tuple/provider/
OS/config/build/discovery/limits, manifest digest-to-`blob:sha256:` reference,
and all-pass recorded matrix/host-control results. Missing, unreadable,
redirected/reparse, invalid UTF-8/canonical bytes, hash drift, expectation
mismatch, missing verifier, empty/invalid signature, or verifier error returns
typed `Unavailable` without leaking host paths or exceptions.

Detached signature verification is only an explicit injected
`WindowsNativeQualificationProvenanceVerifier`; there is no default verifier,
trust anchor, key, environment override, or caller-selected artifact path in
the fixed inspector. `ManifestVerified` is artifact evidence only, not a
provider capability or launch authorization. The accepted operator trust
source remains external/unimplemented, so the installed fixed inspector fails
closed by default. The production helper package artifacts are not present in
this checkpoint; their absence is also typed Unavailable.

### Review follow-up: Disabled-only D1 boundary

The D1 manifest codec accepts only `ReadOnly|WorkspaceWrite × Disabled` rows;
Restricted and Enabled are rejected by both decoder and inspector. The record
verifier enforces canonical structure, file hashes, exact expected bindings,
and Pass for every matrix/control record that is present. It does not yet
establish that the signed manifest contains the complete P12 control and
adversarial matrix, nor that recorded host controls match the live host. Those
completeness/current-host checks remain explicit D2/D6 gates;
`ManifestVerified` is not a qualification or Supported result.

This D1 scope does not assume a complete matrix from arbitrary manifest IDs;
the full accepted control/adversarial ID inventory and live-host binding are
explicitly left to D2/D6.

## Verification

- `pnpm build`: PASS.
- `pnpm typecheck`: PASS.
- Windows adapter suites with `--testTimeout=10000`: 48/48 across 4 files,
  including 29 manifest tests; manifest-only default-timeout run 29/29.
- Sandbox process architecture boundary: 24/24.
- Changed-file Biome and `git diff --check`: PASS.
- Full `pnpm check` and full repository tests were not run.

The unchanged `windows-native-bridge.test.ts` Job Object memory/CPU case
repeatedly exceeded its default 5-second per-test limit (observed roughly
5.3–6.8 seconds) on this host; it passed in the package run with a 10-second
command-line timeout. No unrelated test or timeout was edited.

All Windows identities remain Experimental with empty capability tuples. No
helper was built, launched, or installed, and no provider was marked Supported.
