# Release quick hardening — 2026-10-24

Base: `4ba4297d8d519c417f9cd14da9421df9eaba00d7`.

Status: **targeted hardening PASS; not final release qualification**.

## Changes

- Upgraded Web `zod` from `4.6.5` to patched `4.6.6`, retained the exact-pin
  contract, and regenerated the lockfile.
- Aligned the operator README, Chinese first-release guide, and CLI usage text
  with the registered schema-52 runtime. Preserved-database upgrades remain
  explicitly unsupported; `copy` / `resume-copy` are documented only for
  disposable qualification fixtures.
- Routed an unregistered schema version on a prior committed direct-child
  AssignWork receipt through the existing P9 `ReceiptMismatch` disposition,
  matching the accepted F23 corruption boundary. Ordinary routes without that
  disposition continue to fail closed.
- Updated the four promoted P8/F23/AH10 release cases to use the current schema
  fixture. The RecordVerificationEvidence takeover fixture now supplies the
  production `CommandHandlerRegistry` and asserts that replay does not sample a
  replacement clock after the first durable ActionIntent timestamp.

No `docs/design/**` file changed. No real Provider, Native OS sandbox, or
preserved user database was used.

## Verification

- `pnpm audit --prod --registry=https://registry.npmjs.org`: PASS, no known
  vulnerabilities.
- `pnpm typecheck`: PASS.
- Provider reasoning round-trip selection: 4 files / 30 tests PASS.
- Web dependency-pin selection: 1 file / 3 tests PASS.
- Full Web Vitest: 34 files / 266 tests PASS.
- Verification control actions: 1 file / 24 tests PASS.
- Promoted release process selection, zero retry: 4 files / 12 tests PASS:
  stable verification evidence time, criterion snapshot, permanent
  RetryVerification replay, and exact-tuple receipt integrity.
- Schema-upgrade CLI argument selection: 1 PASS / 24 skipped.
- Targeted Biome, build, Web production build, and `git diff --check`: PASS.

The complete schema-upgrade operator file was stopped after several minutes
without progress output; its focused CLI contract selection passed. No full
`pnpm check`, full release functional run, package run, browser run, or S1–S4
real-provider campaign is claimed here.

## RC disposition

The four promoted cases now pass together, but the RC board item remains OPEN
until a frozen final candidate produces the required complete-coverage release
report. RAI-DG-02, Submitted DecisionEpisode corruption, Native OS isolation,
preserved-database upgrade support, and real-provider S1–S4 retain their prior
status.
