# F23 / P8 Permanent RetryVerification Origin — Post-Landing Consistency Review

状态：**Design landing consistency review PASS; implementation remains separately gated**

Reviewed accepted token
`ACCEPT_F23_P8_PERMANENT_REPLAY_ORIGIN_AND_LEGACY_DISPOSITION`, proposal SHA-256
`6BEEC14ED975D7322003C95D28F63D161C82F4EFA4B584ECAA99D1120BE712CA`, and the
owning-document changes listed in
`planning/results/F23-retry-verification-permanent-replay-governance-acceptance-and-landing.md`.

## Checks

- **P8/P12:** P8 `01`/`06` require exact replay only after current P12
  visibility/authorization of the original actor/source. P12 `02` obtains the
  immutable origin as a declared snapshot via Composition and remains pure;
  P12 `10` preserves strict auth/codec/Actor binding before Resolver. No
  receipt pre-read was introduced.
- **P1 receipt order:** P1 `01`/`03` keep Gateway `BEGIN IMMEDIATE` as the
  only receipt lookup and full tuple compare. Changed summary/revision/
  successor tuple fields are not compared with origin; they reach Gateway
  only after source/current-authorization checks. Existing-row mismatch remains
  mismatch-before-JSON-decode. Origin-without-receipt has a narrow typed
  corruption/no-write branch; malformed/duplicate/corrupt origin-store facts
  fail with typed `PersistenceCorruption<"RetryVerificationOriginStore">`;
  no handler fallback is allowed.
- **Atomicity:** P1 `03` places the P8 origin in the same transaction as
  source conclusion, successor, spawn intent and receipt. P1 `04` uses a
  deferred receipt FK and immutable permanent rows; the successor verifier
  Execution ID has no FK because P8 admits/binds that Execution post-commit.
  Malformed stored origin fails with typed origin-store corruption, while an
  absent origin is a no-authority result. Migration ID is TBD and
  registry/high-water mark are unchanged.
- **Legacy:** P8/P1 require exact receipt + retained event pair + canonical
  successor/execution proof for origin backfill. Missing/pruned/conflicting
  evidence preserves the old receipt and yields UnboundLegacy plus P6 Inbox;
  no raw JSON/Session/Event guess is specified.
- **P6/P10:** P6 defines stable key
  `retry-verification-unbound:<commandId>`, current P8 governance recipient,
  same-transaction admission, no Agent promotion and no automatic clearing.
  No P10 Attention source or P10 file change was introduced.
- **Authorization scope:** the landing authorizes only these design-document
  changes and this review. No production code, DDL, schema migration
  registration/execution, tests, runtime behavior, or online DB upgrade is
  included or implied.
- **Tree boundary:** only the named design files plus acceptance/review
  records are intended for the landing commit; unrelated worktree files are
  excluded. `docs/design/**` diff/whitespace and cross-reference checks pass.

## Result

No internal ordering conflict was found among P8, P1, P12 and P6 under the
accepted fixed package. P10 remains unchanged. The migration remains an
unregistered placeholder, and implementation/qualification must be separately
authorized. This review does not claim runtime or test qualification.
