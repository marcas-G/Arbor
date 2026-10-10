# F21/F23 integration legacy fixture migration

Status: P1/P6 fixture migrations and the P11 factory-only fail-closed replay
case pass. Production same-ID replay support for unregistered factory-only P11
commands remains OPEN; no production or design change was made.

## Scope

Worktree: `C:\Users\ThinkPad\.codex\worktrees\f23-internal-validation\Arbor`

Changed tests:

- `tests/p1-idempotency.test.ts`
- `packages/application/test/p1-gateway.test.ts`
- `tests/p6-acceptance.test.ts`
- `tests/p11-worktree.test.ts`

No production code, `docs/design/**`, Web code, or other test files changed.

## RED evidence and fixture decisions

The original P1/P6 setup was reproduced in one targeted command: 3 files,
10 failures (P1 idempotency 3, P1 Gateway 2, P6 acceptance 5). Synthetic
`TestCommand` receipts failed exact replay with
`PersistenceCorruption<CommandStore>` because that command type has no
registered F23 result decoder. P6's legacy raw `resourceBoundary` payload had
no v2 `resourceSelection`; CreateProject v2 reached `undefined._tag`.

- P1 receipt-replay fixtures now use registered `CreateProject` schema v2
  and its exact current result DTO (`projectId`, `rootWorkspaceId`,
  `primarySessionId`). The tuple-ordering corruption test retains the same
  schema and mismatches only the fingerprint, so it continues to exercise
  tuple-before-decode precedence. Non-persisted fingerprint-algorithm coverage
  may still label its opaque input `TestCommand`.
- P1 Gateway fencing and closed-project cases use a valid
  `SubmitHumanMessage` v1 payload/result. This preserves their OpenRequired
  fence/lifecycle purpose; using `CreateProject` would switch the case to its
  Bootstrap admission semantics. The test handler and authority fixture use
  the corresponding SubmitHumanMessage authority tag.
- P6 root setup selects a test-only trusted Profile whose canonical FileTree is
  `realpathSync("tests")`. Seeded child Workspaces carry that same FileTree
  boundary. The existing `outside/parent/boundary` grandchild proposal still
  escapes this real parent capability and remains rejected. P6 therefore
  retains its file-capability ceiling semantics rather than substituting an
  empty ConversationOnly boundary.

## P11 factory-only exact-replay disposition

`CreateWorktree` / `RetireWorktree` are P11 factory-only/internal handlers,
not members of the current production Handler registry or F23's 26-command
registered decoder map. The test-local Gateway registry can commit the first
`CreateWorktree` receipt, but an exact same-CommandId replay fails closed as
`PersistenceCorruption<CommandStore>` because there is no trusted
`(CommandType, schemaVersion)` result decoder. The test now asserts that exact
fail-closed result, byte-stable stored receipt, one Active Worktree and one
`WorktreeCreated` event; a different CommandId still receives the original
typed `WorktreeAlreadyExists` rejection. No second Worktree effect occurs.
The former test-local successful replay claim is not carried forward as
production qualification: P11 factory registration plus decoder support is
outside this test-only scope. No generic fallback is added, and the P11 command
is not replaced with F21 Profile/FileTree behavior.

Focused evidence:

- Before migration: `pnpm exec vitest run tests/p1-idempotency.test.ts packages/application/test/p1-gateway.test.ts tests/p6-acceptance.test.ts`
  — 3 files, 10 failed as described.
- P11 representative RED before migration:
  `pnpm exec vitest run tests/p11-worktree.test.ts -t "duplicate worktreeId"`
  — selected same-ID replay failed with the strict decoder corruption; five
  other cases were filtered/skipped.
- P11 after migration: the same selected case — 1/1 PASS, with five unrelated
  cases filtered/skipped.
- After migration: P1/P1 Gateway/P6/P11 targeted files — 4 files, 37/37 PASS.
- `pnpm typecheck` — PASS.
- Targeted Biome on the four changed test files — PASS.
- `git diff --check` — PASS.
- Full `pnpm check` and functional suites were not run.
