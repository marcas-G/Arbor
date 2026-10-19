# Native OS Sandbox Wave D — implementation checkpoint

**Status:** PARTIAL CHECKPOINT — Wave D is not closed.
**Baseline:** `fe74e07d23987773746309c077329e55b5ae09f6`, followed by Wave C
commits `2160746`, `a73f650`, and `2ee197d`.
**Scope completed here:** schema-50 provider-unavailable storage, P9 atomic
fact/queue/wake and replay gate, P10 queue service/rebuild re-arm, Attention and
Workspace Detail projections, and safe Web rendering.

## Implemented

- P9 allocates the wake EventId, validates the exact current immutable policy
  and live lease fence, then writes the immutable fact and P10 queue before
  appending `SandboxProviderUnavailable(v1)` through the journal. All writes
  share one transaction. Exact retries return the original fact/event; binding
  conflicts and stale fences fail closed.
- P9 checks the current policy head and exact existing fact before dispatch.
  A matching fact returns `RecoveryBlocked` without another dispatch/provider
  call. A conflicting fact fails closed.
- P10 claims bounded due queue batches with fresh IDs, expiry, and attempt
  counts; consume verifies the exact current claim, immutable fact, active
  Execution/Episode and policy head before marker+ACK. Stale claims cannot
  consume. Full Attention reset re-arms retained facts in the same caller
  transaction; the next poll reconstructs the marker.
- Workspace Detail exposes only the accepted path-free policy fields and
  `Configured`/`Unavailable` status. P10 projects provider-unavailable and
  strict read-only `SandboxRecoveryBindingFailure` Attention. RecoveryBinding
  derivation checks canonical bytes/hash, stored SHA format, exact P4 intent,
  P3 action/step identity and canonical argument digest. Invalid time/hash
  fails closed; reads create no marker/event/fact/rebind state.
- The existing HTTP/Web DTO surfaces include both new Attention source
  literals and the path-free sandbox-policy summary. The browser renders the
  fixed safe summaries and policy status without repair/rebind controls.

## Verification

| Check | Result |
|---|---|
| Targeted TypeScript builds: ports, application, projection-runtime, persistence-sqlite, execution-runtime, single-workspace | PASS |
| Web production build and Web TypeScript check | PASS |
| Targeted Vitest: P50 fact/queue, P50 RecoveryBinding, P50 poll, P10 Attention/Workspace Detail, P9 no-reprobe | 6 files / 41 tests PASS |
| Targeted Web Vitest: Attention and Workspace pages | 2 files / 22 tests PASS |
| Biome on 27 changed files | PASS |
| `git diff --check` | PASS |

The queue store test uses two independent SQLite connections racing for one
Pending row; exactly one receives the claim. A test-local SQLite trigger also
proves the P9 wake event is appended only after the fact and queue rows exist.
No full `pnpm check` or `pnpm test:functional` was run, and no online database
was opened or upgraded. No provider is declared Supported or qualified here.

## Not implemented / closure gates

- The accepted owner correction for `SandboxPolicyRequiredInterruption` /
  `NeedsDecision` is pending. The current code path for a missing process
  policy still reaches the older P4 `PolicyMissing` rejection. This checkpoint
  does not claim the required nonterminal Pending/NotAdmitted interruption,
  its P10 Attention/status, or HumanIntervention wake/startup scan.
- The transient `/views` 503 mapping to `sandbox/provider-unavailable` remains
  unimplemented; the current read path has no frozen runtime trigger that can
  distinguish that transient provider result from other projection failures.
- These omissions keep Wave D open. Implement them only against the owner
  correction and its exact trigger contract; do not infer a new persisted
  Attention source or policy state from this checkpoint.
