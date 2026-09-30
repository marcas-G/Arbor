# Provider Recovery / Composition Convergence — Result

## Status

**COMPLETE / VERIFIED — 2026-09-30.**

## Correctness fixes

- Turn failure/cancellation/timeout settlement now uses first-writer-wins CAS
  (`settled_at IS NULL`) and rejects stale zero-row updates.
- Recovery `failTurn` now rejects a lost CAS instead of reporting an
  unpersisted failure mark.
- A stale Worker can no longer overwrite a previously successful Turn's
  `finish_reason` or `usage_json` and invalidate its success evidence.
- ProviderTurn recovery reads time from the injected Clock; missing or invalid
  persisted deadlines fail closed and never create a retry plan.
- Inline SecretStore resolution is restricted to `arbor:inline-secret`; every
  other SecretRef returns typed `SecretNotFound`.

## Composition cleanup

- Removed the obsolete `SliceDirectiveHandlers` graph that AgentDriver no
  longer consumed.
- Removed the second `CommandGatewayLive` construction at the final Layer
  return; the gateway already present in `coreAll` is the single instance.
- Corrected the `SliceConfig.authenticator` comment to describe the actual
  local-single-user fallback.

## Regression evidence

- stale Worker terminal-overwrite regression: PASS
- failed-Turn CAS regression: PASS
- malformed deadline recovery regression: PASS
- Inline SecretRef isolation regression: PASS
- production composition architecture regression: PASS
- provider recovery/runtime focused suites: PASS
- lint: PASS (778 files)
- typecheck: PASS
- architecture: PASS (116/116)
- core tests: PASS (1481 passed, 1 skipped)
- web typecheck/build: PASS
- web tests: PASS (211/211)
- git diff check: PASS

## Remaining structural work

`provider-turns.ts` still combines intent, attempt journal, settlement evidence,
recovery and usage read paths. It should be split as a separate
behavior-preserving phase after these repaired invariants are committed.
