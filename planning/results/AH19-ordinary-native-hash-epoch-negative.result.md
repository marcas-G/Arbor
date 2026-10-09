# AH19 ordinary ProviderNative hash and epoch negatives

Date: 2026-10-09

Status: **two focused real-process fail-closed negatives pass; AH19 remains
OPEN**. This result qualifies only the two ordinary ProviderNative manifest
corruptions described below. It does not qualify ordinary Native positive
recovery or close AH19.

## Qualification

Each case starts with public Work assignment and SteerWork history. The real
daemon creates an ordinary `CompactionNative` ProviderTurn, a canonical
successful Attempt/receipt, and a ProviderNative checkpoint advancing the
Session from epoch 0 to 1. The fixture verifies there is no P20 overflow link.
Before corruption, both cases assert the manifest's `contextEpoch` equals the
checkpoint's `fromEpoch` and `compiledRequestHash` equals SHA-256 of the exact
persisted `portable_request_json`.
After SIGKILL and lease expiry, the test changes exactly one field in the
persisted Native `manifest_json`, then restarts generation 1 with the same
binding. Positive history and checkpoint state are produced by the public
process path; SQL is used only for the post-crash negative mutation.

The test compares the post-mutation Manifest with the baseline after restoring
only the target field in memory; every other Manifest field and the portable
request remain byte/value-identical.

| Corruption | Specific startup probe | Outcome |
|---|---|---|
| `compiledRequestHash` no longer matches the unchanged `portable_request_json` | `NativeStartupManifestChecks:compiledRequestHash=false` | `AgentLoopStepReplayBindingMismatch` |
| Native manifest `contextEpoch` differs from the unchanged checkpoint source epoch | `NativeStartupManifestChecks:contextEpoch=false` | `AgentLoopStepReplayBindingMismatch` |

In each probe, the other booleans are asserted true: checkpoint identity and
epoch transition, ProviderTurn identity, Execution, Session, source identity,
source Step existence and turn binding, Step state, absence of an overflow
source link, portable frontier, settled successful receipt and continuation,
operation/output contract, and binding fingerprint. Thus the only false
startup condition is the deliberately changed hash or epoch field.

Both cases observe generation 1, zero new Provider requests, one original
Native ProviderTurn and successful Attempt, unchanged Session epoch and
checkpoint, and unchanged Step and Execution state. The failure oracle requires
the concrete startup check and typed rejection; daemon health timeout is not
used as PASS evidence.

The test-only qualification probe performs read-only lookups for the source
Step/link and settled receipt and reports the startup boolean vector immediately
before the existing fail-closed guard. It changes diagnostics only; the
recovery decision and persisted contract are unchanged.

## Verification

- Focused process tests: **2/2 PASS** (compiled hash and context epoch); all
  non-target startup booleans were true in both cases.
- Full AH19 process file: **36/36 PASS**, including both new hash/epoch
  cases; duration **2188.96s**.
- `pnpm build`: PASS.
- `pnpm typecheck`: PASS.
- `pnpm architecture`: **31 files / 158 tests PASS**.
- Biome on the changed TypeScript files: PASS, with one existing
  `noNonNullAssertion` warning at `model-decision.ts:3945`.
- Full `pnpm check`: PASS. Biome checked 964 files with one existing
  `noNonNullAssertion` warning; typecheck passed; architecture passed 31 files /
  158 tests; core passed 319 files / 1745 tests with 3 skipped; Web typecheck,
  build and 31 files / 223 tests passed. The Web build emitted its existing
  large-chunk advisory.
- Full `pnpm test:functional`: PASS. Vitest **31 files / 121 tests** and
  Playwright **3/3 tests** passed. This includes a second run of the AH19
  process file as part of the complete functional suite.

The full check rewrote the generated P12 restore-drill timestamp/hash fields.
They were restored to their pre-run values; the original SHA-256
`0AA7D186D63327C6454A153C8760FDD807455FCC1944AE25DE1B4728AF403402` is
preserved. `docs/design/P12` and the restore-drill file are clean after the
final functional run.

AH19 remains open; this evidence covers only these two ordinary Native
fail-closed negative cases.
