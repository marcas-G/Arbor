# P12-DG-01 implementation — Wave 1 result

Date: 2026-10-24
Accepted design: `ca042f5de1976e118ece9affe1db1464857975e3`
Post-landing review: `2d3b9760` — PASS, Blocking = 0
Acceptance token: `ACCEPT_P12_DG_01_D2_D4_PROGRESS_CONVERGENCE`
Implementation token: `AUTHORIZE_P12_DG_01_D2_D4_PROGRESS_CONVERGENCE_IMPLEMENTATION_AFTER_LANDING_REVIEW`

## Implemented

- P3 now admits each new ProviderTurn using its compiled manifest's existing
  stable request hash, namespaced by operation kind, immediately before
  `ProviderRuntime.runTurn`. Inference, Summary, Native, Conversation
  checkpoint/overflow compaction, and overflow replacement use this boundary.
  A P9 settled-success replay is consumed without a new D2/D4 admission;
  ProviderAttempt retries remain within the single admission.
- P3 ends the provider lease bracket with the existing retry ordinal and
  releases it on both successful and failed provider results when a live lease
  is present. A gate Stop before dispatch produces no ProviderRuntime call and
  follows the existing RuntimeSafetyStop settlement path.
- ToolInvocation D2 identity is SHA-256 over route kind, action/tool name and
  stable canonical JSON argument semantics. Object-key order is ignored;
  `callRef`, ProviderTurnId and step identity are excluded. This is process-local
  safety identity only; P4 hashes, recovery bindings, and persisted codecs are
  unchanged.
- `durableProgress` is now true only for a committed Succeeded sourced action
  result or an explicit durable authoritative action commit. Persisted Failed,
  Denied, Interrupted, and in-memory-only fallback outcomes remain
  model-visible where applicable but do not reset D2 or D4. The existing P2
  gate already consumes one true signal for both D2 and D4; no port or schema
  changed.
- A test-only v2 request narrowing in
  `diagnostic-work-assistant-message-context.test.ts` makes the full test
  typecheck explicit; its runtime assertion is unchanged.

## Verification

- `pnpm exec tsc -b packages/agent-runtime --pretty false` — PASS.
- `pnpm exec tsc -p tsconfig.test.json --noEmit --pretty false` — PASS.
- Biome check over the 12 changed TypeScript source/test files — PASS.
- `git diff --check` — PASS.
- `packages/execution-runtime/test/p12-shared-durable-progress.test.ts` and
  `packages/agent-runtime/test/p12-safety-identity.test.ts` — 6/6 PASS. This
  covers shared D2/D4 reset, false/absent signals, request operation-kind
  namespace, canonical argument equivalence, semantic differences, and
  persisted-success classification.
- `scrc-summary-compaction.test.ts` plus the targeted
  `ah19-conversation-checkpoint-compaction.test.ts` case — 3 PASS, 2 skipped by
  the test-name filter. Summary, Native and Conversation Summary gates observe
  the compiled operation kind/hash before the fake ProviderRuntime.
- Targeted `p3-driver.test.ts` cases — 6/6 PASS across three invocations:
  compiled Inference admission/Stop-with-zero-calls, corrective Failed action
  progress=false, successful sourced action progress=true, Summary overflow
  plus replacement Inference fingerprints, and settled-result replay with no
  new admission.
- No real Provider or daemon was run.

## Boundary

This is a focused implementation slice, not P12 closure. D2/D4 counters,
thresholds, `MAX_TURNS`, restart behavior, P9 recovery precedence, event/port
shape, persistence schema, and S4 context semantics are unchanged. Semantic
argument canonicalization passed the required reordered-key/equivalent and
material-change unit matrix; it remains an internal non-persisted helper. No
new design gap was discovered.
