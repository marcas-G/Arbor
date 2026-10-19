# Native OS Sandbox — unified candidate checkpoint

Date: 2026-10-19

Candidate: `28907165738d48cd3bc24226b003fc42665a3a2a`

Status: **Wave C transactional closure complete; Wave D partial; T2 provider identities integrated; T3 open.**

This checkpoint records the unified candidate after integrating Wave D with
Wave C and adding the POSIX and Windows T2 adapters. It is not a release or
full-suite qualification.

## Status and evidence

| Area | Status | Evidence / open work |
|---|---|---|
| Wave C policy/grant and decision transaction path | **Closed** | Decision-result codecs and exact receipt/result joins; Gateway command boundary; SQLite transaction and process-crash qualification. Commits are listed below. The primary crash qualification is `packages/application/test/sandbox-policy-decision-gateway.atomic.test.ts` plus its crash child. |
| Wave D provider-unavailable recovery and surfaces | **Partial** | P9 fact/queue/wake and P3 action settlement, P10 Attention projection/polling, recovery replay, Web views, and successor resume are implemented. Remaining: production `sandboxProcessPolicy` wiring, real two-daemon SQLite qualification, and first-decision V5 acceptance/landing. These gates are not inferred from the focused green tests. |
| T2 provider identities | **Integrated; experimental only** | Composition advertises Linux `linux-bwrap`, macOS `macos-seatbelt`, and Windows `windows-mxc`, `windows-elevated-dedicated-user`, `windows-restricted-appcontainer-job`. All remain `Experimental`, publish empty profile/network tuples, and return typed `Unavailable`. No TrustedLocal fallback or process spawn is enabled. |
| T3 enforcement and release qualification | **Open** | No provider is `Supported`; filesystem/network enforcement, broker behavior, process-tree cleanup, limits, and stop behavior are not qualified. No release claim. |

## Commit set

Wave C transaction path:

`2160746e92d574d0221a53dd53a225479a5eb255`,
`a73f6509df5edb35ae27ae784a2b46f98cb5cc26`,
`2ee197dc0c047dfb55d4334837b897b923277c06`,
`788cb39a14ef66aeb68bd9d5ed4d7bbe5fe71733`,
`56c80e4121b6cf694f2b4ad9b0287adc45a00e79`,
`b44aa6c716f8ce0a74aa6b2f99aba0e6ac028350`,
`ed581a785162c365a08c679d0739d142919e1436`,
`844bf809418916e28376fa9c2ae4d4d520746cd5`,
`40b879d3b94d2a8cfe1ae9bbdeb991e971e0ceca`,
`bfdf9fd15756aa9bc679056b97bcb13c6a97b985`,
`b205d9a8980bf9cab2e1375000cefb3209a1a2bc`,
`7c35e1f78821db45f5b093054e6f45146368cab7`.

Wave D implementation and C/D integration:

`8e2cec9548590b4b235f0b1a093afd103fc75775`,
`d49f74e32a60c18e86bdeeb78f05cafaadbedd03`,
`a0e6484170cc1cdebe4410b461acba24bdc14a88`,
`5a681da1b2d088fcd7d378e5774a7383cf03ac35`,
`d884ca924206b75bf5606fc4ed196c782ac0bc1e`,
`ddee0d16fe6ee6ccf1bab7a2ad1c7878dc6fd0ed`,
`4539ec5e1492185b569bd9a2c39c687e1c1240b5`,
`e1b6e2ebbbd75ab0235949bcd978bf760a31efb8`,
`001a63307a2d82628eecb1fbb10857ce6351dec7`,
`65ddc857360ad966cc0ae687cf49c1f3b6d74ca3`,
`560c85422b7fe428f8131c583d039296c10d4b75`,
`b328a755dbd2f945fede7f66810310eaee7271b9`.

T2 provider adapters and final integration:

`1fea700acf29ddb060d7874ad61c8b6962920cbf`,
`0323859b7bb435faa97d5f20b882727e52f8aaf6`,
`301655b283c5b4d307abe2df9ccb237e2239ad98`,
`552a07d32fba104761088acf660a034fe37793fe`,
`28907165738d48cd3bc24226b003fc42665a3a2a`.

## Tests and checks

Focused checks on the unified candidate included:

- Provider and domain tests: 4 files / 40 tests passed —
  `adapters/sandbox-native-posix/test/native-posix-policy.test.ts`,
  `adapters/sandbox-windows/test/windows-provider.test.ts`,
  `packages/domain/test/events.test.ts`,
  `packages/domain/test/sandbox-policy.test.ts`.
- Architecture boundary tests: 3 files / 29 tests passed —
  `tests/architecture/native-os-sandbox-windows.test.ts`,
  `tests/architecture/sandbox-process-boundary.test.ts`,
  `tests/architecture/p11-closure.test.ts`.
- P5 composition provider registration, `apps/single-workspace/test/p5-composition.test.ts`:
  1/1 passed; all five IDs were observed with Experimental status and empty
  tuples.
- P12 production composition, `tests/p12-production-composition.test.ts`:
  5/5 passed.
- P9 dense SSE lease-renewal process qualification,
  `tests/functional/process/p9-dense-sse-lease-renewal.functional.test.ts`,
  using a schema-50 disposable fixture: 1/1 passed.
- Wave C SQLite transaction/crash target:
  `packages/application/test/sandbox-policy-decision-gateway.atomic.test.ts`
  and `packages/application/test/sandbox-policy-decision-gateway.crash-child.ts`;
  the closed qualification commits are `bfdf9fd1`, `b205d9a8`, and `7c35e1f7`.
- `pnpm build`, `pnpm typecheck`, full `pnpm lint` (Biome, 1,278 files), and
  `git diff --check`: passed.

The schema-48-named historical fixtures remain available for exact migration
tests. Disposable fixtures used by current composition/functional tests now
apply migrations 0049/0050 and verify schema 50. No online database was opened
or upgraded.

## Independent reviews

Two independent reviews were supplied in the integration task thread; neither
has a persisted repository review artifact or hash yet:

- `/root/native_sandbox_posix_review`: B0/B1/B2 = 0; rerun counts `13 + 6 + 1 + 24`.
- `/root/native_sandbox_windows_review`: B2 closed; rerun counts `5 + 37`.

These are scoped provider-review results, not final integrated review records.
Persisted final review evidence and full-suite qualification remain pending.
