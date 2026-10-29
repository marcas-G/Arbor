# Native OS Sandbox — unified candidate checkpoint

Date: 2026-10-19

Code candidate: `28907165738d48cd3bc24226b003fc42665a3a2a`

Current HEAD also contains the docs-only owner landing cherry-pick
`7ad5c19a3e9eff0a5da33b25d228f0e22dff2643` and post-review record
`c1c4371a`; neither changes the code checkpoint below.

Status: **Wave C transactional closure complete; Wave D partial; T2 provider identities integrated; T3 open.**

This checkpoint records the unified candidate after integrating Wave D with
Wave C and adding the POSIX and Windows T2 adapters. It is not a release or
full-suite qualification.

## Status and evidence

| Area | Status | Evidence / open work |
|---|---|---|
| Wave C policy/grant and decision transaction path | **Closed** | Decision-result codecs and exact receipt/result joins; Gateway command boundary; SQLite transaction and process-crash qualification. Commits are listed below. The primary crash qualification is `packages/application/test/sandbox-policy-decision-gateway.atomic.test.ts` plus its crash child. |
| Wave D provider-unavailable recovery and surfaces | **Partial** | P9 fact/queue/wake and P3 action settlement, P10 Attention projection/polling, recovery replay, Web views, and successor resume are implemented. Remaining: production `sandboxProcessPolicy` wiring and real two-daemon SQLite qualification. Candidate-read V5 is accepted and landed; its independent post-landing review passed B0/B1/B2 = 0. These code gates are not inferred from the focused green tests. |
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

## Governance owner landing

Owner contracts were accepted and integrated by cherry-picking
`de6868febf328e0be3c3a12fa1bb82c03eb140bf` as
`7ad5c19a3e9eff0a5da33b25d228f0e22dff2643`. The commit changes only
`docs/design/**` and `planning/results/**`; it adds no production code or
database change.

- Producer Mapping Closure V3 accepted SHA-256:
  `3944B1E8BBA9A7A0EBB47988B4B67965718C94EB4EE05D9605E9711AC1FF8A8A`.
- High-Water Amendment V2 accepted SHA-256:
  `09F67CCA1DA295C08011890C96E6409990EB9A3CB45D7F555E3776925C0BA1EE`.
- Candidate Read Model V5 accepted SHA-256:
  `26B4BDAA4F79DCF2A0EA7C601A1037372A9C5308AB761663A921235076CE8D13`.

Acceptance records are
`planning/results/native-os-sandbox-v21-producer-mapping-closure-acceptance.record.md`,
`planning/results/native-os-sandbox-v21-producer-mapping-highwater-amendment-v2-acceptance.record.md`,
and `planning/results/sandbox-policy-candidate-readmodel-v5-acceptance.record.md`.
The independent post-landing review is recorded at
`planning/results/native-os-sandbox-v21-producer-and-candidate-read-postlanding-review.result.md`:
PASS, B0 = 0, B1 = 0, B2 = 0. The review clears the owner-landing gate under
the pre-existing Native Sandbox implementation authorization. Candidate Read
Model V5 grants no separate implementation authority. Wave D code gates remain
open.

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

The two independent owner post-reviews are persisted in
`planning/results/native-os-sandbox-v21-producer-and-candidate-read-postlanding-review.result.md`:
B0 = 0, B1 = 0, B2 = 0. Review sources were
`/root/native_sandbox_wave_a_review` and
`/root/sandbox_remaining_contract_review`. The reviews matched all three
accepted proposal hashes and all 23 owner postimage SHA-256 values in the
landing manifest.

Separate provider reviews remain thread-local and do not constitute a final
integrated implementation review:

- `/root/native_sandbox_posix_review`: B0/B1/B2 = 0; rerun counts `13 + 6 + 1 + 24`.
- `/root/native_sandbox_windows_review`: B2 closed; rerun counts `5 + 37`.

Full-suite and release qualification remain pending.
