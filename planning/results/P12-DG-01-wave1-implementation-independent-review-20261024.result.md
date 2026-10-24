# P12-DG-01 Wave 1 — independent implementation review

**Disposition: PASS — Blocking = 0 for the reviewed P12 implementation.**

## Reviewed identity and scope

- P12 implementation: `6a9a3b42f5bcce7a3e8adb957f884f7b23940147`.
- D5 bracket / Attention fixture correction:
  `6ce1133b09637ae55d0f220be0d0015ac43fe7d7`.
- Accepted design landing: `ca042f5de1976e118ece9affe1db1464857975e3`.
- Accepted proposal SHA-256:
  `8E737E2F0E4C423D7A4AAD05B3F44CAA3E9C618DA1E451F3AB7F5C8F60AA5E71`.
- Conditional implementation authorization is recorded in the acceptance
  record; this review is not real Provider/daemon, deployment, or P12 closure
  qualification.

## Review findings

- Each `PortableOperationKind` is covered: Inference uses the prepared
  manifest's compiled request hash; Summary and Native compaction,
  Conversation checkpoint compaction, and overflow/replacement use their
  operation path's existing request hash. Fingerprints are operation-kind
  namespaced and gate admission occurs after local request compilation but
  before ProviderRuntime dispatch. A Stop returns before the ProviderRuntime
  call. ProviderAttempt retries remain within the same admission; known attempt
  ordinals are forwarded, and settled-result replay does not create a new
  admission.
- Shared `durableProgress` is accumulated only from a committed successful
  sourced action result or explicit durable action commit. Failed, Denied,
  Interrupted, OutcomeUnknown, failed-persistence fallback, ProviderResult,
  output-only, Step/cursor-only, and P9-only replay evidence do not reset D2/D4.
  D2 semantic action identity binds route/action name/canonical JSON arguments,
  excludes `callRef` and other ephemeral ids, and is not used as an authority
  or recovery-binding hash.
- The follow-up closes the Conversation checkpoint D5 error path: the provider
  call is matched, the end bracket runs for typed success or failure, and the
  exact original provider error is re-failed afterward. A success contributes
  its actual `attemptNo`; a failure contributes `undefined` rather than a
  fabricated ordinal. The driver omits `retryCount` when no ordinal is known
  while still ending the lease-scoped in-flight bracket.
- The P12 RuntimeSafety Attention fixture now uses the parsed `workId` in both
  the WorkEpisode JSON and the source binding. The exact read-model test derives
  one `RuntimeSafetyStop` Attention fact for that consistent Work binding; no
  production logic or assertion was weakened.
- P9 reconciliation/unknown-effect precedence, D2/D4 counter thresholds and
  restart behavior, `MAX_TURNS`, settlement, schema/ports, and provider wire
  contracts remain unchanged. No authority hash or new durable safety state is
  introduced.

## Verification performed

- P3 driver focused coverage: **6 passed** — compiled admission/Stop-with-zero
  provider calls, successful and failed action progress, overflow plus
  replacement, and settled Provider result replay without new admission.
- P12 runtime-safety test file: **29/29 passed**.
- Conversation checkpoint + Attention focused tests: **3/3 passed**, including
  failure bracket order, exact `ProviderFailure` propagation and undefined
  attempt ordinal.
- `pnpm exec tsc -b packages/agent-runtime --pretty false` — PASS.
- Biome on the six P12 follow-up TypeScript files — PASS.
- `git diff --check` for the P12 implementation/follow-up — PASS.
- `pnpm exec tsc -p tsconfig.test.json --noEmit --pretty false` was also
  attempted but is currently blocked by an unrelated S3 diagnostic at
  `apps/single-workspace/test/any-producer-evidence.test.ts:387`:
  `anyProducerSettledWaits` is not a property of `AttentionFacts`. That file is
  outside the reviewed P12 commits; this review does not claim full test
  typecheck or repository-wide green status.

No real Provider or daemon was run. Existing untracked fixture directories
were preserved and not edited.
