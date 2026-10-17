# F23 P8 Permanent Replay Origin / P6 UnboundLegacy Implementation

## Authorization and boundary

- Implemented under `AUTHORIZE_F23_P8_PERMANENT_REPLAY_ORIGIN_IMPLEMENTATION`.
- Fixed plan: `planning/proposals/F23-permanent-replay-origin-implementation-plan.md`, raw SHA-256 `766E98259DB5D520B436A0D3D927484B539C75497E2294C5A42AE8AAF88579DB`.
- P45 SQL raw SHA-256: `6aca51f02e0d7cb5ce7777fe84968bb3e54b32b2ece24ce2697687e9555f4ea4`.
- Typed P45 backfill source raw SHA-256: `783363d3186437384e79536ae7aab797fd70411db961202cc95dfe7f4a650137`.
- Offline descriptor composite pin (SQL hash + LF + backfill source hash): `0879d97482f8be09644497496de3e946a91008a38b6723cc7faf73b76f052244`.
- The exact disposable schema-44 source schema signature is pinned as `3cbae01c8835a1b4e40d62660725f15f746b04f06e2b08aca94eedc66c9d6ce7`. Its content digest and P44 prefix are measured by the CLI qualification; the test asserts the source remains unchanged after copy/upgrade.
- No `docs/design/**` changes, preserved/online database access, deployment, or release action was performed.

## Implementation

Migration 0045 requires schema 44, is offline-only for an existing runtime database, creates the permanent origin and immutable `UnboundLegacy` disposition relations, adds immutable-origin triggers, and rebuilds `inbox_entries` preserving its seven existing values/key plus revision 1 and `updated_at=admitted_at`.

Successful `RetryVerification` writes its exact permanent origin in the same Gateway transaction as the verification handoff and receipt. Resolution consults the origin only after current principal/project/source authority is re-established. Gateway remains the only receipt lookup and exact-tuple comparison point. A present origin with a missing receipt fails as safe persistence corruption before handler effects. Offline legacy backfill creates an origin only from the exact receipt/event/canonical successor proof; otherwise it preserves the receipt, records one immutable `UnboundLegacy` disposition, and creates one stable-key Governance Inbox row. Unknown or ambiguous routing aborts the entire migration transaction.

P6 projection and read paths derive recipient from the current canonical source Work/Verification/Workspace, validate stored route evidence, expose the typed target only to the authorized current root/direct-Parent human, and never consume the Inbox row. Rebuild works from the disposition plus canonical rows, independently of receipt/event retention. The helper moves the same Inbox key, preserves admission time, increments revision once and updates `updated_at` with the canonical owner/Parent change in the same transaction; no-op reconciliation leaves the row unchanged.

The offline upgrade CLI now accepts an exact schema-44 copy source and commits only migration 0045 after validating the pinned schema signature. Manifest state records the direct 44→45 transition. A fresh target still builds through 45. Ordinary runtime migration refuses to apply P45 to a populated schema-44 database.

The repository has no current P1 command that mutates `works.workspace_id` or `workspaces.parent_workspace_id`; therefore route-move evidence exercises canonical Parent update plus Inbox movement in one `TransactionPort` transaction (rollback and commit sides), but does not claim a daemon-level owner-move command/crash qualification. No new owner-move command was introduced.

## Qualification

| Qualification | Result |
|---|---|
| P45 DDL, Inbox preservation/revision, immutability, transaction route rollback/commit, rebuild, backfill, P10 current-authority filter | PASS, 3 files / 9 tests after final formatting |
| Offline exact disposable schema-44 copy → 45, source remains 44 and unchanged, target FK and manifest commit | PASS, 1/1 after final formatting |
| Fresh target through schema 45 | PASS, 1/1 in focused run before final formatting; included in the full `pnpm check` core suite |
| P8 public exact same-CommandId/payload receipt replay and safe corruption/authorization branches | PASS, 1/1 after final formatting |
| Existing P1 exact-tuple receipt integrity suite | PASS, 9/9 (schema-45 disposable fixtures) |
| `pnpm lint` | PASS, 1200 files |
| `pnpm typecheck` | PASS |
| `pnpm build` | PASS |
| `pnpm check` | IN PROGRESS at result creation; record final outcome before commit |
| Full `pnpm test:functional` | Not run; focused public-process tests above are not a substitute for the full suite |

These results qualify the authorized implementation scope only. They do not claim release readiness or close unrelated F23/AH7/AH10 work.
