# Release-base code convergence ledger

## Integration spine and commits

Integration worktree branch `codex/full-code-convergence` is rooted at release
commit `9db9a6cc9b49c4385275944301e5540cfd041be9`. This is intentionally the
code spine; production code from combined-design candidate `ca07` was not
merged. The accepted combined-design owner package was overlaid separately in
`7c1b0b2` after all 45 owner-postimage hashes matched the `251b47d` manifest.

| Module | Source / integration commits | Disposition |
|---|---|---|
| Accepted owner postimages + acceptance/manifest/postreview records | `251b47d` manifest; integration `7c1b0b2` | Already present on the integration branch; 45/45 hashes verified |
| P15 | accepted source `6d556c3…`; integration `472ffc7` | Cherry-pick; targeted root/Web tests, typecheck, and Biome passed |
| P8 | accepted source `b15855c7…` + review `6aaa…`; integration `c8dd386`, `c729dd0` | Ported retry verification; shared runtime conflicts retained both P8 and release P38 behavior |
| P39 V1 + DeniedUnbound | accepted final `60df2fe…` + review `bd5…`; integration sequence ending `72fe6e2`, qualification/fixes `bc405af` | Semantic port; V2 visibility and unaccepted fallback/draft material excluded |
| Blocked final implementation | accepted final `a1fe1f20…`; B0 review | Final net tree diff only, committed as `5c010bb`; no intermediate branch commits were replayed |
| P40 authenticated observation replay | accepted final snapshot `52632fbb…` + B0 | Ported as one final-tree semantic slice; authenticated P39 selection, P4 observation evidence store/codec, P3 handoff, and P9/P10 recovery projection are included |
| P41 physical WIP | `8a39cce…` | Excluded; WIP was not cherry-picked or merged |
| F21 source attribution | accepted semantic-port package; integration commits `c58a5b93`, `8f34c93d`, `9fff6f14` | Ported with the CreateProject resource-source contract, idempotent gated 0042 descriptor, and final evidence record |

## Conflict and overlap ledger

| Shared file / surface | Resolution |
|---|---|
| `packages/agent-runtime/src/agent-loop-actions.ts` | Combined P8/P39 identity and policy-revision types with Blocked denial/evidence types and behavior |
| `apps/single-workspace/src/registry.ts` | Kept the release/P15 registry factory and added Blocked Deliver/Inbox sequenced admission; did not invent an Inbox dependency on `SelectCurrentWork` |
| `apps/single-workspace/src/transport/composition.ts` | Combined P39 fingerprint version with Blocked wake signal/store wiring; existing Release authority/CAPA paths retained |
| `adapters/persistence-sqlite/src/index.ts` | Exports both P39 maintenance adapters and the dormant P43 descriptor/store |
| `apps/single-workspace/src/executable-tool-handler.ts` | Required release `executionFence` stays direct; optional P39 identity fields remain conditional |
| Tool runtime / codec / catalog / attention | P8/P39 and Blocked changes were semantically combined; release P38/CAPA/CreateProject/ResourceBoundary behavior was not reverted |

## Migration ledger

| Version / descriptor | Current state on this branch |
|---|---|
| 0039 / P39 | RecoveryBinding V1 + DeniedUnbound code is present behind the separate P39 maintenance suffix; it is not in `CURRENT_MIGRATIONS` |
| 0040 / P40 | Descriptor and observation replay code are present, but 0040 remains standalone/unregistered; current migration remains P38 |
| 0041 / P41 | Not ported; current migration remains P38 |
| 0042 / F21 | Descriptor and source-attribution code are present, but 0042 remains unregistered because the cumulative 0039–0041 prefix is not integrated |
| 0043 / Blocked | Descriptor/store exported for implementation tests only; requires user version 42, is absent from `CURRENT_MIGRATIONS`, and was not run against any existing database |

Verified source expression remains `CURRENT_MIGRATIONS = P38_MIGRATIONS`.
P39 claim/fault tests use isolated disposable SQLite; the P43 schema test uses
an isolated fixture with an explicit test-only prefix. No user/preserved DB,
deployment, or live instance was touched.

## Final verification

- P39 targeted suite: 8 files, 53 passed, 4 Windows ACL-dependent cases skipped
  when the PowerShell module was unavailable; explicit OS module path and
  private disposable ACL fixtures were used for the final Blocked restart run.
- P39 atomic receipt/binding/attempt-zero claim test: 2/2 passed.
- Blocked target: 10 files, 27/27 passed, including SQLite `runDaemonOnce`
  restart 2/2.
- F21 source-attribution target: 9 files, 51/51 passed; preserve-only CreateProject
  v1 receipt: 1/1 passed.
- P40 targeted qualification: 12 files, 71/71 passed (the four non-P40 domain
  event catalog cases were filtered from that combined run); the full domain
  event test file passed 5/5 separately.
- Web Work Detail render target: 27/27 passed.
- `pnpm typecheck` passed after the accepted F21/P40 ports; Biome over the P40
  integration TS/TSX delta (41 files) passed; earlier Blocked/P39/F21 Biome and
  minimal TypeScript gates passed; `git diff --check` passed.
- No full functional suite, full workspace build, migration on an existing
  database, deployment, or live process was run.
