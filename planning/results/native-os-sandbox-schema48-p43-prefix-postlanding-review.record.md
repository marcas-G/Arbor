# Native OS Sandbox schema-48 P43/P44 prefix preflight — independent post-landing review

**Review date:** 2026-10-18
**Reviewed landing commit:** `cfcca39dde46564c4dbc7086873a0d293873bf32`
**Parent baseline:** `1e634f00e10ba64698d159072637d8220092ec40`
**Result:** **PASS — Blocking = 0, B1 = 0, B2 = 0.**

## Provenance and accepted scope

- Amendment token: `ACCEPT_NATIVE_OS_SANDBOX_SCHEMA48_P43_PREFIX_PREFLIGHT_AMENDMENT`.
- Accepted proposal: `planning/proposals/native-sandbox-schema48-p43-prefix-preflight-amendment.md`.
- Proposal raw SHA-256: `FA24A578C5DB37F3F864C7C7B20EC2AD36EEFB7545E699F25ABDC0671F5B1A8F`.
- The amendment is design/audit-only. The separate
  `AUTHORIZE_NATIVE_OS_SANDBOX_CONVERGENCE_IMPLEMENTATION` token remains
  ungranted.

The landing changes exactly these five files:

1. `docs/design/implementation/P1/04-sqlite-schema.md`
2. `docs/design/implementation/P10/07-acceptance.md`
3. `planning/results/native-os-sandbox-schema48-design-landing.manifest.md`
4. `planning/results/native-os-sandbox-schema48-design-postlanding-review.record.md`
5. `planning/results/native-os-sandbox-schema48-p43-prefix-preflight-amendment-acceptance.record.md`

No code, test, migration descriptor/registry, database, deployment, or release
file is changed by the landing commit. No tests or migrations were run as part
of this read-only review.

## Prefix and preflight consistency

At the reviewed current-main baseline `20b4e6470ce6865880505949a898bad4bbfa507f`,
`CURRENT_SCHEMA_VERSION` is 48 and `CURRENT_MIGRATIONS` includes P43 as
0043/`requiresUserVersion=42`, P44 as 0044/`requiresUserVersion=43`, and the
registered 0045–0048 suffix. The accepted P43/P44 activation record documents
the disposable 0042→0043→0044 chain and its qualification. Thus the complete
registered 001–0048 prefix necessarily includes the exact P43 WorkBlocker
objects and P44 approval-rejected no-effect trigger state.

The P1/04 correction now treats those inherited objects as required members
of the exact prefix, not as a reason to reject it. P10/07 correspondingly
requires their exact presence/signatures and keeps missing/altered tables,
indexes, triggers, later versions, and other signature drift fail-closed before
writes. The correction preserves 0049 (`requiresUserVersion=48`) and 0050
(`requiresUserVersion=49`) and does not weaken exact-prefix validation.

The accepted 0050 unavailable-fact/queue/marker contract and 0049 decision /
grant-provenance contract remain unchanged. No old 0043/0044 Native Sandbox
identifiers or DDL are restored, re-registered, edited, or reordered; no second
P43 descriptor/table is introduced. The closing P1/P10 text now accurately
states that P43/P44 are current registered prefix migrations, while older
preparatory records describing their earlier dormant phase remain historical
evidence rather than current activation status.

## Hash and record audit

The acceptance record binds the exact proposal hash/token and parent baseline.
Its preimage Git blobs and corrected postimages match the landing manifest:

| Owner | Baseline Git blob | Corrected postimage SHA-256 (Windows file bytes) |
|---|---|---|
| P1/04 | `00dc1afbf8873ba8dc12a4bc3695c1e0746e28a2` | `570B664D791A20A73E5BA0816C18150ECA8BF64FBF8D5846C089CFA629E2E1E8` |
| P10/07 | `7aa0181884ace08d970dfbb25a5f1cb7f06e5e18` | `6A6F7CD0C63633E81B03258991B6BD8BED183D1F5F328A8A73A0567472BC19EA` |

The postimage hashes were independently recomputed from the committed owner
blobs using the Windows CRLF byte representation. The original schema-48
landing review remains intact; its appended erratum identifies the stale
P43/P44 wording, points to the accepted correction, and leaves the separate
review of this corrective amendment pending. The new acceptance record states
that this is not implementation authorization.

## Boundary

This review covers only consistency of the accepted P43/P44 prefix correction
and its five-file landing scope. It does not qualify 0049/0050 code, migration
execution, database upgrades, platform support, or release readiness. Those
remain gated by the separate implementation authorization and its required
disposable-database TDD matrix.
