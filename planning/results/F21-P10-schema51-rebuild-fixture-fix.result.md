# F21 P10 rebuild fixture schema-51 correction

Date: 2026-10-23

Base: `adcb524f`

Status: **IMPLEMENTED; process qualification NOT RUN**

The Story L fixture preserves its historical seed: it creates the P37/P44-era
project, activation intent, events, and P10 offset, then qualifies the image
through `upgradeSchema44TestDatabase`. Before a current-schema worker or public
query uses that image, the fixture now calls the existing
`upgradeSchema44ToCurrentTestDatabase` helper. That helper requires exact
source schema 44, applies the forward migrations and P45 verification-origin
backfill, and checks schema 51, foreign keys, and P51 event highwater facts.

No production startup rule, schema version value, P37/P44 seed fact, P10
rebuild assertion, or design document was changed.

## Verification

- `pnpm typecheck`: **PASS**.
- Biome on the changed TypeScript file: **PASS**.
- `git diff --check`: **PASS**.
- Both Story L process cases: **NOT RUN**, reserved for the root sweep.

Run these two cases after integrating this commit:

```text
pnpm exec vitest run tests/functional/process/f21-open3-p10-full-rebuild.functional.test.ts -t "P10 Story L rebuild rolls back snapshot/offset rewind on kill and linearizes an Active intent"
pnpm exec vitest run tests/functional/process/f21-open3-p10-full-rebuild.functional.test.ts -t "P10 Story L after-commit kill preserves snapshot and restarted consumer catches up"
```
