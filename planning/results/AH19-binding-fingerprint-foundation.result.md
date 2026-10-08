# AH19 — Binding Fingerprint Foundation

Date: 2026-10-08

Status: **FOUNDATION PASS only. AH19 remains open.** This batch carries the
Composition-Root deployment identity into model capability metadata and fails
closed for ProviderNative when that full identity is unavailable. It does not
qualify a Native adapter/projector, or a real-process binding mismatch and
portable rebuild.

## Change

The Composition Root computes the existing P16 canonical
`resolvedModelBindingFingerprint` once and passes it to `ModelCapabilityPortLive`
and the existing ProviderRuntime/deployment identity consumers. The
ModelCapability resolver accepts only the complete `p16fp_<64 hex>` form,
overwrites any catalog-sourced fingerprint with this resolved value, and
removes `CompactionNative` from portable compatibility if no complete
fingerprint is present. Existing Agent Runtime code consumes this metadata in
`AgentStepContext`; the existing compiler persists that value in the Manifest.

No `packages/agent-runtime/**` production code changed, preserving the P16
Gate-B zero-Agent-Runtime-diff guard. The existing P16 fingerprint recipe
remains unchanged; the result excludes SecretRef and SecretMaterial. No
ModelContext compiler semantics, ProviderRuntime behavior, provider adapter,
or frozen design document changed.

## Evidence

`packages/model-context/test/ah19-binding-fingerprint.test.ts` verifies:

- identical resolved deployment bindings yield identical fingerprints;
- endpoint, deployment ID, model ref, or execution-policy changes yield a
  different fingerprint, while changing only SecretRef does not;
- a complete fingerprint reaches ModelCapability and preserves explicitly
  declared Native compatibility;
- absent or legacy/incomplete fingerprint strips Native compatibility;
- the current stock model catalog does not declare Native;
- the compiled ModelContext Manifest carries the binding fingerprint and not
  the test SecretRef/material sentinels.

`tests/architecture/ah19-binding-fingerprint.test.ts` guards the Composition
Root → ModelCapability → AgentStepContext → Manifest wiring and checks that
SecretRef/SecretMaterial are not passed into capability metadata or compiler
Manifest construction.

## Verification

```text
pnpm exec vitest run packages/model-context/test/ah19-binding-fingerprint.test.ts tests/architecture/ah19-binding-fingerprint.test.ts
  2 files, 8/8 PASS

pnpm typecheck: PASS
pnpm --filter @arbor/model-context build: PASS
pnpm --filter @arbor/single-workspace build: PASS
Biome (4 changed source/test files): PASS
git diff --check: PASS
```

Not run: full `pnpm check`, full functional suite, Native adapter/projector
qualification, restart match/mismatch portable rebuild, or process-level
SecretRef/SecretMaterial leak qualification. These remain required follow-up
evidence before AH19 closure.

Integration update (2026-10-08): the independent full `pnpm check` passed
(Biome 960 files, architecture 31 files/158 tests, core 318 files/1733 passed
and 3 skipped, Web 31 files/223 tests). This supplies the repository-wide
regression gate only; AH19 remains FOUNDATION PASS, with Native match/mismatch
portable rebuild and checkpoint recovery still open.
