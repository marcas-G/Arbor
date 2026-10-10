# F21/F23 integration legacy fixture migration

Status: P1 and P6 fixture migrations pass. P11 factory-only exact receipt
replay is intentionally left RED because no registered F23 decoder exists for
that internal command type; no production or design change was made.

## Scope

Worktree: `C:\Users\ThinkPad\.codex\worktrees\f23-internal-validation\Arbor`

Changed tests:

- `tests/p1-idempotency.test.ts`
- `packages/application/test/p1-gateway.test.ts`
- `tests/p6-acceptance.test.ts`

`tests/p11-worktree.test.ts` remains unchanged. No production code,
`docs/design/**`, Web code, or other test files changed.

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

## P11 factory-only replay remains open

`CreateWorktree` / `RetireWorktree` are P11 factory-only/internal handlers,
not members of the current production Handler registry or F23's 26-command
registered decoder map. The test-local Gateway registry can commit the first
`CreateWorktree` receipt, but an exact same-CommandId replay fails closed as
`PersistenceCorruption<CommandStore>` because there is no trusted
`(CommandType, schemaVersion)` result decoder. The original P11 Worktree
creation/uniqueness and idempotency assertion is preserved; it was not changed
to expect success without evidence, skipped, or replaced with F21 Profile / a
FileTree address. Decoder support/registration is outside this test-only
scope, so P11 exact replay is not claimed qualified.

Focused evidence:

- Before migration: `pnpm exec vitest run tests/p1-idempotency.test.ts packages/application/test/p1-gateway.test.ts tests/p6-acceptance.test.ts`
  — 3 files, 10 failed as described.
- P11 representative RED:
  `pnpm exec vitest run tests/p11-worktree.test.ts -t "duplicate worktreeId"`
  — selected same-ID replay failed with the strict decoder corruption; five
  other cases were filtered/skipped.
- After migration: the P1/P6 command above — 3 files, 31/31 PASS.
- `pnpm typecheck` — PASS.
- Targeted Biome on the three changed test files — PASS.
- `git diff --check` — PASS.
- Full `pnpm check` and functional suites were not run.
