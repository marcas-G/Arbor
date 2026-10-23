# Real S2 Stop Attempt — Capture-Correlation Harness Failure

Status: **NOT QUALIFIED; public Stop was not exercised**
Run: `real-public-s2-stop-302534ee21-PTpNiT`
Source tree at execution: `4a637c29`
Date: 2026-10-24

## Boundary and outcome

This was one explicitly authorized real-provider S2 immediate-stop attempt,
using the configured provider with retry 0 and one worker. It reached the
post-effect response gate, but the test failed before invoking public
`StopExecution`:

`REAL NOT QUALIFIED: post-effect held real Provider response did not contain an action call to fence`

The private captures show that the exact correlated response was HTTP 200,
`finish_reason=tool_calls`, with a `read` action call. The harness helper had
waited for a `response-complete` record with the same request ID but returned
the original `response-held` record, which intentionally has no response body.
Therefore the test's action-call predicate inspected an absent field. This is
a harness evidence-join defect, not evidence for or against Stop behavior.

## Retained evidence and fixture limitation

Private evidence directory:
`.test-results/real-public-s2-stop-302534ee21-PTpNiT/evidence-uqd5HQ/`

- Capture file: `provider-captures.jsonl`, SHA-256
  `1AAC369CFA6611DBF81E73D5D3DB6E1637D99499471754803FBF37AF355168C6`.
- Public journey report: `public-s2-S2-STOP-302534EE21-2026-10-23T17-32-00.717Z.json`,
  SHA-256 `0788F29F9AC3F6D8AE2434B1186E0E2F8D1520E2EEDAE257343F504960B1515C`.
- Capture totals: 7 request starts, 6 completed responses, 4 held responses,
  and 4 releases. The action-call response was sequence 6.
- The disposable fixture directory
  `.arbor-functional-schema44-ByDrxH/fixture-gNnUBP` was reported by the test
  as retained, but a later read-only check found it absent. Fixture/database
  evidence is therefore **not retained** for this attempt; only the private
  capture and JSON report remain. This limitation must not be represented as
  a preserved fixture.
- The run's process tree was confirmed exited. No Stop command/restart was
  performed, and no live or preserved user database was used.

No provider credentials, authorization headers, raw endpoint, prompt text, or
response body are included in this record. The raw private evidence is not to
be committed.

## Harness correction and verification

The shared `waitForHeldProviderResponse` helper now pairs `response-held` with
exactly one `response-complete` capture by request ID and validates sequence,
process, method, path, request JSON, and status before returning an explicitly
typed correlated held response. It preserves `event: response-held` and copies
only the checked completion status/body. Inconsistent or duplicate evidence
fails closed. S0 coverage proves tool-call and plain-text bodies, confirms the
held event itself has no body, and rejects sequence/status/request mismatches.

Verification performed after the correction:

- S0 unit-only configuration: 2 files, 11 tests passed; no daemon or provider.
- `pnpm exec tsc -p tsconfig.test.json --noEmit`: passed.
- Biome on the changed source/test files: passed.
- `git diff --check`: passed.

The corrected helper has not been exercised by another real-provider request.
The Stop journey remains unqualified pending independent review and a separately
authorized single rerun.
