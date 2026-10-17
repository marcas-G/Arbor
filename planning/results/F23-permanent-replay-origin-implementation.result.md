# F23 P8 Permanent Replay Origin / P6 UnboundLegacy Implementation

Status: **PARTIAL — implementation stopped at the route/rebuild design gap**
recorded in `planning/results/F23-P6-owner-route-and-rebuild-design-gap.md`.

## Authorization and boundary

- Implemented under `AUTHORIZE_F23_P8_PERMANENT_REPLAY_ORIGIN_IMPLEMENTATION`.
- Fixed plan: `planning/proposals/F23-permanent-replay-origin-implementation-plan.md`, raw SHA-256 `766E98259DB5D520B436A0D3D927484B539C75497E2294C5A42AE8AAF88579DB`.
- P45 SQL raw SHA-256: `6aca51f02e0d7cb5ce7777fe84968bb3e54b32b2ece24ce2697687e9555f4ea4`.
- Typed P45 backfill source raw SHA-256: `3445512013678AB71F413FB9EEA29A55338662B0D656C1BD427EB21CB8774F70`.
- Offline descriptor composite pin (SQL hash + LF + backfill source hash): `C7C934D2929FDA3AC9928D0CE4DA25C9B4B6DC7B532581F5A18C144A6CE1834F`.
- The exact disposable schema-44 source schema signature is pinned as `3cbae01c8835a1b4e40d62660725f15f746b04f06e2b08aca94eedc66c9d6ce7`. Its content digest and P44 prefix are measured by the CLI qualification; the test asserts the source remains unchanged after copy/upgrade.
- No `docs/design/**` changes, preserved/online database access, deployment, or release action was performed.

## Implementation

Migration 0045 requires schema 44, is offline-only for an existing runtime database, creates the permanent origin and immutable `UnboundLegacy` disposition relations, adds immutable-origin triggers, and rebuilds `inbox_entries` preserving its seven existing values/key plus revision 1 and `updated_at=admitted_at`.

Successful `RetryVerification` writes its exact permanent origin in the same Gateway transaction as the verification handoff and receipt. Resolution consults the origin only after current principal/project/source authority is re-established. Gateway remains the only receipt lookup and exact-tuple comparison point. A present origin with a missing receipt fails as safe persistence corruption before handler effects. Offline legacy backfill creates an origin only from the exact receipt/event/canonical successor proof; otherwise it preserves the receipt, records one immutable `UnboundLegacy` disposition, and creates one stable-key Governance Inbox row. Unknown or ambiguous routing aborts the entire migration transaction.

P6 projection and read paths derive recipient from the current canonical source Work/Verification/Workspace, validate stored route evidence, expose the typed target only to the authorized current root/direct-Parent human, and never consume the Inbox row. Rebuild works from the disposition plus canonical rows, independently of receipt/event retention. The helper moves the same Inbox key, preserves admission time, increments revision once and updates `updated_at` with the canonical owner/Parent change in the same transaction; no-op reconciliation leaves the row unchanged.

The legacy proof also requires event revisions to agree exactly with each
other and with the canonical source Verification; the source Verification and
Work must match the receipt Project/Work identity. The canonical Work revision
may advance beyond the frozen verification revision but cannot be below it.
Mismatched receipt-to-canonical source identities abort the P45 transaction;
they never create an origin or an FK-inconsistent disposition.

The offline upgrade CLI now accepts an exact schema-44 copy source and commits only migration 0045 after validating the pinned schema signature. Manifest state records the direct 44→45 transition. A fresh target still builds through 45. Ordinary runtime migration refuses to apply P45 to a populated schema-44 database.

The repository has no current P1 command that mutates `works.workspace_id` or
`workspaces.parent_workspace_id`, and no production `rebuildProjection` call
site. The route helper is transaction-tested but there is no command/production
rebuild boundary to qualify; implementation stopped rather than invent either
surface.

## Qualification

| Qualification | Result |
|---|---|
| P45 DDL, Inbox preservation/revision, immutability, transaction route rollback/commit and rebuild | PASS, 1 file / 4 tests after final formatting |
| P10 current-authority filter | PASS, 1 file / 3 tests after final formatting |
| Backfill strict proof and targetWorkRevision mismatch; receipt Work/Project mismatch rollback | PASS, 1 file / 5 tests after B1 review |
| Offline exact disposable schema-44 copy → 45, source remains 44 and unchanged, target FK and manifest commit | PASS, 1/1 after final formatting |
| Fresh target through schema 45 | PASS, 1/1 in focused run before final formatting; included in the full `pnpm check` core suite |
| P8 public exact same-CommandId/payload receipt replay and safe corruption/authorization branches | PASS, 1/1 after final formatting |
| Existing P1 exact-tuple receipt integrity suite | PASS, 9/9 (schema-45 disposable fixtures) |
| `pnpm lint` | PASS, 1200 files |
| `pnpm typecheck` | PASS |
| `pnpm build` | PASS |
| P39 cumulative-prefix suffix expectation | PASS, 2/2 after updating historical source-prefix expectation to schema 45 |
| Full `pnpm check` | Not completed: prior attempts exposed stale schema-44 expectations; the next attempt was stopped for the independent review-requested B1 and route/rebuild gap audit. |
| Full `pnpm test:functional` | Not run; focused public-process tests above are not a substitute for the full suite |

These results qualify the safe P8/origin/backfill implementation portions only.
They do not close the P6 owner-route/production-rebuild gap, do not claim
release readiness, and do not close unrelated F23/AH7/AH10 work.
