# Windows T3-D fixed-plan self-review

Date: 2026-10-19. Scope: planning only; no production source or
`docs/design/**` change. Baseline: `81663a4e6a88cce53df14d84472412c8478a4b0f`.

Plan: `planning/tasks/native-os-sandbox-windows-t3d.md`.
SHA-256 of canonical UTF-8 with LF line endings:
`353b368738594d9d3da0c917cc6627bdd4f9a27f898e4b844ac519dedceb8451`.

## Contract trace

- Existing V2 qualification registry, committed OsEnforced summary, and
  `exactSupportedOsProviderEntry` already join on exact
  `qualificationEvidenceRef`. The materializer currently compares the
  registry's `enforcementRuleSetDigest` with SHA-256 of broker-controls
  encoding rather than the frozen full `SandboxEnforcementRuleSetV1` bytes.
  D0 requires a red vector and correction under the accepted contract before
  any Supported decision. The current internal
  `OsEnforcedSandboxProcessPolicy` omits it, and
  `resolveSandboxProvider` does not compare a capability's `probeEvidenceRef`.
  T3-D explicitly plans both missing links before any effect admission.
- The T3-C adapter publishes a T2 discovery SHA as `probeEvidenceRef` and
  remains Experimental/empty. The plan requires a verified operator
  `blob:sha256:<manifestDigest>` reference for any future Supported Disabled
  capability; adapter-generated discovery evidence cannot substitute.
- The T3-C held-handle rename counterexample and inconclusive loopback
  timeout are carried as blocking negative evidence. A pre-spawn path check
  and zero token capabilities alone do not satisfy filesystem lifetime or
  exact Disabled network enforcement.
- The manifest is an artifact under existing T3 qualification evidence, not
  a new registry. Its digest is computed outside the manifest, preventing
  self-reference. Signing/trust-root acceptance and a separate production
  helper remain hard gates rather than assumed implementation facts.

## Disposition

One blocking implementation inconsistency was identified (D0 rule-set digest
source); it is explicitly sequenced ahead of manifest/provider work. This
plan does not authorize D1–D6 implementation by itself, Supported status, or a
production helper launch. The following implementation evidence remains
open: signed actual PE/operator manifest provenance, effect-lifetime
reparse/hard-link/race defense, explicit loopback/direct-network denial,
whole-tree Stop mapping, and broker qualification for Restricted/Enabled.
If any missing ownership/trust/Stop semantics cannot be resolved under the
accepted contracts, the implementation must raise a Design Gap with failure
evidence and leave the provider Unavailable.

Review method: read-only inspection of the T3-C result and the domain,
ports, materializer, provider, and ToolRuntime seams. No tests were run for
this planning-only change; no runtime behavior was modified.
