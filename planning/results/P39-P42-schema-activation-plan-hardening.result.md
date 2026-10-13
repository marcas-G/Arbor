# P39–P42 schema activation plan hardening

Date: 2026-10-13
Base for review revision: `cf3fcc3186e3418b8180c055bb614e2092ab7890`
Scope: documentation only; no design documents or production code changed.

This revision closes the review findings against the implementation plan:

- A P39 `P39_LEGACY_DB_ISOLATED` outcome permanently isolates that exact target
  for audit under the frozen DID contract. Its version remains at the
  preflight version, but it is not eligible for `resume-copy`; neither the
  migration nor later descriptors may be retried on it absent future
  governance. The blocker report and terminal manifest record bind the
  disposition to the target. Qualification must prove subsequent resume
  attempts are refused before any migration is invoked.
- `fresh` and `copy` require a new, protected provenance manifest. It records
  source/target path and stable file identities, backup completion, initial
  and current committed prefix, deterministic logical content digests, random
  nonce, and hash-chained Prepared/Committed transitions. `resume-copy`
  requires `--copy-manifest` and validates target identity, nonce, chain,
  prefix, digests, and P39 blocker evidence before it can continue. Ambiguous
  commit/manifest windows can be reconciled only against the exact prepared
  transition; all other mismatches fail closed.

The plan remains implementation closure of accepted design. Any true semantic
conflict must be raised as a Design Gap, not resolved in the plan. The separate
implementation authorization boundary is unchanged.

Updated implementation-plan SHA-256:
`0582D980581173AB63501192F65630D928AA818D7E4DD86EED56E985D0897F86`

## Verification

- `git diff --check`: PASS.
- No tests or builds were run, as requested for this documentation-only change.
- No design documents, production code, migration registration, databases,
  daemon, deployment, or release were changed or operated.
