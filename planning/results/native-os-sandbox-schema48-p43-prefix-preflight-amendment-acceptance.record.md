# Native OS Sandbox schema-48 P43/P44 prefix preflight amendment acceptance

**Date:** 2026-10-18
**Decision:** User accepted `ACCEPT_NATIVE_OS_SANDBOX_SCHEMA48_P43_PREFIX_PREFLIGHT_AMENDMENT`.
**Accepted proposal raw SHA-256:** `FA24A578C5DB37F3F864C7C7B20EC2AD36EEFB7545E699F25ABDC0671F5B1A8F`.
**Baseline:** `1e634f00e10ba64698d159072637d8220092ec40`.
**Implementation authorization:** NOT GRANTED.

The accepted proposal is
`C:\Users\ThinkPad\.codex\worktrees\native-sandbox-governance\Arbor\planning\proposals\native-os-sandbox-schema48-p43-prefix-preflight-amendment.md`.
It corrects a preflight-description contradiction in the already accepted
schema-48 Native OS Sandbox landing. The current schema-48 migration registry
includes P43 as 0043/requires42 and P44 as 0044/requires43. Their
`work_blockers`, `inbox_workspace_sequences` and P44 observation-trigger
state are part of the complete registered 001–0048 prefix and are preserved.

The precise landing is limited to:

- P1 `04-sqlite-schema.md`: 0050/requires49 verifies, rather than rejects,
  the exact inherited P43/P44 state in the complete schema-49 prefix.
- P10 `07-acceptance.md`: qualification requires that inherited state and
  rejects missing/altered prefix objects or signatures, not their expected
  presence.
- Corrigenda to the accepted landing manifest and original post-review record.

0049 remains `requiresUserVersion=48`; 0050 remains
`requiresUserVersion=49`. No prior migration number, SQL body, signature,
registration, or acceptance is changed. Exact-prefix and fail-closed
preflights are preserved; no second P43 descriptor or table is created.
Top-level Scenarios/System Design/DID versions do not advance.

This is a design-only correction. No code, test, migration registry,
database, deployment or release was changed. No migration was registered or
executed, no database was upgraded, and no tests were run. The distinct
`AUTHORIZE_NATIVE_OS_SANDBOX_CONVERGENCE_IMPLEMENTATION` token remains
ungranted. Independent post-landing review of this amendment is pending.
