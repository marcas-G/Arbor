# SCRC-007 — ProviderNative Compaction, Budget and Overflow Evidence

## Source

- DID v1.22 §7.5, §8.10, §8.13; P12 `08` §7C, `12` §7A; T23–T28

## Depends On

- SCRC-005
- SCRC-006

## Objective

Add capability-gated ProviderNative compaction through existing
ContinuationState, full binding fingerprint checks, portable fallback, layered
budget evidence and one overflow-triggered compact/retry.

## Outputs

- model/deployment capability + estimator contracts/adapters;
- native opaque checkpoint storage/ref lowering;
- budget evidence resolver and manifest fields;
- Runtime Safety no-gain/second-overflow integration;
- `scrc-native-budget` qualification suite.

## Must Hold

- exact compatible binding required for opaque reuse;
- mismatch uses durable Timeline + portable rebuild;
- usage/tokenizer evidence outranks fallback and is observable;
- retry only before durable output/effect; second overflow terminal;
- CanonicalProviderEvent ADT unchanged and no new provider family.

## Must Not Decide

- No universal native support claim, silent Summary fallback after native request failure, pricing or UI.

## Acceptance

- T23–T28 pass for fake, OpenAI-compatible and testecho qualification fixtures as capabilities permit.

## Verification

```bash
pnpm test scrc-native-budget
pnpm test provider-qualification
pnpm test p12-runtime-safety
```
