# F21 Wave C — Web Project Resource Selection

Date: 2026-10-10

Worktree: `C:\Users\ThinkPad\.codex\worktrees\f23-runtime-codec\Arbor`

Wave B backend prerequisite: `c2f853d43cfebfcaad56bb30d68d007f50906507`.
The shared v2 test/fixture migration prerequisite is in the preceding fixture
commits (including `0feb21b` and `5b9ed0b`).

## Implementation

- Added authenticated same-origin `GET /project-resources` consumption to
  Web's transport face. It sends Bearer credentials when present (and permits
  the existing no-token loopback desktop mode), validates the catalog DTO,
  and copies only `resourceProfileRef`, `version`, `displayName`, and
  `available`; unknown fields such as a path are discarded before reaching
  component state.
- `CreateProjectForm` now waits for the catalog before enabling submission.
  With exactly one available Profile it preselects and visibly names that
  Profile; identifiers remain internal and the host path is never rendered.
  With zero available Profiles it leaves the choice empty, explains that
  ConversationOnly cannot use file tools or complete file-evidence Work, and
  requires an explicit “仅对话” choice. Unavailable entries render disabled
  and are not selected or silently converted. Multiple available Profiles
  require an explicit selection.
- The form serializes only the closed
  `Profile(ref,version) | ConversationOnly` selector. No resourceBoundary,
  absolute path, GitWorktree, or Profile-derived address is sent. A catalog
  fetch error blocks creation rather than defaulting to ConversationOnly.
  Transport retry keeps the selected resource and command ID; a terminal
  `ProjectResourceUnavailable` rejection gets a stable, path/ref-free message
  and a catalog refresh action.
- The former pending F21 browser flow is now in the default
  `tests/functional/ui` Playwright tree. The existing conversation-only
  browser scenario explicitly selects ConversationOnly. The F21 browser test
  verifies host Profile preselection, FileTree proof read, Verification PASS,
  Acceptance, and public rejection of forged refs/raw paths without creating
  a Project.

## Evidence

RED: before the form work, three new CreateProjectForm tests failed because
there was no Profile radio, no explicit ConversationOnly selection, and no
disabled unavailable entry/rejection presentation.

GREEN:

- `pnpm --filter @arbor/web exec vitest run test/command-forms.test.tsx` —
  20/20 passed.
- `pnpm --filter @arbor/web test` — 31 files / 228 tests passed.
- `pnpm --filter @arbor/web typecheck` passed; `pnpm --filter @arbor/web build`
  passed (with Vite's existing large-chunk advisory).
- `pnpm exec tsc -p tsconfig.test.json --noEmit` passed.
- Targeted Biome passed for the six owned Web/UI/browser source/test files;
  `git diff --check` passed.
- `pnpm exec playwright test tests/functional/ui/f21-project-resource.spec.ts tests/functional/ui/project-conversation.spec.ts --config playwright.functional.config.ts` — 3/3 passed, including the real daemon/public HTTP Profile journey, pure-conversation journey, and forged-ref/free-path negatives.

An earlier Web-test command was accidentally run in `C:\Arbor` against its
older checkout (15/15); it is explicitly not counted as Wave C evidence. All
Wave C results above were run from this isolated worktree. The complete
`pnpm test:functional` release suite was not run.

## Boundary / remaining work

The F21 browser test now resides under the default Playwright test directory,
but this targeted run is not a full release-validation claim. FT-DG-01 OPEN-1
Profile-source audit, OPEN-2 old v1 same-ID successful replay, and OPEN-3
durable post-commit Attention remain open. No backend, shared fixture,
production fixture, design document, database schema, EventVersion, or
GitWorktree lifecycle changes were made in this Wave C commit.
