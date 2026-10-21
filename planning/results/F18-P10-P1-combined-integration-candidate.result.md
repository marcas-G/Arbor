# F18 / P10-P1 combined integration candidate

Date: 2026-10-21
Status: **combined candidate; full gates and release qualification open**

## Inputs and replay

- Common base: `6c70f46cdfc0bb6ab35de15c24880dfbc99df274`.
- Pre-intent/ProviderTurnId V2 input: clean
  `3a9bad7261f22f26e362a10642ce47dd665e79c6`.
- F18 input: clean `60383ab9e9756cd5b34d4c030a97023055ee9290`.
- All 29 commits in `6c70f46c..60383ab9` were cherry-picked in
  `git rev-list --reverse` order. No commit was skipped. The source commit
  `bd0a4fb3` required the three owner-document resolutions below; subsequent
  code overlaps auto-merged without a textual conflict.

## Owner-document integration

Both independent accepted packages used DID version 1.58. The combined
candidate retains the already-landed pre-intent header (`v1.58`, superseding
`v1.57`) and includes both packages' accepted governance sections under that
version. It does not invent a `v1.59` or change either package's semantics.
The F18 source landing record and SHA manifest continue to attest the F18
source landing, not the byte-identical state of these combined owner files.

- `docs/design/03-detailed-implementation-design.md`: retained the pre-intent
  ProviderTurnId V2 section and added the accepted F18 section.
- `docs/design/implementation/P1/04-sqlite-schema.md`: retained the pre-intent
  stale-receipt section and added the accepted F18 schema-51 section.
- `docs/design/implementation/P13/03-view-rendering.md`: retained the
  pre-intent CandidateRead section and added the accepted F18 Verification
  projection section.

Raw SHA-256 of the resulting owner files on this checkout, in the order above:

```text
17B2F36DE6E1154C1AF3401A9E39A3A711CB62D6D8469E976283D454AFA0F63E
8970FFF196541CB2BB9741C2FE8C60BBC5357DBAB86A0B2F84BB98E494CF3E7E
4766C71C2D887717029EF90F8566EFF029F9EC7E3AD9E5FC0BC2C84BD6CBD570
```

This is an additive integration disposition, not a new manual-governance
decision or a claim that the source landing manifest hashes describe the
combined files.

## Candidate gates

- `pnpm build`, `pnpm --filter @arbor/web build`, `pnpm typecheck`: pass.
- `pnpm architecture`: 37 files / 194 tests passed.
- `pnpm lint`: 1,358 files checked, no fixes.
- F18/P9 focused Vitest: 13 files, 91 passed and 1 expected fail.
- ProviderTurnId/CandidateRead/P1 focused Vitest: 4 files / 32 passed.
- P38 public functional file with one worker and zero retry: 14/14 passed.
- `git diff --check 3a9bad72 HEAD -- . ':!planning'`: pass. The unfiltered
  `git diff --check 3a9bad72 HEAD` reports nine pre-existing F18 Markdown
  hard-break trailing-space lines in the SHA-pinned proposal, plan and result
  records. Their accepted bytes were not rewritten merely to silence the
  whitespace diagnostic.

No full `pnpm check`, full `pnpm test:functional`, or Playwright gate was run
on this combined candidate. F18 final closure, latest-head independent review
of later compatibility tests, and release qualification remain separately
open; targeted results here do not discharge those gates.
