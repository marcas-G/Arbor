# P36 Web 401 Session-Gate Test Fixture Integration

Date: 2026-10-11  
P36 integration base: `2bfd6dff0084ddd7b81017d30c764e75a4ff1c37`  
Web fixture source commit: `d83496570c7b6d7cb1acf8e75ce95a11adb7a5e5`  
Selective integration commit: `6fd6ff90f6bcd3783b9cd937977dcb16573db50b`  
Diagnostic-redaction follow-up: `066d36344867b23f34ad3588a5b5eef813e98110`

## Failure history and diagnosis scope

The first full `pnpm check` at the P36 candidate recorded Web **234/235**; the
single failing case was `a 401 unauthenticated view problem blocks content and
offers re-login`, which exceeded Vitest's 5-second test timeout. This record
preserves that history; it is not a claim that the timeout's original cause
has been fully proven.

There were no Web production-source changes between the F80 baseline and this
P36 fixture integration. Before the fixture adjustment, the unauthenticated
case passed in isolation and the session test file passed 6/6; an eight-file
related Web combination also passed 68/68. Thus the reported full-check timeout
was not reproduced by those earlier targeted runs.

Inspection found that the old fake returned an immediate 401 for every
non-`/projects` request. A route transition could therefore let an unrelated
view request trigger the global gate before the intended tree request. The
test fixture now returns ordinary responses for unrelated views, holds a
single 401 promise for `/views/responsibility-tree`, waits for that exact
request, and resolves the 401 inside `act`. The test still asserts that the
unauthenticated gate appears, Workbench content is absent, the tree request is
a POST carrying the expected test bearer, and re-login returns to the Login
form. No product source or timeout was changed.

On the source tree at `d834965`, the single 401 case passed 1/1, the session
file passed 6/6, the eight-file related combination passed 68/68, and full Web
Vitest passed 33 files / 235 tests. After selective cherry-pick to the P36
integration tree, session Vitest again passed 6/6 and full Web Vitest passed
33 files / 235 tests. These Web-unit results do not replace the root full
check or prove the cause of its earlier timeout.

## Failure diagnostics and token handling

When the unauthenticated-gate assertion fails, the test now includes the DOM
snapshot, requested path/method, whether the expected authorization header was
present, and whether the controlled tree response was pending or resolved.
The follow-up commit `066d363` redacts token-labelled input values, bearer
strings, and the current `tok_...` token pattern. The network diagnostic never
prints the Authorization value.

The diagnostic still serializes the DOM structure. If future UI fixtures use a
different token format or render credentials outside a token-labelled input,
extend the redaction before adding such a credential; safe-details rendered in
the DOM also merit review if their contract changes.

## Verification at the integrated tree

- `pnpm --filter @arbor/web typecheck`: PASS after building workspace package
  declarations with `pnpm build` in the fresh worktree.
- `pnpm exec biome check apps/web/test/session.test.tsx`: PASS.
- `pnpm --filter @arbor/web test -- test/session.test.tsx`: 1 file / 6 tests
  PASS.
- `pnpm --filter @arbor/web test`: 33 files / 235 tests PASS, once on the
  selective integrated version and again after the diagnostic-redaction
  follow-up.
- `git diff --check`: PASS.

No root `pnpm check`, full `test:functional`, or Playwright run was performed
for this follow-up. The source/integration Web pass is evidence for the Web
suite only. Whether this fixture change eliminates the first full-check
timeout remains unproven until an independently reviewed frozen HEAD is used
for the final gate.
